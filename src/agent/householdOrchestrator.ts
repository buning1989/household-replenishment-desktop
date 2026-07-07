/**
 * AgentOrchestrator 实现：把 quick answer / local parser / clarification / batch
 * 全部收敛为内部能力，对外只输出 AgentTurn。
 *
 * 本文件是纯逻辑（除 LLM 调用由调用方在外层处理），可被测试直接覆盖。
 */

import { buildLocalClarification, buildLocalDraftFromText, parseAgentResponse, reviseAgentDraft, type AgentClarification, type AgentDraft } from "./drafts"
import { classifyAgentIntent, classifyBatchIntent, type BatchLocalIntent } from "./intent"
import {
  composeClarificationMessage,
  composeFallbackMessage,
  composeCollectionGuidance,
  composePendingReminder,
  composeProposalMessage,
  composeRevisedMessage,
  composeBatchIntro,
  composeBatchRevisedMessage,
  composeCancelledMessage,
  composeBoundaryAnswer
} from "./responseComposer"
import { classifyConversationBoundary } from "./conversationBoundary"
import type { InferenceItemView } from "./recordInference"
import { buildAgentPlan, composePlanMessage, type BuildAgentPlanResult } from "./planner"
import type { AgentPlan } from "./actions"
import type {
  AgentOrchestrator,
  AgentPlanCommand,
  AgentTurn,
  OrchestrateDecision,
  OrchestrateInput
} from "./orchestrator"

/** 构造一个 AgentOrchestrator 实例。无状态，可单例使用。 */
export function createHouseholdOrchestrator(): AgentOrchestrator {
  return {
    decide(input) {
      return decideSync(input)
    },
    normalizeLlmResponse(content, input) {
      return normalizeLlm(content, input)
    }
  }
}

/** 同步决策：本地能处理就返回 sync turn，否则返回 needLlm。 */
function decideSync(input: OrchestrateInput): OrchestrateDecision {
  const { text, state, itemViews, pendingDraft, pendingBatch, pendingPlan, dateContext } = input

  // 1. pending plan 优先（多动作计划状态机：confirm / cancel / revise / status）
  if (pendingPlan && pendingPlan.status === "pending") {
    const planTurn = handlePendingPlanIntent(text, pendingPlan, state, itemViews, dateContext)
    if (planTurn) return { kind: "sync", turn: planTurn }
    // planTurn === null 表示本轮不是针对 pendingPlan 的 confirm/cancel/revise/status
    // 落到下面：可能是新操作请求（生成新 plan，旧 plan 标 superseded）或查询/闲聊
  }

  // 2. pending batch（订单导入后的批量修正）
  if (pendingBatch && pendingBatch.length > 0) {
    const batchTurn = handleBatchIntent(text, pendingBatch, state)
    if (batchTurn) return { kind: "sync", turn: batchTurn }
    // 批量意图没命中，落到下面单草稿/查询/LLM 流程
  }

  // 3. pending proposal（旧 AgentDraft 状态机）：confirm / cancel / revise / pendingStatus
  if (pendingDraft) {
    const intent = classifyAgentIntent(text, true)
    if (intent === "confirmDraft") {
      // 调用方需要执行 commitAgentDraft 后构造 committed turn
      // orchestrator 不直接写 state，只标记需要 commit
      return { kind: "sync", turn: { kind: "proposal", message: composeProposalMessage(pendingDraft), executableDraft: pendingDraft, status: "pending" } }
    }
    if (intent === "cancelDraft") {
      return { kind: "sync", turn: { kind: "cancelled", message: composeCancelledMessage() } }
    }
    if (intent === "pendingStatus") {
      return { kind: "sync", turn: { kind: "answer", message: composePendingReminder(pendingDraft) } }
    }
    if (intent === "reviseDraft") {
      const revised = reviseAgentDraft(pendingDraft, text, state)
      if (revised) {
        return {
          kind: "sync",
          turn: { kind: "proposal", message: composeRevisedMessage(), executableDraft: revised, status: "pending" }
        }
      }
      // 修订失败：回退到 pending reminder
      return { kind: "sync", turn: { kind: "answer", message: composePendingReminder(pendingDraft) } }
    }
  }

  // 4. writeDraft 意图：
  //    4a. 先检查重复创建/歧义（clarification）
  //    4b. 用 planner 检查 AgentPlan-only 句式（建分类、设预算、改周期）
  //    4c. 回退到旧 AgentDraft 流程（restock / createItem / addPurchaseOption）
  //    4d. 都没命中 → 交给 LLM
  //
  //    设计原则：AgentDraft 和 AgentPlan 并存。
  //    - 单条草稿场景（restock/createItem）继续走旧 proposal 流程，保持 confirm/cancel/revise 不变
  //    - 新能力（createCategory/setMonthlyBudget/updateItem）和多动作组合走 planProposal
  const intent = classifyAgentIntent(text, Boolean(pendingDraft || pendingPlan))
  if (intent === "writeDraft") {
    // 4a. 先检查重复创建/歧义
    const clarification = buildLocalClarification(text, state)
    if (clarification) {
      return { kind: "sync", turn: clarifyToTurn(clarification) }
    }
    // 4b. 用 planner 检查 AgentPlan-only 句式（建分类、设预算、改消耗品周期 + 第二期编辑类）
    //     只对 AgentDraft 无法处理的新能力生成 planProposal，避免破坏旧 confirm/cancel/revise 流程
    const planResult = buildAgentPlan({ text, state, dateContext, pendingPlan: undefined })
    if (planResult.kind === "plan") {
      const plan = planResult.plan
      // 判断是否是 AgentPlan-only 能力：
      //   第一期：createCategory / setMonthlyBudget / updateItem
      //   第二期：renameCategory / moveItem / updateItemUnit / updateItemReminder /
      //           updatePurchaseOption / setDefaultPurchaseOption
      const isPlanOnly = plan.actions.some(
        (a) => a.type === "createCategory"
          || a.type === "setMonthlyBudget"
          || a.type === "updateItem"
          || a.type === "renameCategory"
          || a.type === "moveItem"
          || a.type === "updateItemUnit"
          || a.type === "updateItemReminder"
          || a.type === "updatePurchaseOption"
          || a.type === "setDefaultPurchaseOption"
      )
      if (isPlanOnly) {
        return {
          kind: "sync",
          turn: { kind: "planProposal", message: composePlanMessage(plan, state), plan }
        }
      }
      // 非 plan-only（如「买了两袋猫砂」）：回退到旧 AgentDraft 流程，保持 confirm 链路不变
    }
    if (planResult.kind === "clarification") {
      // planner 的 clarification 是本地兜底，目前不会产出可点选选项
      return { kind: "sync", turn: { kind: "clarification", message: planResult.message, options: [] } }
    }
    // 4c. 回退到旧 AgentDraft 流程
    const localDraft = buildLocalDraftFromText(text, state)
    if (localDraft) {
      return { kind: "sync", turn: draftToProposal(localDraft, state, itemViews) }
    }
    // 4d. 本地解析失败 → 交给 LLM
    return { kind: "needLlm", reason: "writeDraft but local parser failed" }
  }

  // 5. 查询意图与其他无法本地处理的输入：
  //    先用对话边界分类判定 identity/realtime/casual，命中则直接返回 sync answer，不必调 LLM。
  //    adjacentHomeLife 仍交 LLM（LLM 失败时由 App.tsx 用 composeBoundaryAnswer 兜底）。
  //    其他无法归类的交 LLM 尝试回答。
  const boundary = classifyConversationBoundary(text)
  if (boundary === "identityOrMeta" || boundary === "realtimeExternal" || boundary === "casual") {
    return {
      kind: "sync",
      turn: { kind: "answer", message: composeBoundaryAnswer(boundary, text) }
    }
  }
  if (boundary === "adjacentHomeLife") {
    return { kind: "needLlm", reason: "adjacent home life question" }
  }
  return { kind: "needLlm", reason: "query intent or unmatched input" }
}

/**
 * 处理 pendingPlan 的用户输入。
 * 返回 null 表示本轮不是针对 pendingPlan 的意图（可能是新操作或查询），由外层继续判断。
 */
function handlePendingPlanIntent(
  text: string,
  pendingPlan: AgentPlan,
  state: import("../types").AppState,
  _itemViews: InferenceItemView[],
  _dateContext: import("../llm/householdChat").ChatDateContext
): AgentTurn | null {
  const intent = classifyAgentIntent(text, true)

  // 1. 确认 → 返回 planConfirm command，调用方执行 commitAgentPlan
  if (intent === "confirmDraft") {
    return {
      kind: "planCommand" as const,
      message: composePlanMessage(pendingPlan, state),
      command: { command: "planConfirm" as const }
    }
  }

  // 2. 取消 → 返回 planCancel command
  if (intent === "cancelDraft") {
    return {
      kind: "planCommand" as const,
      message: composeCancelledMessage(),
      command: { command: "planCancel" as const }
    }
  }

  // 3. 询问状态 → answer（提示还没写入）
  if (intent === "pendingStatus") {
    const lines = pendingPlan.actions.map((action, index) => `${index + 1}. ${shortActionHint(action)}`)
    return {
      kind: "answer" as const,
      message: `还没真正写入，需要你确认一下。\n当前准备处理：\n${lines.join("\n")}\n你可以点卡片里的「确认执行」，或直接输入「确认吧」。`
    }
  }

  // 4. 修订 → 用 planner 的 tryRevisePendingPlan 生成新 planProposal
  if (intent === "reviseDraft") {
    const reviseResult = buildAgentPlan({ text, state, dateContext: _dateContext, pendingPlan })
    if (reviseResult.kind === "plan") {
      return {
        kind: "planProposal" as const,
        message: `${composeRevisedMessage()}\n${composePlanMessage(reviseResult.plan, state)}`,
        plan: reviseResult.plan
      }
    }
    // 修订失败：回退到 pending reminder
    return {
      kind: "answer" as const,
      message: `还没真正写入，需要你确认一下。你可以点卡片里的「确认执行」，或直接输入「确认吧」。`
    }
  }

  // 5. 不是 confirm/cancel/revise/status：返回 null 让外层继续判断
  //    可能是查询（如「猫砂还剩多少」）或新操作请求（如「再加一个豆腐猫砂」）
  return null
}

/** pendingStatus 提示里每条动作的简短描述（不复用 summarizeActionLocal，避免长文案）。 */
function shortActionHint(action: import("./actions").AgentAction): string {
  switch (action.type) {
    case "createCategory": return `新建分类「${action.name}」`
    case "createItem": return `添加消耗品「${action.name}」`
    case "updateItem": return `修改「${action.itemName || action.itemId}」`
    case "addPurchaseOption": return `常购商品「${action.productName}」`
    case "recordRestock": return `记补货「${action.itemName}」`
    case "updateRestockRecord": return `改补货记录`
    case "setMonthlyBudget": return `设预算 ¥${action.amount}`
    case "renameCategory": return `重命名分类「${action.oldName}」→「${action.newName}」`
    case "moveItem": return `移动「${action.itemName || action.itemId}」到「${action.targetCategory}」`
    case "updateItemUnit": return `改单位「${action.itemName || action.itemId}」→${action.unit}`
    case "updateItemReminder": return `改提醒「${action.itemName || action.itemId}」提前${action.bufferDays}天`
    case "updatePurchaseOption": return `改常购商品「${action.productName || action.optionId}」`
    case "setDefaultPurchaseOption": return `设默认「${action.productName || action.optionId}」`
    default: return "（未实现）"
  }
}

/** 把 AgentClarification 转成 AgentTurnClarification。 */
function clarifyToTurn(clarification: AgentClarification): AgentTurn {
  // 复用 composer 生成 message，但如果 clarification 自带 question（来自 LLM）也接受
  const message = clarification.question
  return {
    kind: "clarification",
    message,
    options: clarification.options,
    provisional: clarification.provisional
  }
}

/** 把 AgentDraft 转成 AgentTurnProposal。
 *  草稿首次产出时，若 price/platform 缺失，调用 composeCollectionGuidance
 *  基于历史价格/常识给参考判断，而不是机械追问「多少钱」。
 *  revise/confirm 路径不走这里，保证不重复采集。
 */
function draftToProposal(draft: AgentDraft, state: import("../types").AppState, itemViews: InferenceItemView[]): AgentTurn {
  const baseMessage = composeProposalMessage(draft)
  const guidance = composeCollectionGuidance(draft, state, itemViews)
  const message = guidance ? `${baseMessage} ${guidance}` : baseMessage
  return {
    kind: "proposal",
    message,
    executableDraft: draft,
    status: "pending"
  }
}

/** 处理批量意图（订单导入）。返回 null 表示不是批量意图。
 *  使用 typed command 替代旧的 __BATCH_CONFIRM__ 等魔法字符串，
 *  调用方读取 command 字段后分发到 confirmBatch / cancelBatch / reviseBatchIndex 等处理函数。 */
function handleBatchIntent(text: string, pendingBatch: AgentDraft[], _state: import("../types").AppState): AgentTurn | null {
  const batchIntent = classifyBatchIntent(text)
  if (!batchIntent) return null

  // 批量意图由调用方在 App.tsx 处理（因为涉及 batchDraftStatuses 数组操作）
  // orchestrator 只返回 typed command，不直接执行写入
  if (batchIntent.intent === "batchConfirm") {
    // typed command：调用方读取 command 字段后执行 confirmBatch
    return { kind: "planCommand", message: "", command: { command: "batchConfirm" } }
  }
  if (batchIntent.intent === "batchCancel") {
    return { kind: "planCommand", message: "", command: { command: "batchCancel" } }
  }
  if (batchIntent.intent === "batchCancelIndex") {
    return { kind: "planCommand", message: "", command: { command: "batchCancelIndex", index: batchIntent.index } }
  }
  if (batchIntent.intent === "batchReviseIndex") {
    return { kind: "planCommand", message: "", command: { command: "batchReviseIndex", index: batchIntent.index } }
  }
  if (batchIntent.intent === "batchReviseAll") {
    return { kind: "planCommand", message: "", command: { command: "batchReviseAll" } }
  }
  return null
}

/**
 * 把 LLM 返回的原始内容规范化为 AgentTurn。
 * LLM 输出经过 parseAgentResponse 后，再由 composer 重新生成文案，
 * 不直接采用 LLM 的 message 字段。
 */
function normalizeLlm(content: string, input: OrchestrateInput): AgentTurn | null {
  const parsed = parseAgentResponse(content, input.state)
  if (!parsed) return null

  if (parsed.kind === "queryAnswer") {
    return { kind: "answer", message: parsed.answer }
  }
  if (parsed.kind === "clarification") {
    return {
      kind: "clarification",
      // LLM 的 question 可以采用，但走 composer 校验是否包含禁用词
      message: parsed.clarification.question,
      options: parsed.clarification.options,
      provisional: parsed.clarification.provisional
    }
  }
  if (parsed.kind === "draft") {
    // 关键：不直接采用 LLM 的 message，由 composer 重新生成
    // 这样保证 LLM 即使文案漂移，最终用户看到的仍是统一管家口吻
    return draftToProposal(parsed.draft, input.state, input.itemViews)
  }
  return null
}

/**
 * 工具：从 AgentTurn 读取 typed command（替代旧的魔法字符串标记）。
 *
 * - 如果 turn.kind === "planCommand"，返回对应的 BatchLocalIntent 或 planConfirm/planCancel 信号
 * - 否则返回 null
 *
 * App.tsx 应优先使用此函数读取批量/plan 意图信号，而不是检查 message 字符串。
 */
export function readTurnCommand(turn: AgentTurn): AgentPlanCommand | null {
  if (turn.kind !== "planCommand") return null
  return turn.command
}

/**
 * 工具：从 turn 提取 BatchLocalIntent（向后兼容旧 isBatchIntentMarker 调用方）。
 * 优先读取 typed command；找不到时返回 null。
 */
export function isBatchIntentMarker(turn: AgentTurn): BatchLocalIntent | null {
  if (turn.kind !== "planCommand") return null
  const cmd = turn.command
  if (cmd.command === "batchConfirm") return { intent: "batchConfirm" }
  if (cmd.command === "batchCancel") return { intent: "batchCancel" }
  if (cmd.command === "batchCancelIndex") return { intent: "batchCancelIndex", index: cmd.index }
  if (cmd.command === "batchReviseIndex") return { intent: "batchReviseIndex", index: cmd.index }
  if (cmd.command === "batchReviseAll") return { intent: "batchReviseAll" }
  return null
}

/** 工具：构造 batch intro turn（订单导入确认后调用） */
export function buildBatchIntroTurn(drafts: AgentDraft[]): AgentTurn {
  return { kind: "answer", message: composeBatchIntro(drafts.length) }
}

/** 工具：构造 batch revised turn */
export function buildBatchRevisedTurn(scope: "single" | "all"): AgentTurn {
  return { kind: "answer", message: composeBatchRevisedMessage(scope) }
}

/** 工具：构造 fallback turn（LLM 失败或解析失败时） */
export function buildFallbackTurn(scenario: "no-draft" | "no-answer"): AgentTurn {
  return { kind: "answer", message: composeFallbackMessage(scenario) }
}
