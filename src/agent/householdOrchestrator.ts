/**
 * AgentOrchestrator 实现：把 quick answer / local parser / clarification / batch
 * 全部收敛为内部能力，对外只输出 AgentTurn。
 *
 * 本文件是纯逻辑（除 LLM 调用由调用方在外层处理），可被测试直接覆盖。
 */

import { buildLocalClarification, buildLocalDraftFromText, parseAgentResponse, reviseAgentDraft, type AgentClarification, type AgentDraft } from "./drafts"
import {
  createDraftCollection,
  reviseDraftCollection,
  shouldEnterCollection,
  hasMissingQuality,
  type DraftCollection
} from "./draftCollection"
import { classifyAgentIntent, classifyBatchIntent, isSecondConfirmMatch, type BatchLocalIntent } from "./intent"
import { interpretUserTurn, type TurnInterpretation } from "./turnInterpretation"
import { resolveConversationFocus } from "./focusResolver"
import { askTurnInterpreterLlm, type TurnInterpreterLlmClient } from "./turnInterpreterLlm"
import {
  composeClarificationMessage,
  composeFallbackMessage,
  composeCollectionGuidance,
  composeCollectionMessage,
  composeCollectionCancelledMessage,
  composeReadyToConfirmMessage,
  composePendingReminder,
  composeProposalMessage,
  composeRevisedMessage,
  composeBatchIntro,
  composeBatchRevisedMessage,
  composeCancelledMessage,
  composeBoundaryAnswer
} from "./responseComposer"
import { classifyConversationBoundary } from "./conversationBoundary"
import { buildRecordSuggestions, type InferenceItemView } from "./recordInference"
import { buildRecordInsights, composeInsightLine } from "./recordInsight"
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
    },
    async interpretAndRoute(input, clientOverride) {
      return interpretAndRouteSync(input, clientOverride)
    }
  }
}

/** 同步决策：本地能处理就返回 sync turn，否则返回 needLlm。 */
function decideSync(input: OrchestrateInput): OrchestrateDecision {
  const { text, state, itemViews, pendingDraft, pendingCollection, pendingBatch, pendingPlan, dateContext } = input

  // 1. pending plan 优先（多动作计划状态机：confirm / cancel / revise / status）
  //    第三期：high risk plan 有 awaitingSecondConfirm 状态，需要二次「确认删除」
  if (pendingPlan && (pendingPlan.status === "pending" || pendingPlan.status === "awaitingSecondConfirm")) {
    const planTurn = handlePendingPlanIntent(text, pendingPlan, state, itemViews, dateContext)
    if (planTurn) return { kind: "sync", turn: planTurn }
    // planTurn === null 表示本轮不是针对 pendingPlan 的 confirm/cancel/revise/status
    // 落到下面：可能是新操作请求（生成新 plan，旧 plan 标 superseded）或查询/闲聊
  }

  // 2. pending collection（补货记录采集态）：补充字段 / 取消 / 直接保存 / 转 proposal
  //    collection 是 proposal 的前驱态：字段未齐时先整理，齐了再转 proposal 走 confirm 链路
  //
  //    阶段 2B：先用 turnInterpretation + focusResolver 判断本轮应如何对待当前 collection。
  //    关键修复：当用户在旧物品采集态中输入「今天买了 3 袋五常大米」这类完整新补货句
  //    （物品名与当前 collection 不同），不再把旧物品的数量/单位覆盖成新输入，而是开启新采集，
  //    旧 collection 由 App.tsx 的 collection turn 处理逻辑自动标 superseded。
  if (pendingCollection) {
    const collectionDecision = handleCollectionFocusDecision(input)
    if (collectionDecision) return collectionDecision
    // collectionDecision === null 表示本轮不打断当前采集态、也不写入新任务，
    // 也不走 query/LLM（如 route_to_smalltalk 已在此返回）。落到下面继续 batch/draft/query 流程。
    // 通常不会落到这里：handleCollectionFocusDecision 已覆盖所有 focus 分支。
  }

  // 3. pending batch（订单导入后的批量修正）
  if (pendingBatch && pendingBatch.length > 0) {
    const batchTurn = handleBatchIntent(text, pendingBatch, state)
    if (batchTurn) return { kind: "sync", turn: batchTurn }
    // 批量意图没命中，落到下面单草稿/查询/LLM 流程
  }

  // 4. pending proposal（旧 AgentDraft 状态机）：confirm / cancel / revise / pendingStatus
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
  // 注意：hasPendingDraft 只传 pendingDraft，不传 pendingPlan。
  //   handlePendingPlanIntent 已经在上面处理了 plan 的 confirm/cancel/revise/status。
  //   走到这里说明本轮不是针对 pendingPlan 的这些意图。
  //   如果传 pendingPlan，"帮我加一袋猫砂" 会因"袋"在 REVISE_KEYWORDS 中被误判为 reviseDraft，
  //   导致新写入请求走 needLlm 而非 writeDraft。
  const intent = classifyAgentIntent(text, Boolean(pendingDraft))
  if (intent === "writeDraft") {
    const writeDraftDecision = handleWriteDraftIntent(input)
    if (writeDraftDecision) return writeDraftDecision
    // writeDraftDecision === null 表示本地解析失败（原 4d），落到下面 boundary / LLM
  }

  return handleBoundaryOrLlmFallback(text)
}

/**
 * 处理 writeDraft 意图：检查重复创建/歧义 → planner → 旧 AgentDraft 流程。
 * 返回 null 表示本地解析失败（原 4d），由调用方走 boundary / LLM 兜底。
 *
 * 本函数也用于 pendingCollection 分支的 start_new_collection：直接走 writeDraft 流程
 * 生成新 collection/proposal，旧 collection 由 App.tsx 的 collection turn 处理逻辑标 superseded。
 */
function handleWriteDraftIntent(input: OrchestrateInput): OrchestrateDecision | null {
  const { text, state, itemViews, dateContext } = input
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
    //   第三期：deletePurchaseOption / deleteRestockRecord / deleteItem / deleteCategory
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
        || a.type === "deletePurchaseOption"
        || a.type === "deleteRestockRecord"
        || a.type === "deleteItem"
        || a.type === "deleteCategory"
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
    // 补货类草稿字段未齐时，先进采集态（DraftCollection），
    // 用自然语言基于历史/常识帮用户整理，而不是立刻甩确认卡或机械追问「多少钱」。
    // 字段已齐（readyToConfirm）或用户明确要求保存时，仍直接走 proposal。
    if (shouldEnterCollection(localDraft, text)) {
      return { kind: "sync", turn: draftToCollection(localDraft, state, itemViews, dateContext) }
    }
    return { kind: "sync", turn: draftToProposal(localDraft, state, itemViews) }
  }
  // 4d. 本地解析失败 → 返回 null，由调用方走 boundary / LLM 兜底
  return null
}

/**
 * 对话边界与 LLM 兜底（原 decideSync 末段）。
 * identity/realtime/casual → 本地 sync answer；adjacentHomeLife 与其他 → needLlm。
 */
function handleBoundaryOrLlmFallback(text: string): OrchestrateDecision {
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
 * 阶段 2B：pendingCollection 分支接入 turnInterpretation + focusResolver。
 *
 * 根据本轮 interpretation 与当前 pending 上下文，决定：
 *   - continue_pending_collection / correct_pending_collection → 旧 handlePendingCollectionIntent
 *   - start_new_collection → 直接走 writeDraft 流程（生成新 collection/proposal）
 *   - route_to_query → 不修改当前 collection，落回 decideSync 的 query/boundary/LLM 路径
 *   - route_to_smalltalk → 本地 sync answer（边界闲聊）
 *   - route_to_llm → needLlm
 *
 * 返回 null 表示交回 decideSync 后续流程处理（实际上各 focus 分支都已覆盖）。
 */
function handleCollectionFocusDecision(input: OrchestrateInput): OrchestrateDecision | null {
  const { text, state, itemViews, dateContext, pendingCollection, pendingPlan, pendingDraft, pendingBatch } = input
  if (!pendingCollection) return null

  const interpretation = interpretUserTurn({ text, state, itemViews, dateContext })
  const focus = resolveConversationFocus({
    interpretation,
    pendingCollection,
    pendingPlan,
    pendingDraft,
    pendingBatch
  })

  switch (focus.focus) {
    case "continue_pending_collection":
    case "correct_pending_collection": {
      const collectionTurn = handlePendingCollectionIntent(text, pendingCollection, state, itemViews, dateContext)
      if (collectionTurn) return { kind: "sync", turn: collectionTurn }
      // handlePendingCollectionIntent 返回 null（noChange）：落到后续流程
      return null
    }

    case "start_new_collection": {
      // 直接走 writeDraft 流程：clarification → planner → 旧 AgentDraft → collection/proposal
      // 旧 collection 由 App.tsx 的 collection turn 处理逻辑标 superseded
      const writeDraftDecision = handleWriteDraftIntent(input)
      if (writeDraftDecision) return writeDraftDecision
      // 本地解析失败：交 LLM 兜底
      return { kind: "needLlm", reason: `start_new_collection but local parser failed: ${focus.reason}` }
    }

    case "route_to_query": {
      // 不修改当前 collection，继续走 decideSync 的 batch/draft/query/boundary 流程。
      // 但 focusResolver 可能把含评价/价格的长句误判成 query（如「这款猫砂品质不错，不起灰」
      // 命中 adjacentHomeLife 关键词），因此先尝试旧 collection 处理逻辑兜底字段抽取。
      const fallbackTurn = handlePendingCollectionIntent(text, pendingCollection, state, itemViews, dateContext)
      if (fallbackTurn) return { kind: "sync", turn: fallbackTurn }
      return null
    }

    case "route_to_smalltalk": {
      // 本地边界闲聊直接回答；查询类（adjacentHomeLife）交给 LLM。
      // 先尝试旧 collection 处理逻辑，保留原有「评价/价格」等长句字段的抽取能力
      // （focusResolver 的短句识别覆盖面比 reviseDraftCollection 窄，需兜底）。
      const fallbackTurn = handlePendingCollectionIntent(text, pendingCollection, state, itemViews, dateContext)
      if (fallbackTurn) return { kind: "sync", turn: fallbackTurn }
      const boundary = classifyConversationBoundary(text)
      if (boundary === "identityOrMeta" || boundary === "realtimeExternal" || boundary === "casual") {
        return {
          kind: "sync",
          turn: { kind: "answer", message: composeBoundaryAnswer(boundary, text) }
        }
      }
      // 非边界闲聊但 focusResolver 判定为 smalltalk（如问候）：交 LLM
      return { kind: "needLlm", reason: focus.reason }
    }

    case "route_to_llm": {
      // 先尝试旧 collection 处理逻辑，保留原有长句评价/价格字段抽取能力
      // （focusResolver 的短句识别覆盖面比 reviseDraftCollection 窄，需兜底）。
      const fallbackTurn = handlePendingCollectionIntent(text, pendingCollection, state, itemViews, dateContext)
      if (fallbackTurn) return { kind: "sync", turn: fallbackTurn }
      // 旧逻辑也抽不出字段（如「拼夕夕/pdd/上次那个平台」这类平台别名或指代）：
      // 阶段 2C 不再直接回 needLlm → 「超出家务范围」，而是交给 LLM Turn Interpreter
      // 结合当前 pendingCollection 重新做结构化理解。
      return { kind: "needTurnInterpreterLlm", reason: focus.reason }
    }

    default:
      // continue_pending_plan / continue_pending_batch / continue_pending_draft / route_to_write_draft
      // 这些分支在 pendingCollection 场景下不应出现（focusResolver 已分流），
      // 兜底交回 decideSync 后续流程处理。
      return null
  }
}

/**
 * 阶段 2C：pendingCollection 下本地低置信（route_to_llm）时，调用 LLM Turn Interpreter
 * 重新做结构化理解，再用 resolveConversationFocus 二次路由。
 *
 * 决策契约：
 *   - LLM 解释成功且高/中置信 → 复用 handlePendingCollectionIntent（用合成输入）走 collection 流程
 *   - LLM 解释失败 / 低置信 / unknown → 返回 clarification，询问是否补当前记录，
 *     禁止回复「超出家务范围」
 *   - LLM 判定为 query / smalltalk → 返回 needLlm，交常规 answer LLM 兜底
 *
 * clientOverride 供单测注入 mock；真实运行时内部构造 desktop bridge client。
 */
async function interpretAndRouteSync(
  input: OrchestrateInput,
  clientOverride?: TurnInterpreterLlmClient
): Promise<OrchestrateDecision> {
  const { text, state, itemViews, dateContext, pendingCollection, pendingPlan, pendingDraft, pendingBatch } = input
  if (!pendingCollection) {
    // 无 pendingCollection 不应进入此路径；兜底交常规 LLM
    return { kind: "needLlm", reason: "interpretAndRoute without pendingCollection" }
  }

  const llmInterpretation = await askTurnInterpreterLlm({
    text,
    pendingCollection,
    pendingDraft,
    pendingPlan,
    state,
    itemViews,
    dateContext,
    client: clientOverride
  })

  // LLM 失败 / 低置信 / unknown → clarification（不回复「超出家务范围」）
  if (!llmInterpretation) {
    return { kind: "sync", turn: composeCollectionClarificationTurn(pendingCollection) }
  }

  const focus = resolveConversationFocus({
    interpretation: llmInterpretation,
    pendingCollection,
    pendingPlan,
    pendingDraft,
    pendingBatch
  })

  switch (focus.focus) {
    case "continue_pending_collection":
    case "correct_pending_collection": {
      // 用 LLM 解释出的 fields 合成等价用户输入，复用旧 collection 处理逻辑抽取/写入字段
      const synthText = synthesizeInputFromInterpretation(llmInterpretation, pendingCollection)
      const collectionTurn = handlePendingCollectionIntent(synthText, pendingCollection, state, itemViews, dateContext)
      if (collectionTurn) return { kind: "sync", turn: collectionTurn }
      // 合成输入仍抽不出字段 → clarification
      return { kind: "sync", turn: composeCollectionClarificationTurn(pendingCollection) }
    }

    case "start_new_collection": {
      // LLM 判定为新物品补货记录（itemName 与当前 collection 不同）：走 writeDraft 流程
      const writeDraftDecision = handleWriteDraftIntent(input)
      if (writeDraftDecision) return writeDraftDecision
      return { kind: "sync", turn: composeCollectionClarificationTurn(pendingCollection) }
    }

    case "route_to_query":
      // LLM 判定为查询：不打断 collection，交常规 answer LLM 回答查询
      return { kind: "needLlm", reason: "llm interpreted as query, defer to answer llm" }

    case "route_to_smalltalk": {
      const boundary = classifyConversationBoundary(text)
      if (boundary === "identityOrMeta" || boundary === "realtimeExternal" || boundary === "casual") {
        return {
          kind: "sync",
          turn: { kind: "answer", message: composeBoundaryAnswer(boundary, text) }
        }
      }
      return { kind: "needLlm", reason: "llm interpreted as smalltalk" }
    }

    default:
      // route_to_llm / 其他：clarification 兜底
      return { kind: "sync", turn: composeCollectionClarificationTurn(pendingCollection) }
  }
}

/**
 * 把 LLM 解释出的 fields 合成等价用户输入，供 handlePendingCollectionIntent 复用旧抽取逻辑。
 * 例如 { platform: "拼多多" } → "拼多多"；{ price: 36 } → "36元"。
 */
function synthesizeInputFromInterpretation(
  interpretation: TurnInterpretation,
  collection: DraftCollection
): string {
  const f = interpretation.fields
  if (interpretation.intent === "correct_current_collection" && f.itemName) {
    const currentName = extractCollectionItemName(collection) ?? ""
    return `不是${currentName}，是${f.itemName}`
  }
  if (interpretation.intent === "confirm_current_task") return "确认"
  if (interpretation.intent === "cancel_current_task") return "算了"
  // supplement：拼接可用字段，优先 platform/price/review/quantity
  const parts: string[] = []
  if (f.platform) parts.push(f.platform)
  if (f.price !== undefined) parts.push(`${f.price}元`)
  if (f.review) parts.push(f.review)
  if (f.quantity !== undefined) parts.push(`${f.quantity}${f.unit ?? ""}`)
  if (f.date !== undefined) parts.push(String(f.date))
  return parts.length > 0 ? parts.join("，") : ""
}

/** 取当前 collection 草稿的物品名。 */
function extractCollectionItemName(collection: DraftCollection): string | undefined {
  const draft = collection.draft
  if (draft.kind === "restock") return draft.itemName
  if (draft.kind === "createItemWithRestock") return draft.item.itemName
  return undefined
}

/**
 * 构造采集态 clarification turn：询问用户是否补当前记录，禁止回复「超出家务范围」。
 */
function composeCollectionClarificationTurn(collection: DraftCollection): AgentTurn {
  const itemName = extractCollectionItemName(collection)
  const f = describeCollectionDraftForClarification(collection)
  const hints: string[] = []
  if (!f.platform) hints.push("如果是平台，可以说「拼多多」")
  if (f.price === undefined) hints.push("如果是金额，可以说「36 元」")
  const hint = hints.length > 0 ? `；${hints.join("；")}` : ""
  const message = `你是想把这个补到刚才那条「${itemName ?? "记录"}」里吗？${hint}。如果不打算记了，可以说「算了」。`
  return { kind: "clarification", message, options: [] }
}

/** 取 collection 草稿中已填字段，供 clarification 文案判断缺什么。 */
function describeCollectionDraftForClarification(collection: DraftCollection): {
  platform?: string
  price?: number
} {
  const draft = collection.draft
  if (draft.kind === "restock") return { platform: draft.platform, price: draft.price }
  if (draft.kind === "createItemWithRestock") return { platform: draft.restock.platform, price: draft.restock.price }
  return {}
}

/**
 * 处理 pendingPlan 的用户输入。
 * 返回 null 表示本轮不是针对 pendingPlan 的意图（可能是新操作或查询），由外层继续判断。
 *
 * 第三期二次确认状态机：
 *   - pendingPlan.status === "awaitingSecondConfirm"（高风险 plan 第一次确认后）：
 *     - 「确认删除」类句式 → planSecondConfirm command（调用方执行 commitAgentPlan）
 *     - 普通「确认」 → answer（提示需要说「确认删除」）
 *     - 「取消」 → planCancel command
 *     - 修订 → 新 planProposal
 *     - 查询 → 不打断（返回 null）
 *   - pendingPlan.status === "pending" + requiresSecondConfirm（高风险 plan）：
 *     - 「确认」 → planAwaitingSecondConfirm command（调用方推进状态，不执行写入）
 *     - 「取消」 → planCancel command
 *     - 修订 → 新 planProposal
 *     - 查询 → 不打断（返回 null）
 *   - pendingPlan.status === "pending" + 普通 plan：
 *     - 「确认」 → planConfirm command（调用方执行 commitAgentPlan）
 *     - 「取消」 → planCancel command
 *     - 修订 → 新 planProposal
 *     - 查询 → 不打断（返回 null）
 */
function handlePendingPlanIntent(
  text: string,
  pendingPlan: AgentPlan,
  state: import("../types").AppState,
  _itemViews: InferenceItemView[],
  _dateContext: import("../llm/householdChat").ChatDateContext
): AgentTurn | null {
  const isHighRisk = pendingPlan.requiresSecondConfirm === true || pendingPlan.risk === "high"

  // ---------- awaitingSecondConfirm 状态：只接受「确认删除」 ----------
  if (pendingPlan.status === "awaitingSecondConfirm") {
    // 1. 二次确认删除 → planSecondConfirm command
    if (isSecondConfirmMatch(text)) {
      return {
        kind: "planCommand" as const,
        message: composePlanMessage(pendingPlan, state),
        command: { command: "planSecondConfirm" as const }
      }
    }
    // 2. 取消 → planCancel command
    const cancelIntent = classifyAgentIntent(text, true)
    if (cancelIntent === "cancelDraft") {
      return {
        kind: "planCommand" as const,
        message: composeCancelledMessage(),
        command: { command: "planCancel" as const }
      }
    }
    // 3. 普通「确认」「好的」「可以」 → answer（提示需要说「确认删除」）
    if (cancelIntent === "confirmDraft") {
      return {
        kind: "answer" as const,
        message: "这是高风险删除操作，需要你明确说「确认删除」才能执行。输入「取消」可以放弃。"
      }
    }
    // 4. 询问状态 → answer
    if (cancelIntent === "pendingStatus") {
      return {
        kind: "answer" as const,
        message: "正在等待你的二次确认。这是高风险删除操作，请明确说「确认删除」执行，或「取消」放弃。"
      }
    }
    // 5. awaitingSecondConfirm 状态下不允许修订：
    //    高风险删除操作不应被"修订"，用户应先取消再重新输入。
    //    把"修订"意图（可能因 REVISE_KEYWORDS 误命中，如"帮我加一袋猫砂"中的"袋"）
    //    当作新操作，返回 null 让外层处理。
    return null
  }

  // ---------- pending 状态：第一次确认 ----------

  // 如果用户在 pending 状态直接输入「确认删除」类句式，直接执行删除。
  // 二次确认句式包含明确的删除语义，不需要再走 awaitingSecondConfirm。
  if (isHighRisk && isSecondConfirmMatch(text)) {
    return {
      kind: "planCommand" as const,
      message: composePlanMessage(pendingPlan, state),
      command: { command: "planSecondConfirm" as const }
    }
  }

  const intent = classifyAgentIntent(text, true)

  // 1. 确认
  if (intent === "confirmDraft") {
    if (isHighRisk) {
      // 高风险 plan → 进入 awaitingSecondConfirm，不执行写入
      return {
        kind: "planCommand" as const,
        message: composePlanMessage(pendingPlan, state),
        command: { command: "planAwaitingSecondConfirm" as const }
      }
    }
    // 普通 plan → 直接执行
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
    const riskHint = isHighRisk ? "注意：这是高风险删除操作，确认后还需要二次「确认删除」才能执行。\n" : ""
    return {
      kind: "answer" as const,
      message: `还没真正写入，需要你确认一下。\n当前准备处理：\n${lines.join("\n")}\n${riskHint}你可以点卡片里的「确认执行」，或直接输入「确认吧」。`
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
    case "deletePurchaseOption": return `删除常购商品「${action.productName || action.optionId}」`
    case "deleteRestockRecord": return `删除补货记录「${action.itemName}」`
    case "deleteItem": return `删除消耗品「${action.itemName}」`
    case "deleteCategory": return `删除分类「${action.categoryName}」`
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
 *
 *  fromCollection = true 时表示从采集态转来（字段已补齐或用户要求直接保存），
 *  改用 composeReadyToConfirmMessage 生成「信息够了，你确认后我再写入」的文案，
 *  并在质量字段仍缺失时附带「未补全记录」提示，不再追加采集式追问。
 */
function draftToProposal(
  draft: AgentDraft,
  state: import("../types").AppState,
  itemViews: InferenceItemView[],
  options?: {
    fromCollection?: boolean
    qualityMissing?: string[]
    dateContext?: import("../llm/householdChat").ChatDateContext
  }
): AgentTurn {
  if (options?.fromCollection) {
    const message = composeReadyToConfirmMessage(draft, options.qualityMissing || [])
    // 采集态转 proposal 且价格已填时：追加 1 条轻量判断（价格划算/偏贵）
    let insightLine = ""
    if (options.dateContext) {
      const { insights } = buildRecordInsights({
        draft,
        state,
        itemViews: itemViews as unknown as import("../llm/householdChat").HouseholdChatItemView[],
        dateContext: options.dateContext
      })
      // proposal 前只追加价格类判断（budgetImpact 等 commit 后再给更准的）
      const priceInsight = insights.find(
        (i) => i.type === "priceLowerThanUsual" || i.type === "priceHigherThanUsual"
      )
      if (priceInsight) {
        insightLine = " " + composeInsightLine([priceInsight], 1)
      }
    }
    return {
      kind: "proposal",
      message: message + insightLine,
      executableDraft: draft,
      status: "pending"
    }
  }
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

/** 把补货类草稿转成 AgentTurnCollection（采集态首次产出）。 */
function draftToCollection(
  draft: AgentDraft,
  state: import("../types").AppState,
  itemViews: InferenceItemView[],
  dateContext: import("../llm/householdChat").ChatDateContext
): AgentTurn {
  const suggestions = buildRecordSuggestions(draft, state, itemViews)
  const collection = createDraftCollection(draft, suggestions, dateContext.now)
  const message = composeCollectionMessage(collection, state, itemViews, { justFilled: null })
  return { kind: "collection", message, collection }
}

/**
 * 处理 pendingCollection 的用户输入。
 * 返回 null 表示本轮没命中 collection 信号（纯查询或新操作请求），由外层继续判断。
 *
 * 状态机：
 *   - 取消信号（算了/不记了）→ cancelled
 *   - 强制保存信号（就这样/先保存/直接记下）→ 转 proposal（带未补全标记）
 *   - 字段补充（平台/金额/评价/日期/数量）→ 更新 collection
 *     - 补完后 completeness = readyToConfirm → 转 proposal
 *     - 否则 → 继续 collection，问下一个核心问题
 *   - 输入未命中任何字段 → null（外层按查询/新操作处理，collection 仍保留）
 */
function handlePendingCollectionIntent(
  text: string,
  collection: DraftCollection,
  state: import("../types").AppState,
  itemViews: InferenceItemView[],
  dateContext: import("../llm/householdChat").ChatDateContext
): AgentTurn | null {
  const prevMissing = collection.qualityMissingSlots
  const result = reviseDraftCollection(collection, text, state, dateContext.now)

  if (result.status === "cancelled") {
    return { kind: "cancelled", message: composeCollectionCancelledMessage() }
  }

  if (result.status === "forceProposal") {
    // 用户要求直接保存：用最新草稿转 proposal，质量字段仍缺则带「未补全」标记
    const draft = result.draft
    const qualityMissing = hasMissingQuality(collection) ? collection.qualityMissingSlots : []
    return draftToProposal(draft, state, itemViews, { fromCollection: true, qualityMissing, dateContext })
  }

  if (result.status === "supplemented") {
    const next = result.collection
    if (next.completeness === "readyToConfirm") {
      // 字段补齐 → 转 proposal，走原 confirm → commit 链路
      return draftToProposal(next.draft, state, itemViews, { fromCollection: true, dateContext })
    }
    // 检测本轮刚补上的是哪个字段，用于文案开场（如「平台记拼多多。」）
    const justFilled = detectJustFilled(prevMissing, next.qualityMissingSlots, collection.draft, next.draft)
    const message = composeCollectionMessage(next, state, itemViews, { justFilled })
    return { kind: "collection", message, collection: next }
  }

  // noChange：输入没命中任何字段。返回 null 让外层判断（查询或新操作）。
  // 这样纯查询能被正常回答，新操作能生成新 collection/proposal，旧 collection 由调用方标 superseded。
  return null
}

/** 检测本轮补充后刚填上的字段，用于 collection 文案开场。 */
function detectJustFilled(
  prevQualityMissing: string[],
  nextQualityMissing: string[],
  prevDraft: AgentDraft,
  nextDraft: AgentDraft
): "platform" | "price" | "review" | "date" | "qty" | null {
  // platform 刚补上
  if (prevQualityMissing.includes("platform") && !nextQualityMissing.includes("platform")) return "platform"
  // price 刚补上（一般会触发 readyToConfirm，这里仅兜底）
  if (prevQualityMissing.includes("price") && !nextQualityMissing.includes("price")) return "price"
  // review 刚补上（review 不在 qualityMissingSlots 里，用 draft 字段对比）
  const prevReview = prevDraft.kind === "restock" ? prevDraft.review : prevDraft.kind === "createItemWithRestock" ? prevDraft.restock.review : undefined
  const nextReview = nextDraft.kind === "restock" ? nextDraft.review : nextDraft.kind === "createItemWithRestock" ? nextDraft.restock.review : undefined
  if (!prevReview && nextReview) return "review"
  // 日期/数量变化（少见于采集态，但兜底）
  return null
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
    // 补货类草稿字段未齐时同样进采集态，避免 LLM 绕过 collection 直接甩确认卡
    if (shouldEnterCollection(parsed.draft, input.text)) {
      return draftToCollection(parsed.draft, input.state, input.itemViews, input.dateContext)
    }
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
