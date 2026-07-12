/**
 * AgentOrchestrator 实现：把 quick answer / local parser / clarification / batch
 * 全部收敛为内部能力，对外只输出 AgentTurn。
 *
 * 本文件是纯逻辑（除 LLM 调用由调用方在外层处理），可被测试直接覆盖。
 */

import { buildLocalClarification, buildLocalDraftFromText, describeAgentDraft, findItemMatch, isExplicitCreateItemSignal, extractCreateItemName, parseAgentResponse, reviseAgentDraft, type AgentClarification, type AgentDraft } from "./drafts"
import {
  createDraftCollection,
  reviseDraftCollection,
  shouldEnterCollection,
  hasMissingQuality,
  isCollectionConfirmSignal,
  isCollectionStrongConfirmSignal,
  isForceProposalSignal,
  type DraftCollection
} from "./draftCollection"
import { classifyAgentIntent, classifyBatchIntent, isSecondConfirmMatch, type BatchLocalIntent } from "./intent"
import { interpretUserTurn, isCurrentEntryFieldRevision, isManagementRequest, type TurnInterpretation } from "./turnInterpretation"
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
  composePendingFieldAnswer,
  composeProposalMessage,
  composeRevisedMessage,
  composeBatchIntro,
  composeBatchRevisedMessage,
  composeCancelledMessage,
  composeBoundaryAnswer,
  composeParseFailedMessage
} from "./responseComposer"
import { classifyConversationBoundary } from "./conversationBoundary"
import type { AllowedAction } from "./conversationContext"
import {
  composeGroundedItemRecordAnswer,
  composeItemNotFoundAnswer,
  detectItemRecordQuery,
  extractEvidenceFacts,
  hasItemRecordQuerySignal,
  resolveItemFromText,
  validateAnswerGrounding
} from "./groundedQuery"
import { buildRecordSuggestions, type InferenceItemView } from "./recordInference"
import { buildRecordInsights, composeInsightLine } from "./recordInsight"
import { buildAgentPlan, composePlanMessage, type BuildAgentPlanResult } from "./planner"
import { createAgentPlan, type AgentPlan, type CalibrateInventoryAction } from "./actions"
import type {
  AgentOrchestrator,
  AgentPlanCommand,
  AgentTurn,
  OrchestrateDecision,
  OrchestrateInput
} from "./orchestrator"
import {
  setRouteDecision,
  setFinalDecision,
  type AgentDecisionTrace
} from "./agentDecisionTrace"
import { planContainsClosedActions } from "./capabilities"

/** 构造一个 AgentOrchestrator 实例。无状态，可单例使用。 */
export function createHouseholdOrchestrator(): AgentOrchestrator {
  return {
    decide(input) {
      const decision = decideSync(input)
      // 阶段 2C 复盘：记录 decideSync 返回值（在 App.tsx dispatch 之前）
      if (input.trace) {
        input.trace.decisionBeforeAppDispatch = decision.kind
        // 如果是 sync 且不是 needTurnInterpreterLlm，说明 decideSync 已最终决策，
        // interpretAndRoute 不会被调用，这里填 finalDecision（含完整 finalMessage）
        if (decision.kind === "sync" && !input.trace.finalDecision) {
          const message = "message" in decision.turn ? decision.turn.message : undefined
          setFinalDecision(input.trace, {
            kind: "sync",
            turnKind: decision.turn.kind,
            message
          })
        }
      }
      return decision
    },
    normalizeLlmResponse(content, input) {
      return normalizeLlm(content, input)
    },
    async interpretAndRoute(input, clientOverride) {
      return interpretAndRouteSync(input, clientOverride)
    }
  }
}

/**
 * 能力收缩：导航处理器。
 *
 * 对已关闭的管理类请求（删除/编辑/预算/提醒/周期管理），Agent 只负责定位对象
 * 并导航到对应 UI，不写入 state，不创建 pendingPlan，不进入二次确认。
 *
 * 定位策略：
 *   1. 从文本中匹配已管理物品（findItemMatch）
 *   2. 匹配到唯一物品 → 告知用户可在物品详情/记录列表中手动操作
 *   3. 匹配到多个候选 → 告知用户到对应分类下操作
 *   4. 未匹配到物品 → 告知用户到对应设置/分类入口操作
 *   5. 预算/提醒类请求 → 导航到设置页
 */
function handleNavigateIntent(text: string, state: import("../types").AppState, trace: AgentDecisionTrace | undefined, intent: string, itemNameHint?: string): OrchestrateDecision {
  setRouteDecision(trace, "navigate", { rule: `navigate.${intent}`, interceptedByRule: true })
  // 解析导航目标 + 生成文案
  // itemNameHint 用于 pendingDraft 场景：用户说「周期改成 30 天」时文本里没有物品名，
  // 但当前 pendingDraft 已隐含了物品上下文（如猫砂），用 hint 作为兜底定位。
  const { message, target } = composeNavigateMessageAndTarget(text, state, intent, itemNameHint)
  return {
    kind: "sync",
    turn: { kind: "navigate", message, target }
  }
}

/**
 * 403 修复：根据用户输入和意图，生成导航回答文案 + 真实导航目标。
 *
 * 旧实现只返回文字，UI 没有任何页面变化，等于"拒绝执行"而非"导航即答案"。
 * 新实现同时返回 target，由 App.tsx 调用 onOpenItem / onOpenCategory / onOpenSettings 完成真实导航。
 *
 * target.section 是可选的 section 锚点：
 *   - purchaseOptions：常购商品区域（删除/修改/设默认常购商品）
 *   - history：补货记录区域（修改历史记录价格等）
 *   - cycle：周期/提醒设置区域（改周期/改提醒）
 *   - budget：预算区域（设预算）
 *
 * 当物品未匹配到时，target 为 undefined，App.tsx 仅展示文案不触发导航。
 */
function composeNavigateMessageAndTarget(
  text: string,
  state: import("../types").AppState,
  intent: string,
  itemNameHint?: string
): { message: string; target: import("./orchestrator").NavigateTarget | undefined } {
  // 预算管理 → 导航到设置页（预算区域）
  if (intent === "manage_budget") {
    return {
      message: "预算设置在右上角的设置里，我帮你打开了预算区域，你到那里调整月预算。我这边不直接改预算，避免记错。",
      target: { kind: "settings", section: "budget" }
    }
  }

  // 删除/编辑类请求：尝试定位物品
  const items = state.items || []
  if (items.length === 0) {
    return {
      message: "目前还没有在管的消耗品。你可以先在主页添加需要管理的物品，之后再来调整记录。",
      target: undefined
    }
  }

  // 用 findItemMatch 定位物品
  // 403 修复：pendingDraft 场景下用户说「周期改成 30 天」时文本里没有物品名，
  // 先用 text 匹配；若未命中且提供了 itemNameHint（如 pendingDraft.itemName="猫砂"），
  // 用 hint 兜底定位，确保导航 target 不丢失。
  let match = findItemMatch(state, text)
  if (!match.item || match.confidence === "ambiguous") {
    if (itemNameHint) {
      const hintMatch = findItemMatch(state, itemNameHint)
      if (hintMatch.item && (hintMatch.confidence === "exact" || hintMatch.confidence === "substring" || hintMatch.confidence === "synonym")) {
        match = hintMatch
      }
    }
  }
  if (match.item && (match.confidence === "exact" || match.confidence === "substring" || match.confidence === "synonym")) {
    const item = match.item
    if (intent === "delete_request") {
      // 区分：删除补货记录 vs 删除常购商品 vs 删除消耗品
      if (/补货记录|记录|那条|那条记录/.test(text)) {
        return {
          message: `「${item.name}」的补货记录在它的详情页里。我帮你打开了「${item.name}」的补货记录区域，你可以在记录详情中手动删除。我这边不直接删记录，避免误删。`,
          target: { kind: "item", itemId: item.id, section: "history" }
        }
      }
      // 删除常购商品
      if (/常购商品|常购|默认商品/.test(text)) {
        return {
          message: `「${item.name}」的常购商品在它的详情页里。我帮你打开了「${item.name}」的常购商品区域，你可以在列表中手动删除。我这边不直接删，避免误删。`,
          target: { kind: "item", itemId: item.id, section: "purchaseOptions" }
        }
      }
      return {
        message: `要删除「${item.name}」的话，请到它的详情页里手动操作。我帮你打开了「${item.name}」，你可以在里面删除。我这边不直接删除消耗品，避免误删。`,
        target: { kind: "item", itemId: item.id }
      }
    }
    // 编辑类（manage_item）：根据文本判断具体 section
    // 周期/提醒类
    if (/周期|提前.*天|提醒/.test(text)) {
      return {
        message: `「${item.name}」的周期和提醒设置在它的详情页里。我帮你打开了「${item.name}」的周期设置区域，你可以到那里调整。我这边不直接改，避免记错。`,
        target: { kind: "item", itemId: item.id, section: "cycle" }
      }
    }
    // 常购商品类
    if (/常购商品|常购|默认商品/.test(text)) {
      return {
        message: `「${item.name}」的常购商品在它的详情页里。我帮你打开了「${item.name}」的常购商品区域，你可以到那里修改。我这边不直接改，避免记错。`,
        target: { kind: "item", itemId: item.id, section: "purchaseOptions" }
      }
    }
    // 历史记录类
    if (/历史|记录|上个月|上次|价格/.test(text)) {
      return {
        message: `「${item.name}」的补货记录在它的详情页里。我帮你打开了「${item.name}」的补货记录区域，你可以到那里修改。我这边不直接改，避免记错。`,
        target: { kind: "item", itemId: item.id, section: "history" }
      }
    }
    // 兜底：打开详情页
    return {
      message: `「${item.name}」的设置在它的详情页里。我帮你打开了「${item.name}」，你可以到那里调整周期、单位、提醒等。我这边不直接改，避免记错。`,
      target: { kind: "item", itemId: item.id }
    }
  }

  // 匹配到多个候选
  if (match.candidates.length > 1) {
    return {
      message: `你说的可能是 ${match.candidates.slice(0, 4).map((c) => `「${c}」`).join("、")} 中的一个。请到对应物品的详情页里手动操作，我这边不直接改，避免记错。`,
      target: undefined
    }
  }

  // 未匹配到物品
  return {
    message: "没找到对应的消耗品。你可以到主页或对应分类下找到要管理的物品，在详情页里手动操作。我这边不直接改，避免记错。",
    target: undefined
  }
}

/**
 * 403：库存状态报告处理器。
 *
 * 从 TurnInterpretation 提取 itemName/remainingDays/statusLabel，
 * 构造 CalibrateInventoryAction 并生成 planProposal。
 * 用户确认后由 commitAgentPlan → applyAgentAction → calibrateRemainingDays 写入。
 *
 * 不创建补货记录，不新建消耗品，只更新库存状态锚点。
 */
function handleInventoryStatusReport(
  interpretation: TurnInterpretation,
  state: import("../types").AppState,
  text: string,
  trace: AgentDecisionTrace | undefined
): OrchestrateDecision {
  const itemName = interpretation.fields.itemName
  const remainingDays = interpretation.fields.remainingDays
  const statusLabel = interpretation.fields.unit ?? (
    remainingDays === 0 ? "已用完"
      : (interpretation.fields.inventoryStatus === "low" ? "快没了"
        : interpretation.fields.inventoryStatus === "half" ? "还能用一阵"
          : interpretation.fields.inventoryStatus === "plenty" ? "还有很多"
            : "库存状态更新")
  )

  if (!itemName || remainingDays === undefined) {
    setRouteDecision(trace, "inventoryStatus", { rule: "missing_fields", routeToLlm: true })
    return {
      kind: "sync",
      turn: {
        kind: "answer",
        message: "没听清楚是哪个物品或还剩多少。你可以说「猫砂快没了」或「纸巾还剩两包」。"
      }
    }
  }

  // 查找物品 id
  const match = findItemMatch(state, itemName)
  if (!match.item || match.confidence === "ambiguous") {
    if (match.candidates.length > 1) {
      setRouteDecision(trace, "inventoryStatus", { rule: "ambiguous_match", interceptedByRule: true })
      return {
        kind: "sync",
        turn: {
          kind: "clarification",
          message: `你说的可能是 ${match.candidates.slice(0, 4).map((c) => `「${c}」`).join("、")} 中的一个。告诉我具体是哪个？`,
          options: match.candidates.slice(0, 4).map((c) => ({ label: c, draft: undefined }))
        }
      }
    }
    setRouteDecision(trace, "inventoryStatus", { rule: "no_match", interceptedByRule: true })
    return {
      kind: "sync",
      turn: {
        kind: "answer",
        message: `没在管「${itemName}」这个消耗品。你可以先在主页添加它，之后再来报告库存状态。`
      }
    }
  }

  const item = match.item
  const action: CalibrateInventoryAction = {
    type: "calibrateInventory",
    itemId: item.id,
    itemName: item.name,
    remainingDays,
    statusLabel
  }
  const plan = createAgentPlan([action], text)
  const message = composePlanMessage(plan, state)
  setRouteDecision(trace, "inventoryStatus", { rule: "planProposal", interceptedByRule: true })
  return {
    kind: "sync",
    turn: { kind: "planProposal", message, plan }
  }
}

/** 同步决策：本地能处理就返回 sync turn，否则返回 needLlm。 */
function decideSync(input: OrchestrateInput): OrchestrateDecision {
  const { text, state, itemViews, pendingDraft, pendingCollection, pendingBatch, pendingPlan, dateContext, trace } = input

  // 0. 阶段 4B.3：调试命令误输入保护
  //    用户把 __copyAgentTrace() 等调试命令误发到聊天框时，本地拦截，不送 LLM，不写入。
  if (isDebugCommandInput(text)) {
    setRouteDecision(trace, "debugCommandGuard", { rule: "debug_command_guard", interceptedByRule: true })
    if (trace && trace.llmInterpreter) {
      trace.llmInterpreter.shouldCall = false
      trace.llmInterpreter.skipReason = "debug_command_guard"
    }
    return {
      kind: "sync",
      turn: { kind: "answer", message: "这是调试命令，请在右侧 Console 里执行，不需要发到聊天里。" }
    }
  }

  // 0.5. 阶段 4B.3：pending status query 本地高置信处理
  //      用户问「现在还有什么待确认的吗 / 还有待确认的吗 / 有什么没确认的吗 / 现在还有 pending 吗」
  //      时不送 LLM，本地按当前 pending 状态给摘要，避免 LLM 自然语言回答被 normalize 打成 fallback。
  if (isPendingStatusQuery(text)) {
    const message = composePendingStatusSummary(pendingCollection, pendingPlan, pendingDraft, pendingBatch)
    setRouteDecision(trace, "pendingStatusQuery", { rule: "pending_status_query", interceptedByRule: true })
    return {
      kind: "sync",
      turn: { kind: "answer", message }
    }
  }

  // 1. pending plan（多动作计划状态机：confirm / cancel / revise / status）
  //    阶段 3A：先用 turnInterpretation + focusResolver 判断本轮是否继续当前 plan。
  //    只有 confirm / cancel 才继续走原 plan handler（保留二次确认删除约束）。
  //    新补货记录 / 查询 / 闲聊 / 低置信一律不执行 plan，落到后续流程。
  //    关键修复：「今天买了 3 袋五常大米」不再因「袋」在 REVISE_KEYWORDS 中
  //    被 classifyAgentIntent 误判为 reviseDraft，而是由 interpretUserTurn
  //    正确识别为 new_restock_record，走新建 collection 路径。
  if (pendingPlan && (pendingPlan.status === "pending" || pendingPlan.status === "awaitingSecondConfirm")) {
    const planDecision = handlePendingPlanFocusDecision(input)
    if (planDecision) return planDecision
    // planDecision === null 表示本轮不打断当前 plan 也不继续执行，
    // 落到下面：可能是查询/闲聊/新操作请求。
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
  //    阶段 3C：先用 turnInterpretation + focusResolver 判断本轮是否继续当前 batch。
  //    只有 confirm / cancel / force_proposal / batch_revision 才继续走原 batch handler。
  //    新补货记录 / 查询 / 闲聊 / 低置信一律不继续 batch，落到后续流程。
  //    关键修复：pendingBatch 下输入「今天买了 3 袋五常大米」不再被旧 batch handler 吞掉，
  //    而是由 interpretUserTurn 正确识别为 new_restock_record，走新建 collection 路径，
  //    旧 pendingBatch 由 App.tsx 的 collection turn 处理逻辑标 superseded。
  if (pendingBatch && pendingBatch.length > 0) {
    const batchDecision = handlePendingBatchFocusDecision(input)
    if (batchDecision) return batchDecision
    // batchDecision === null 表示本轮不打断当前 batch、也不继续执行，
    // 落到下面继续 pendingDraft / writeDraft / boundary / LLM 流程。
  }

  // 4. pending proposal（旧 AgentDraft 状态机）：confirm / cancel / revise / pendingStatus
  //    阶段 3B：先用 turnInterpretation + focusResolver 判断本轮是否继续当前 draft。
  //    只有 confirm / cancel / force_proposal 才继续走原 draft handler。
  //    新补货记录 / 查询 / 闲聊 / 低置信一律不继续 draft，落到后续流程。
  //    关键修复：pendingDraft 下输入「今天买了 3 袋五常大米」不再被旧 classifyAgentIntent
  //    因「袋」在 REVISE_KEYWORDS 中误判为 reviseDraft，而是由 interpretUserTurn
  //    正确识别为 new_restock_record，走新建 collection 路径，旧 draft 由 App.tsx 标 superseded。
  if (pendingDraft) {
    const draftDecision = handlePendingDraftFocusDecision(input)
    if (draftDecision) return draftDecision
    // draftDecision === null 表示本轮不打断当前 draft、也不继续执行，
    // 落到下面继续 writeDraft / boundary / LLM 流程。
  }

  // 3.5. 能力收缩：无 pending 时拦截管理类意图（删除/编辑/预算/提醒/周期管理）。
  //     这些请求不再进入写入流程，只定位对象并导航到对应 UI。
  //     必须在 writeDraft 之前拦截，避免被 classifyAgentIntent 误判为 writeDraft
  //     后走到 buildAgentPlan（已关闭管理类）→ noPlan → buildLocalDraftFromText → null → LLM。
  {
    const interpretation = interpretUserTurn({ text, state, itemViews, dateContext })
    if (trace) {
      trace.localInterpretation = interpretation
      trace.firstFocusDecision = { focus: "route_to_navigate", reason: `管理类意图「${interpretation.intent}」无 pending 时拦截` }
    }
    if (
      interpretation.intent === "delete_request" ||
      interpretation.intent === "manage_item" ||
      interpretation.intent === "manage_budget"
    ) {
      return handleNavigateIntent(text, state, trace, interpretation.intent)
    }

    // 3.6. 403：库存状态报告、最近写入纠错/撤销。
    //   - report_inventory_status → 构造 CalibrateInventoryAction 的 planProposal
    //   - undo_last_mutation → planCommand(undoLastMutation)，App.tsx 直接执行
    //   - correct_last_mutation → planCommand(correctLastMutation, field, value)，App.tsx 直接执行
    //   这些操作不进入 writeDraft 流程，不创建 collection/proposal/plan 管理类入口。
    if (interpretation.intent === "report_inventory_status") {
      setRouteDecision(trace, "inventoryStatus", { rule: "report_inventory_status", interceptedByRule: true })
      return handleInventoryStatusReport(interpretation, state, text, trace)
    }
    if (interpretation.intent === "undo_last_mutation") {
      setRouteDecision(trace, "undoLastMutation", { rule: "undo_last_mutation", interceptedByRule: true })
      return {
        kind: "sync",
        turn: { kind: "planCommand", message: "撤销刚才那条。", command: { command: "undoLastMutation" } }
      }
    }
    if (interpretation.intent === "correct_last_mutation") {
      const field = interpretation.fields.correctionField
      const value = interpretation.fields.correctionValue
      if (field && value !== undefined) {
        setRouteDecision(trace, "correctLastMutation", { rule: `correct_last_mutation.${field}`, interceptedByRule: true })
        return {
          kind: "sync",
          turn: {
            kind: "planCommand",
            message: `修正刚才那条的${field === "price" ? "金额" : field === "qty" ? "数量" : field === "platform" ? "平台" : "日期"}。`,
            command: { command: "correctLastMutation", field, value }
          }
        }
      }
    }
  }

  // 3.7. 403：管理请求统一兜底守卫。
  //   即使 interpretUserTurn 未将意图分类为 delete_request/manage_item/manage_budget，
  //   只要文本命中 isManagementRequest，立即返回导航回答，不进入 writeDraft 流程。
  //   此守卫防止「删除猫砂的 pidan 豆腐猫砂常购商品」等句式被 buildLocalDraftFromText
  //   误解析为 addPurchaseOption（虽然 drafts.ts 已加守卫，这里再拦一层，纵深防御）。
  //   有 pending 时不拦——允许当前草稿字段修订（如「金额改成 78」）。
  if (!pendingDraft && !pendingCollection && !pendingBatch && !pendingPlan && isManagementRequest(text)) {
    if (trace) {
      setRouteDecision(trace, "navigate", { rule: "management_request_guard", interceptedByRule: true })
    }
    return handleNavigateIntent(text, state, trace, "manage_item")
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
  //
  // 4.5. 阶段 4B.7：data-grounded item record query。
  //     用户询问已管理物品的补货历史 / 最近记录 / 价格 / 平台 / 数量时，
  //     直接从 state.items[].history 读取真实数据回答，不走 answerLlm，避免幻觉。
  //     此检查在混合信号守卫之前，因为「狗粮买了几袋」含「买了」+「几袋」会被
  //     混合信号守卫直接送 LLM，但本地有真实数据可直接回答。
  //     检测条件保守：必须含查询信号 + 已管理物品名 + 不含强写入信号。
  {
    const recordQuery = detectItemRecordQuery(text, state)
    if (recordQuery) {
      setRouteDecision(trace, "groundedQuery", { rule: "grounded_item_record_query", interceptedByRule: true })
      return {
        kind: "sync",
        turn: { kind: "answer", message: composeGroundedItemRecordAnswer(recordQuery) }
      }
    }
    // 未找到物品但有查询信号：不编造，引导用户确认
    if (hasItemRecordQuerySignal(text)) {
      const mentionedItem = resolveItemFromText(text, state.items)
      if (!mentionedItem && state.items.length > 0) {
        setRouteDecision(trace, "groundedQuery", { rule: "item_not_found", interceptedByRule: true })
        return {
          kind: "sync",
          turn: { kind: "answer", message: composeItemNotFoundAnswer(text, state) }
        }
      }
    }
  }

  // 阶段 4B.6：混合信号守卫——无 pending 时也检查购买动词 + 疑问/指代词。
  //   如「我花了多少钱买的这 5 袋猫砂」含「买的」会被 classifyAgentIntent 判为 writeDraft，
  //   但「多少钱」是疑问信号，本地无权高置信新建 collection，应交 LLM 查询历史或澄清。
  if (!pendingDraft && !pendingCollection && !pendingBatch && (!pendingPlan || (pendingPlan.status !== "pending" && pendingPlan.status !== "awaitingSecondConfirm"))) {
    const preInterpretation = interpretUserTurn({ text, state, itemViews: itemViews ?? [], dateContext })
    if (preInterpretation.signals.hasQuestionSignal && preInterpretation.signals.hasPurchaseVerb) {
      setRouteDecision(trace, "needLlm", { rule: "mixed_signal_guard.no_pending", routeToLlm: true, reason: preInterpretation.reason })
      return handleBoundaryOrLlmFallback(text, trace)
    }
  }
  const intent = classifyAgentIntent(text, Boolean(pendingDraft))
  if (intent === "writeDraft") {
    const writeDraftDecision = handleWriteDraftIntent(input)
    if (writeDraftDecision) return writeDraftDecision
    // writeDraftDecision === null 表示本地解析失败（原 4d），落到下面 boundary / LLM
    setRouteDecision(trace, "writeDraft", { rule: "local_parse_failed", routeToLlm: true })
  }

  return handleBoundaryOrLlmFallback(text, trace)
}

/**
 * 处理 writeDraft 意图：检查重复创建/歧义 → planner → 旧 AgentDraft 流程。
 * 返回 null 表示本地解析失败（原 4d），由调用方走 boundary / LLM 兜底。
 *
 * 本函数也用于 pendingCollection 分支的 start_new_collection：直接走 writeDraft 流程
 * 生成新 collection/proposal，旧 collection 由 App.tsx 的 collection turn 处理逻辑标 superseded。
 */
function handleWriteDraftIntent(input: OrchestrateInput): OrchestrateDecision | null {
  const { text, state, itemViews, dateContext, trace } = input
  // 4a. 先检查重复创建/歧义
  const clarification = buildLocalClarification(text, state)
  if (clarification) {
    setRouteDecision(trace, "writeDraft", { rule: "clarification", interceptedByRule: true })
    return { kind: "sync", turn: clarifyToTurn(clarification) }
  }
  // 4b. 用 planner 检查 AgentPlan-only 句式（建分类）
  //     能力收缩后，planner 只对录入域 action 生成 plan（createCategory/createItem/
  //     addPurchaseOption/recordRestock）。其中只有 createCategory 是 plan-only
  //     （其他三种可由旧 AgentDraft 流程处理）。
  const planResult = buildAgentPlan({ text, state, dateContext, pendingPlan: undefined })
  if (planResult.kind === "plan") {
    const plan = planResult.plan
    // 安全兜底：若 plan 意外包含已关闭的管理类 action（不应发生），不创建 planProposal
    if (planContainsClosedActions(plan.actions.map((a) => a.type))) {
      setRouteDecision(trace, "writeDraft", { rule: "planner.closed_action_blocked", interceptedByRule: true })
      // 不返回 planProposal，落到下方 draft 流程或 LLM
    } else {
      // 能力收缩后唯一 plan-only：createCategory（其他 action 回退到旧 AgentDraft 流程）
      const isPlanOnly = plan.actions.some((a) => a.type === "createCategory")
      if (isPlanOnly) {
        setRouteDecision(trace, "writeDraft", { rule: "planner.planOnly", interceptedByRule: true })
        return {
          kind: "sync",
          turn: { kind: "planProposal", message: composePlanMessage(plan, state), plan }
        }
      }
      // 非 plan-only（如「买了两袋猫砂」）：回退到旧 AgentDraft 流程，保持 confirm 链路不变
      setRouteDecision(trace, "writeDraft", { rule: "planner.nonPlanOnly_fallback_to_drafts" })
    }
  }
  if (planResult.kind === "clarification") {
    // planner 的 clarification 是本地兜底，目前不会产出可点选选项
    setRouteDecision(trace, "writeDraft", { rule: "planner.clarification", interceptedByRule: true })
    return { kind: "sync", turn: { kind: "clarification", message: planResult.message, options: [] } }
  }
  // 4c. 回退到旧 AgentDraft 流程
  const localDraft = buildLocalDraftFromText(text, state)
  if (localDraft) {
    // 补货类草稿字段未齐时，先进采集态（DraftCollection），
    // 用自然语言基于历史/常识帮用户整理，而不是立刻甩确认卡或机械追问「多少钱」。
    // 字段已齐（readyToConfirm）或用户明确要求保存时，仍直接走 proposal。
    if (shouldEnterCollection(localDraft, text)) {
      setRouteDecision(trace, "writeDraft", { rule: "drafts.collection", interceptedByRule: true })
      return { kind: "sync", turn: draftToCollection(localDraft, state, itemViews, dateContext) }
    }
    setRouteDecision(trace, "writeDraft", { rule: "drafts.proposal", interceptedByRule: true })
    return { kind: "sync", turn: draftToProposal(localDraft, state, itemViews) }
  }
  // 403 修复：显式 createItem 语义 + 已存在 → 返回 navigate turn（打开已有物品详情）
  // buildLocalDraftFromText 在此场景返回 null，旧逻辑会落到 LLM 兜底，
  // 但这里应直接拦截，回复「已存在」并打开详情页。
  if (isExplicitCreateItemSignal(text)) {
    const itemName = extractCreateItemName(text)
    if (itemName) {
      const match = findItemMatch(state, itemName)
      if (match.item && (match.confidence === "exact" || match.confidence === "synonym")) {
        setRouteDecision(trace, "writeDraft", { rule: "createItem.alreadyExists", interceptedByRule: true })
        return {
          kind: "sync",
          turn: {
            kind: "navigate",
            message: `「${match.item.name}」已经在清单里了，不需要重复创建。我帮你打开它。`,
            target: { kind: "item", itemId: match.item.id, section: undefined }
          }
        }
      }
    }
  }
  // 4d. 本地解析失败 → 返回 null，由调用方走 boundary / LLM 兜底
  return null
}

/**
 * 阶段 4B.3：判断用户输入是否为调试命令误发到聊天框。
 *
 * 命中以下模式时本地拦截，不送 LLM，不写入：
 *   - __copyAgentTrace()
 *   - __agentLastTrace
 *   - __agentTraceHistory
 *   - localStorage.agentDebug
 *   - window.__copyAgentTrace
 *
 * 判断依据：去掉空格后包含上述标识符。长度限制避免误伤普通文本。
 */
const DEBUG_COMMAND_PATTERNS = [
  "__copyagenttrace",
  "__agentlasttrace",
  "__agenttracehistory",
  "localstorage.agentdebug",
  "window.__copyagenttrace"
]

function isDebugCommandInput(text: string): boolean {
  const normalized = text.replace(/\s+/g, "").toLowerCase()
  if (!normalized || normalized.length > 60) return false
  return DEBUG_COMMAND_PATTERNS.some((pattern) => normalized.includes(pattern))
}

/**
 * 阶段 4B.3：判断用户输入是否为 pending status query。
 *
 * 匹配「现在还有什么待确认的吗 / 还有待确认的吗 / 有什么没确认的吗 / 现在还有 pending 吗」
 * 等状态查询句式。这类查询不应送 LLM（自然语言回答容易被 normalize 打成 fallback）。
 *
 * 判断依据：包含「待确认」或「pending」+「吗」的疑问句式。
 * 不匹配只含「确认」的写入句式（如「确认」「按这个来」）。
 */
function isPendingStatusQuery(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (!normalized || normalized.length > 40) return false
  // 必须是疑问句（含「吗」「么」结尾，或「有没有」「还有什么」）
  const isQuestion = /[吗么]$/.test(normalized) || /有没有|还有什么|还有什么待|还有没有|还有 pending|有没有待/.test(normalized)
  if (!isQuestion) return false
  // 必须包含待确认/pending 语义
  const hasPendingSemantics = /待确认|没确认|没记|pending|待补|待采集|待整理|待办|待处理|没确认完|没确认的/.test(normalized)
  return hasPendingSemantics
}

/**
 * 阶段 4B.3：按当前 pending 状态生成本地摘要。
 *
 * 优先级：pendingCollection > pendingPlan > pendingDraft > pendingBatch > 无 pending。
 * 只读摘要，不修改任何 pending 状态，不触发 confirm/cancel/写入。
 */
function composePendingStatusSummary(
  pendingCollection: DraftCollection | undefined,
  pendingPlan: AgentPlan | undefined,
  pendingDraft: AgentDraft | undefined,
  pendingBatch: AgentDraft[] | undefined
): string {
  if (pendingCollection) {
    const draft = pendingCollection.draft
    const description = describeAgentDraft(draft)
    const missing = [...pendingCollection.requiredMissingSlots, ...pendingCollection.qualityMissingSlots]
    if (missing.length > 0) {
      const missingText = missing
        .map((slot) => slot === "platform" ? "平台" : slot === "price" ? "金额" : slot === "review" ? "评价" : slot === "spec" ? "规格" : slot === "notes" ? "备注" : slot)
        .filter(Boolean)
      return `现在有一条待补全记录：${description}，还缺${missingText.join("和")}。`
    }
    return `现在有一条待补全记录：${description}。`
  }
  if (pendingPlan) {
    const actionCount = pendingPlan.actions.length
    const needsSecondConfirm = pendingPlan.status === "awaitingSecondConfirm"
    const summary = needsSecondConfirm
      ? `现在有一个待二次确认的操作（含 ${actionCount} 个动作），需要你再次确认才会执行。`
      : `现在有一个待确认操作（含 ${actionCount} 个动作）。`
    return summary
  }
  if (pendingDraft) {
    return `现在有一条待确认草稿：${describeAgentDraft(pendingDraft)}。`
  }
  if (pendingBatch && pendingBatch.length > 0) {
    return `现在有 ${pendingBatch.length} 条批量记录待确认。`
  }
  return "现在没有待确认的记录。"
}

/**
 * 对话边界与 LLM 兜底（原 decideSync 末段）。
 * identity/realtime/casual → 本地 sync answer；adjacentHomeLife 与其他 → needLlm。
 */
function handleBoundaryOrLlmFallback(text: string, trace?: AgentDecisionTrace): OrchestrateDecision {
  const boundary = classifyConversationBoundary(text)
  if (boundary === "identityOrMeta" || boundary === "realtimeExternal" || boundary === "casual") {
    setRouteDecision(trace, "boundary", { rule: `boundary.${boundary}`, interceptedByRule: true })
    return {
      kind: "sync",
      turn: { kind: "answer", message: composeBoundaryAnswer(boundary, text) }
    }
  }
  if (boundary === "adjacentHomeLife") {
    setRouteDecision(trace, "needLlm", { rule: "boundary.adjacentHomeLife", routeToLlm: true, reason: "adjacent home life question" })
    return { kind: "needLlm", reason: "adjacent home life question" }
  }
  setRouteDecision(trace, "needLlm", { rule: "query_intent_or_unmatched", routeToLlm: true, reason: "query intent or unmatched input" })
  return { kind: "needLlm", reason: "query intent or unmatched input" }
}

/**
 * 阶段 3A：pendingPlan 分支接入 turnInterpretation + focusResolver。
 *
 * 只有 focus = continue_pending_plan（确认/取消）才继续走原 plan handler，
 * 保留二次确认删除约束。其他意图不执行 plan：
 *   - start_new_collection + new_restock_record → 走 writeDraft 流程（新建 collection）
 *   - start_new_collection + manage_item/delete_request → 交原 plan handler（保留 revise 能力）
 *   - route_to_query / route_to_smalltalk / route_to_llm → 兼容 pendingStatus 后落回 decideSync
 *
 * 关键修复：「今天买了 3 袋五常大米」不再因「袋」在 REVISE_KEYWORDS 中被误判为 reviseDraft。
 * interpretUserTurn 正确识别为 new_restock_record → focusResolver 返回 start_new_collection →
 * 走 writeDraft，旧 plan 由 App.tsx 的 collection turn 处理逻辑标 superseded。
 *
 * 返回 null 表示交回 decideSync 后续流程处理（query / boundary / LLM）。
 */
function handlePendingPlanFocusDecision(input: OrchestrateInput): OrchestrateDecision | null {
  const { text, state, itemViews, dateContext, pendingPlan, trace } = input
  if (!pendingPlan) return null

  // 403：当前草稿字段修订（如「价格改成 68」「改成 3 袋」「平台改成京东」）。
  //   当 pendingPlan 活跃且文本命中 isCurrentEntryFieldRevision 时，尝试修订 plan：
  //   - 修订后若 plan 只含有效写入 action（recordRestock/createItem 等）→ 返回 planProposal
  //   - 修订后若 plan 含已关闭的管理类 action（updatePurchaseOption 等）→ 返回导航回答
  //   - tryRevisePendingPlan 未匹配 → 交正常 focus 流程
  if (isCurrentEntryFieldRevision(text)) {
    const reviseResult = buildAgentPlan({ text, state, dateContext, pendingPlan })
    if (reviseResult.kind === "plan") {
      setRouteDecision(trace, "pendingPlan", { rule: "field_revision.revised", interceptedByRule: true })
      return {
        kind: "sync",
        turn: {
          kind: "planProposal",
          message: `${composeRevisedMessage()}\n${composePlanMessage(reviseResult.plan, state)}`,
          plan: reviseResult.plan
        }
      }
    }
    // reviseResult.kind === "noPlan"：
    //   - 若 pendingPlan 含已关闭的管理类 action（如 updatePurchaseOption），
    //     tryRevisePendingPlan 会生成修订 plan 但被 planContainsClosedActions 拦截 → 导航
    //   - 若 tryRevisePendingPlan 未匹配字段 → null → 交正常 focus 流程
    if (planContainsClosedActions(pendingPlan.actions.map((a) => a.type))) {
      setRouteDecision(trace, "pendingPlan", { rule: "field_revision.closed_action_navigate", interceptedByRule: true })
      return handleNavigateIntent(text, state, trace, "manage_item")
    }
    // 否则交正常 focus 流程
  }

  const interpretation = interpretUserTurn({ text, state, itemViews, dateContext })
  const focus = resolveConversationFocus({
    interpretation,
    text,
    pendingPlan,
    pendingCollection: input.pendingCollection,
    pendingDraft: input.pendingDraft,
    pendingBatch: input.pendingBatch
  })

  if (trace) {
    trace.localInterpretation = interpretation
    trace.firstFocusDecision = focus
  }

  switch (focus.focus) {
    case "continue_pending_plan": {
      // 确认 / 取消 → 继续走原 plan handler（保留二次确认删除约束）
      setRouteDecision(trace, "pendingPlan", { rule: "focus.continue_pending_plan", interceptedByRule: true })
      const planTurn = handlePendingPlanIntent(text, pendingPlan, state, itemViews, dateContext, trace)
      if (planTurn) return { kind: "sync", turn: planTurn }
      return null
    }

    case "start_new_collection": {
      // 新补货记录：走 writeDraft 流程，不执行 plan
      if (interpretation.intent === "new_restock_record") {
        setRouteDecision(trace, "pendingPlan", { rule: "focus.start_new_collection(new_restock)", interceptedByRule: true })
        const writeDraftDecision = handleWriteDraftIntent(input)
        if (writeDraftDecision) {
          if (writeDraftDecision.kind === "sync" && trace && !trace.finalDecision) {
            const message = "message" in writeDraftDecision.turn ? writeDraftDecision.turn.message : undefined
            setFinalDecision(trace, { kind: "sync", turnKind: writeDraftDecision.turn.kind, message })
          }
          return writeDraftDecision
        }
        setRouteDecision(trace, "pendingPlan", { rule: "start_new_collection.parse_failed", routeToLlm: true })
        return null
      }
      // 其他写入意图（manage_item / delete_request / batch_revision）：
      // 可能是对当前 plan 的修订（如「改成删除两个」），交原 plan handler 处理。
      // plan handler 未命中时落到 writeDraft。
      setRouteDecision(trace, "pendingPlan", { rule: "focus.start_new_collection(non-restock)→planHandler", interceptedByRule: true })
      const planTurn = handlePendingPlanIntent(text, pendingPlan, state, itemViews, dateContext, trace)
      if (planTurn) return { kind: "sync", turn: planTurn }
      const writeDraftDecision = handleWriteDraftIntent(input)
      if (writeDraftDecision) return writeDraftDecision
      return null
    }

    case "route_to_query":
    case "route_to_smalltalk":
    case "route_to_llm": {
      // 兼容 pendingStatus（如「现在什么情况」）：仍交原 plan handler 显示状态
      const legacyIntent = classifyAgentIntent(text, true)
      if (legacyIntent === "pendingStatus") {
        setRouteDecision(trace, "pendingPlan", { rule: `focus.${focus.focus}→pendingStatus`, interceptedByRule: true })
        const planTurn = handlePendingPlanIntent(text, pendingPlan, state, itemViews, dateContext, trace)
        if (planTurn) return { kind: "sync", turn: planTurn }
      }
      // 边界闲聊：本地直接回答
      if (focus.focus === "route_to_smalltalk") {
        const boundary = classifyConversationBoundary(text)
        if (boundary === "identityOrMeta" || boundary === "realtimeExternal" || boundary === "casual") {
          setRouteDecision(trace, "pendingPlan", { rule: "route_to_smalltalk.boundary", interceptedByRule: true })
          return {
            kind: "sync",
            turn: { kind: "answer" as const, message: composeBoundaryAnswer(boundary, text) }
          }
        }
      }
      // 查询 / 闲聊 / 低置信：不执行 plan，落回 decideSync 后续流程
      setRouteDecision(trace, "pendingPlan", { rule: `focus.${focus.focus}`, routeToLlm: focus.focus === "route_to_llm" })
      return null
    }

    case "route_to_navigate": {
      // 能力收缩：管理类请求只导航，不执行。不影响当前 pendingPlan。
      return handleNavigateIntent(text, state, trace, interpretation.intent)
    }

    default:
      // continue_pending_collection / continue_pending_batch / continue_pending_draft / route_to_write_draft
      // 这些分支在 pendingPlan 场景下不应出现（focusResolver 已分流），兜底交回 decideSync。
      return null
  }
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
  const { text, state, itemViews, dateContext, pendingCollection, pendingPlan, pendingDraft, pendingBatch, trace } = input
  if (!pendingCollection) return null

  const interpretation = interpretUserTurn({ text, state, itemViews, dateContext })
  if (trace) {
    trace.localInterpretation = interpretation
  }
  const focus = resolveConversationFocus({
    interpretation,
    text,
    pendingCollection,
    pendingPlan,
    pendingDraft,
    pendingBatch
  })
  if (trace) {
    trace.firstFocusDecision = focus
  }

  switch (focus.focus) {
    case "continue_pending_collection":
    case "correct_pending_collection": {
      const collectionTurn = handlePendingCollectionIntent(text, pendingCollection, state, itemViews, dateContext)
      if (collectionTurn) {
        if (trace) {
          trace.collectionFallback = { tried: true, producedTurn: true, turnKind: collectionTurn.kind }
        }
        setRouteDecision(trace, "pendingCollection", { rule: `focus.${focus.focus}`, interceptedByRule: true })
        return { kind: "sync", turn: collectionTurn }
      }
      // handlePendingCollectionIntent 返回 null（noChange）：落到后续流程
      if (trace) {
        trace.collectionFallback = { tried: true, producedTurn: false }
      }
      return null
    }

    case "start_new_collection": {
      // 直接走 writeDraft 流程：clarification → planner → 旧 AgentDraft → collection/proposal
      // 旧 collection 由 App.tsx 的 collection turn 处理逻辑标 superseded
      setRouteDecision(trace, "pendingCollection", { rule: "focus.start_new_collection" })
      const writeDraftDecision = handleWriteDraftIntent(input)
      if (writeDraftDecision) return writeDraftDecision
      // 本地解析失败：交 LLM 兜底
      setRouteDecision(trace, "needLlm", { rule: "start_new_collection.local_parse_failed", routeToLlm: true, reason: `start_new_collection but local parser failed: ${focus.reason}` })
      return { kind: "needLlm", reason: `start_new_collection but local parser failed: ${focus.reason}` }
    }

    case "query_current_pending": {
      // 阶段 4B.6：直接从 pendingCollection 回答字段，不新建 collection，不交 LLM
      const targetField = focus.focus === "query_current_pending"
        ? (focus as { targetField?: "price" | "platform" | "qty" | "status" | "date" | "summary" }).targetField
        : undefined
      const message = composePendingFieldAnswer(undefined, pendingCollection, targetField)
      setRouteDecision(trace, "pendingCollection", { rule: `focus.query_current_pending(${targetField ?? "summary"})`, interceptedByRule: true })
      return { kind: "sync", turn: { kind: "answer", message } }
    }

    case "route_to_query": {
      // 不修改当前 collection，继续走 decideSync 的 batch/draft/query/boundary 流程。
      // 但 focusResolver 可能把含评价/价格的长句误判成 query（如「这款猫砂品质不错，不起灰」
      // 命中 adjacentHomeLife 关键词），因此先尝试旧 collection 处理逻辑兜底字段抽取。
      const fallbackTurn = handlePendingCollectionIntent(text, pendingCollection, state, itemViews, dateContext)
      if (fallbackTurn) {
        if (trace) {
          trace.collectionFallback = { tried: true, producedTurn: true, turnKind: fallbackTurn.kind }
        }
        setRouteDecision(trace, "pendingCollection", { rule: "focus.route_to_query.fallback_hit", interceptedByRule: true })
        return { kind: "sync", turn: fallbackTurn }
      }
      if (trace) {
        trace.collectionFallback = { tried: true, producedTurn: false }
      }
      return null
    }

    case "route_to_smalltalk": {
      // 本地边界闲聊直接回答；查询类（adjacentHomeLife）交给 LLM。
      // 先尝试旧 collection 处理逻辑，保留原有「评价/价格」等长句字段的抽取能力
      // （focusResolver 的短句识别覆盖面比 reviseDraftCollection 窄，需兜底）。
      const fallbackTurn = handlePendingCollectionIntent(text, pendingCollection, state, itemViews, dateContext)
      if (fallbackTurn) {
        if (trace) {
          trace.collectionFallback = { tried: true, producedTurn: true, turnKind: fallbackTurn.kind }
        }
        setRouteDecision(trace, "pendingCollection", { rule: "focus.route_to_smalltalk.fallback_hit", interceptedByRule: true })
        return { kind: "sync", turn: fallbackTurn }
      }
      if (trace) {
        trace.collectionFallback = { tried: true, producedTurn: false }
      }
      const boundary = classifyConversationBoundary(text)
      if (boundary === "identityOrMeta" || boundary === "realtimeExternal" || boundary === "casual") {
        setRouteDecision(trace, "boundary", { rule: `boundary.${boundary}`, interceptedByRule: true })
        return {
          kind: "sync",
          turn: { kind: "answer", message: composeBoundaryAnswer(boundary, text) }
        }
      }
      // 非边界闲聊但 focusResolver 判定为 smalltalk（如问候）：交 LLM
      setRouteDecision(trace, "needLlm", { rule: "route_to_smalltalk.not_boundary", routeToLlm: true, reason: focus.reason })
      return { kind: "needLlm", reason: focus.reason }
    }

    case "route_to_llm": {
      // 先尝试旧 collection 处理逻辑，保留原有长句评价/价格字段抽取能力
      // （focusResolver 的短句识别覆盖面比 reviseDraftCollection 窄，需兜底）。
      const fallbackTurn = handlePendingCollectionIntent(text, pendingCollection, state, itemViews, dateContext)
      if (fallbackTurn) {
        if (trace) {
          trace.collectionFallback = { tried: true, producedTurn: true, turnKind: fallbackTurn.kind }
        }
        setRouteDecision(trace, "pendingCollection", { rule: "focus.route_to_llm.fallback_hit", interceptedByRule: true })
        return { kind: "sync", turn: fallbackTurn }
      }
      if (trace) {
        trace.collectionFallback = { tried: true, producedTurn: false }
      }
      // 旧逻辑也抽不出字段（如「拼夕夕/pdd/上次那个平台」这类平台别名或指代）：
      // 阶段 2C 不再直接回 needLlm → 「超出家务范围」，而是交给 LLM Turn Interpreter
      // 结合当前 pendingCollection 重新做结构化理解。
      setRouteDecision(trace, "needTurnInterpreterLlm", { rule: "focus.route_to_llm", routeToLlm: true, reason: focus.reason })
      return { kind: "needTurnInterpreterLlm", reason: focus.reason }
    }

    case "route_to_navigate": {
      // 能力收缩：管理类请求只导航，不执行。不影响当前 pendingCollection。
      return handleNavigateIntent(text, state, trace, interpretation.intent)
    }

    default:
      // continue_pending_plan / continue_pending_batch / continue_pending_draft / route_to_write_draft
      // 这些分支在 pendingCollection 场景下不应出现（focusResolver 已分流），
      // 兜底交回 decideSync 后续流程处理。
      return null
  }
}

/**
 * 阶段 4B.6：明确修订信号——显式修订词 + 字段名 + 金额字。
 * 用于在 interpretation.intent === "unknown" 时判断是否允许 legacy reviseDraft 接管。
 * 不含「今天/昨天/袋/包/京东」等松散关键词，避免「我今天有点累」被误判为修订。
 */
const EXPLICIT_REVISE_PATTERN =
  /改成|换成|修正|更正|价格错了|数量错了|平台错了|商品名叫|买的是|分类改成|分类改为|归到|放到|周期|补货周期|平台|商家|数量|价格|金额|评价|日期|单位|花了|块|元|不是.*是/

/** 把一句话压成只含中文/字母数字的紧凑串，便于关键词匹配。 */
function compactForRevise(value: string): string {
  return value.trim().replace(/[\s，。！？、,.!?]/g, "")
}

/**
 * 阶段 3B：pendingDraft 分支接入 turnInterpretation + focusResolver。
 *
 * 只有 focus = continue_pending_draft（确认/取消/强制保存）才继续走原 draft handler，
 * 保留旧 confirm/cancel/revise/pendingStatus 链路。其他意图不执行 draft：
 *   - start_new_collection + new_restock_record → 走 writeDraft 流程（新建 collection）
 *   - start_new_collection + manage_item/delete_request → 交原 draft handler（保留 revise 能力）
 *   - route_to_query / route_to_smalltalk / route_to_llm → 兼容 pendingStatus 后落回 decideSync
 *
 * 关键修复：pendingDraft 下输入「今天买了 3 袋五常大米」不再被旧 classifyAgentIntent
 * 因「袋」在 REVISE_KEYWORDS 中误判为 reviseDraft，而是由 interpretUserTurn
 * 正确识别为 new_restock_record → focusResolver 返回 start_new_collection →
 * 走 writeDraft，旧 draft 由 App.tsx 的 collection turn 处理逻辑标 superseded。
 *
 * 返回 null 表示交回 decideSync 后续流程处理（writeDraft / boundary / LLM）。
 */
function handlePendingDraftFocusDecision(input: OrchestrateInput): OrchestrateDecision | null {
  const { text, state, itemViews, dateContext, pendingDraft, trace } = input
  if (!pendingDraft) return null

  const interpretation = interpretUserTurn({ text, state, itemViews, dateContext })
  const focus = resolveConversationFocus({
    interpretation,
    text,
    pendingPlan: input.pendingPlan,
    pendingCollection: input.pendingCollection,
    pendingDraft,
    pendingBatch: input.pendingBatch
  })

  if (trace) {
    trace.localInterpretation = interpretation
    trace.firstFocusDecision = focus
  }

  switch (focus.focus) {
    case "continue_pending_draft": {
      // 确认 / 取消 / 强制保存 → 继续走原 draft handler（保留旧状态机）
      setRouteDecision(trace, "pendingDraft", { rule: "focus.continue_pending_draft", interceptedByRule: true })
      const draftTurn = handlePendingDraftIntent(text, pendingDraft, state, trace)
      if (draftTurn) return { kind: "sync", turn: draftTurn }
      return null
    }

    case "start_new_collection": {
      // 新补货记录：走 writeDraft 流程，不执行 draft
      if (interpretation.intent === "new_restock_record") {
        setRouteDecision(trace, "pendingDraft", { rule: "focus.start_new_collection(new_restock)", interceptedByRule: true })
        const writeDraftDecision = handleWriteDraftIntent(input)
        if (writeDraftDecision) {
          if (writeDraftDecision.kind === "sync" && trace && !trace.finalDecision) {
            const message = "message" in writeDraftDecision.turn ? writeDraftDecision.turn.message : undefined
            setFinalDecision(trace, { kind: "sync", turnKind: writeDraftDecision.turn.kind, message })
          }
          return writeDraftDecision
        }
        setRouteDecision(trace, "pendingDraft", { rule: "start_new_collection.parse_failed", routeToLlm: true })
        return null
      }
      // 其他写入意图（manage_item / delete_request / batch_revision）：
      // 可能是对当前 draft 的修订（如「改成 3 袋」），交原 draft handler 处理。
      // draft handler 未命中时落到 writeDraft。
      setRouteDecision(trace, "pendingDraft", { rule: "focus.start_new_collection(non-restock)→draftHandler", interceptedByRule: true })
      const draftTurn = handlePendingDraftIntent(text, pendingDraft, state, trace)
      if (draftTurn) return { kind: "sync", turn: draftTurn }
      const writeDraftDecision = handleWriteDraftIntent(input)
      if (writeDraftDecision) return writeDraftDecision
      return null
    }

    case "query_current_pending": {
      // 阶段 4B.6：直接从 pendingDraft 回答字段，不新建 collection，不交 LLM
      const targetField = focus.focus === "query_current_pending"
        ? (focus as { targetField?: "price" | "platform" | "qty" | "status" | "date" | "summary" }).targetField
        : undefined
      const message = composePendingFieldAnswer(pendingDraft, undefined, targetField)
      setRouteDecision(trace, "pendingDraft", { rule: `focus.query_current_pending(${targetField ?? "summary"})`, interceptedByRule: true })
      return { kind: "sync", turn: { kind: "answer", message } }
    }

    case "route_to_query":
    case "route_to_smalltalk":
    case "route_to_llm": {
      // 兼容 pendingStatus（如「现在什么情况」）：仍交原 draft handler 显示状态
      const legacyIntent = classifyAgentIntent(text, true)
      if (legacyIntent === "pendingStatus") {
        setRouteDecision(trace, "pendingDraft", { rule: `focus.${focus.focus}→pendingStatus`, interceptedByRule: true })
        const draftTurn = handlePendingDraftIntent(text, pendingDraft, state, trace)
        if (draftTurn) return { kind: "sync", turn: draftTurn }
      }
      // 兼容 reviseDraft（如「改成 3 袋」「换成京东」「价格 45」）：
      // interpretUserTurn 可能判为 unknown（无「买了」关键词），但 classifyAgentIntent
      // 能识别为 reviseDraft。仍交原 draft handler 处理，保留旧修订能力。
      // 注意：含「买了」的新补货记录已由 start_new_collection 分支处理，
      // 不会走到这里，因此不会重新引入「袋」误判问题。
      //
      // 阶段 4B.6：pending 活跃期白名单准入——以下情况不允许 legacy reviseDraft 接管：
      //   1. interpretation.intent 为 smalltalk / query_inventory（明确非修订）
      //   2. hasQuestionSignal=true（混合信号，需 LLM 结合 pending 判断）
      //   3. interpretation.intent 为 unknown 且无明确修订信号（如「我今天有点累」
      //      被 classifyAgentIntent 因「今天」误判为 reviseDraft，但无改成/换成/价格等
      //      明确修订词，不应被 legacy 覆盖）
      const hasExplicitReviseSignal = EXPLICIT_REVISE_PATTERN.test(compactForRevise(text))
      const shouldBlockReviseDraft =
        interpretation.intent === "smalltalk" ||
        interpretation.intent === "query_inventory" ||
        interpretation.signals.hasQuestionSignal === true ||
        (interpretation.intent === "unknown" && !hasExplicitReviseSignal)
      if (legacyIntent === "reviseDraft" && !shouldBlockReviseDraft) {
        setRouteDecision(trace, "pendingDraft", { rule: `focus.${focus.focus}→reviseDraft`, interceptedByRule: true })
        const draftTurn = handlePendingDraftIntent(text, pendingDraft, state, trace)
        if (draftTurn) return { kind: "sync", turn: draftTurn }
      }
      // 边界闲聊：本地直接回答
      if (focus.focus === "route_to_smalltalk") {
        const boundary = classifyConversationBoundary(text)
        if (boundary === "identityOrMeta" || boundary === "realtimeExternal" || boundary === "casual") {
          setRouteDecision(trace, "pendingDraft", { rule: "route_to_smalltalk.boundary", interceptedByRule: true })
          return {
            kind: "sync",
            turn: { kind: "answer" as const, message: composeBoundaryAnswer(boundary, text) }
          }
        }
      }
      // 阶段 4B.6 补口：pendingDraft route_to_llm 无条件升级 needTurnInterpreterLlm。
      // 原因：route_to_llm 已代表本地无法可靠承接。draft 态下不应再落回 answer LLM，
      // 因为 answer LLM 没有「修订当前 draft 字段」的结构化出口（会答「超出家务范围」）。
      // 与 pendingCollection 对齐（pendingCollection 的 route_to_llm 也是无条件升级）。
      if (focus.focus === "route_to_llm") {
        setRouteDecision(trace, "needTurnInterpreterLlm", { rule: "focus.route_to_llm.unconditional", routeToLlm: true, reason: focus.reason })
        return { kind: "needTurnInterpreterLlm", reason: focus.reason }
      }
      // route_to_query 且含混合信号（hasQuestionSignal）时，也交 LLM Turn Interpreter。
      // 如「猫砂那条你记了多少钱」被判为 query_inventory → route_to_query，
      // 但含「多少钱」指代信号，应交 LLM 结合 pendingDraft 回答。
      if (focus.focus === "route_to_query" && interpretation.signals.hasQuestionSignal) {
        setRouteDecision(trace, "needTurnInterpreterLlm", { rule: "focus.route_to_query.mixed_signal", routeToLlm: true, reason: focus.reason })
        return { kind: "needTurnInterpreterLlm", reason: focus.reason }
      }
      // 查询 / 闲聊 / 低置信：不执行 draft，落回 decideSync 后续流程
      // 注意：route_to_llm 已在上方无条件升级为 needTurnInterpreterLlm，不会走到这里。
      setRouteDecision(trace, "pendingDraft", { rule: `focus.${focus.focus}` })
      return null
    }

    case "route_to_navigate": {
      // 能力收缩：管理类请求只导航，不执行。不影响当前 pendingDraft。
      // 403 修复：pendingDraft 场景下用户说「周期改成 30 天」时文本里没有物品名，
      // 传 pendingDraft 的 itemName 作为 hint，让 composeNavigateMessageAndTarget 能定位到物品。
      const draftItemName = pendingDraft.kind === "restock" ? pendingDraft.itemName
        : pendingDraft.kind === "createItemWithRestock" ? pendingDraft.item.itemName
        : pendingDraft.kind === "createItem" ? pendingDraft.itemName
        : pendingDraft.kind === "addPurchaseOption" ? pendingDraft.itemName
        : undefined
      return handleNavigateIntent(text, state, trace, interpretation.intent, draftItemName)
    }

    default:
      // continue_pending_collection / continue_pending_batch / continue_pending_plan / route_to_write_draft
      // 这些分支在 pendingDraft 场景下不应出现（focusResolver 已分流），兜底交回 decideSync。
      return null
  }
}

/**
 * 阶段 3B：原 pendingDraft 状态机的 confirm / cancel / revise / pendingStatus 逻辑。
 * 从 decideSync 旧分支提取，保持行为不变。
 */
function handlePendingDraftIntent(
  text: string,
  pendingDraft: AgentDraft,
  state: import("../types").AppState,
  trace?: AgentDecisionTrace
): AgentTurn | null {
  const intent = classifyAgentIntent(text, true)
  if (intent === "confirmDraft") {
    // 403 修复：返回 typed draftCommit command，由 App.tsx 调用 confirmAgentDraft。
    // 旧实现返回 { kind: "proposal", executableDraft: pendingDraft } 并依赖 App.tsx
    // 的 turn.executableDraft === pendingDraft 引用相等判断；该写法在 draft 经过 revise
    // 后引用变化时会落入"修订"分支，形成确认死循环。
    setRouteDecision(trace, "pendingDraft", { rule: "draftHandler.confirmDraft→draftCommit", interceptedByRule: true })
    return { kind: "planCommand", message: "", command: { command: "draftCommit" } }
  }
  // 403 修复：force_proposal 信号（就这么记/先保存/直接记下/不用问等）在 pendingDraft
  // 上下文中视为确认。focusResolver 已将 force_proposal 路由到 continue_pending_draft，
  // 但旧 handlePendingDraftIntent 只检查 classifyAgentIntent，不认识"直接记下"等
  // force-proposal 短语（它们不在 CONFIRM_EXPLICIT_PHRASES 里），导致返回 null 落到 LLM。
  if (isForceProposalSignal(text)) {
    setRouteDecision(trace, "pendingDraft", { rule: "draftHandler.forceProposal→draftCommit", interceptedByRule: true })
    return { kind: "planCommand", message: "", command: { command: "draftCommit" } }
  }
  if (intent === "cancelDraft") {
    setRouteDecision(trace, "pendingDraft", { rule: "draftHandler.cancelDraft", interceptedByRule: true })
    return { kind: "cancelled", message: composeCancelledMessage() }
  }
  if (intent === "pendingStatus") {
    setRouteDecision(trace, "pendingDraft", { rule: "draftHandler.pendingStatus", interceptedByRule: true })
    return { kind: "answer", message: composePendingReminder(pendingDraft) }
  }
  if (intent === "reviseDraft") {
    setRouteDecision(trace, "pendingDraft", { rule: "draftHandler.reviseDraft", interceptedByRule: true })
    const revised = reviseAgentDraft(pendingDraft, text, state)
    if (revised) {
      return {
        kind: "proposal",
        message: composeRevisedMessage(),
        executableDraft: revised,
        status: "pending"
      }
    }
    // 修订失败：回退到 pending reminder
    return { kind: "answer", message: composePendingReminder(pendingDraft) }
  }
  return null
}

/**
 * 阶段 3C：pendingBatch 分支接入 turnInterpretation + focusResolver。
 *
 * 只有 focus = continue_pending_batch（确认/取消/强制保存/批量修订）才继续走原 batch handler，
 * 保留旧 confirm/cancel/revise 链路。其他意图不执行 batch：
 *   - start_new_collection + new_restock_record → 走 writeDraft 流程（新建 collection）
 *   - start_new_collection + manage_item/delete_request → 交原 batch handler 兜底（保留修订能力）
 *   - route_to_query / route_to_smalltalk / route_to_llm → 兼容旧 batch 意图后落回 decideSync
 *
 * 关键修复：pendingBatch 下输入「今天买了 3 袋五常大米」不再被旧 batch handler 吞掉，
 * 而是由 interpretUserTurn 正确识别为 new_restock_record → focusResolver 返回 start_new_collection →
 * 走 writeDraft，旧 pendingBatch 由 App.tsx 的 collection turn 处理逻辑标 superseded。
 *
 * 返回 null 表示交回 decideSync 后续流程处理（pendingDraft / writeDraft / boundary / LLM）。
 */
function handlePendingBatchFocusDecision(input: OrchestrateInput): OrchestrateDecision | null {
  const { text, state, itemViews, dateContext, pendingBatch, trace } = input
  if (!pendingBatch || pendingBatch.length === 0) return null

  const interpretation = interpretUserTurn({ text, state, itemViews, dateContext })
  const focus = resolveConversationFocus({
    interpretation,
    text,
    pendingPlan: input.pendingPlan,
    pendingCollection: input.pendingCollection,
    pendingDraft: input.pendingDraft,
    pendingBatch
  })

  if (trace) {
    trace.localInterpretation = interpretation
    trace.firstFocusDecision = focus
  }

  switch (focus.focus) {
    case "continue_pending_batch": {
      // 确认 / 取消 / 强制保存 / 批量修订 → 继续走原 batch handler（保留旧状态机）
      setRouteDecision(trace, "pendingBatch", { rule: "focus.continue_pending_batch", interceptedByRule: true })
      const batchTurn = handleBatchIntent(text, pendingBatch, state, trace)
      if (batchTurn) return { kind: "sync", turn: batchTurn }
      // 旧 batch handler 未命中（如 classifyBatchIntent 返回 null）→ 落回 decideSync
      setRouteDecision(trace, "pendingBatch", { rule: "focus.continue_pending_batch.no_match", routeToLlm: false })
      return null
    }

    case "start_new_collection": {
      // 新补货记录：走 writeDraft 流程，不执行 batch
      if (interpretation.intent === "new_restock_record") {
        setRouteDecision(trace, "pendingBatch", { rule: "focus.start_new_collection(new_restock)", interceptedByRule: true })
        const writeDraftDecision = handleWriteDraftIntent(input)
        if (writeDraftDecision) {
          if (writeDraftDecision.kind === "sync" && trace && !trace.finalDecision) {
            const message = "message" in writeDraftDecision.turn ? writeDraftDecision.turn.message : undefined
            setFinalDecision(trace, { kind: "sync", turnKind: writeDraftDecision.turn.kind, message })
          }
          return writeDraftDecision
        }
        setRouteDecision(trace, "pendingBatch", { rule: "start_new_collection.parse_failed", routeToLlm: true })
        return null
      }
      // 其他写入意图（manage_item / delete_request / batch_revision）：
      // 可能是对当前 batch 的修订，交原 batch handler 兜底。
      // batch handler 未命中时落到 writeDraft。
      setRouteDecision(trace, "pendingBatch", { rule: "focus.start_new_collection(non-restock)→batchHandler", interceptedByRule: true })
      const batchTurn = handleBatchIntent(text, pendingBatch, state, trace)
      if (batchTurn) return { kind: "sync", turn: batchTurn }
      const writeDraftDecision = handleWriteDraftIntent(input)
      if (writeDraftDecision) return writeDraftDecision
      return null
    }

    case "route_to_query":
    case "route_to_smalltalk":
    case "route_to_llm": {
      // 兼容旧 batch 意图（如 classifyBatchIntent 识别的 batchConfirm/batchCancel 等）：
      // 仍交原 batch handler 处理，保留旧确认/取消能力。
      const batchTurn = handleBatchIntent(text, pendingBatch, state, trace)
      if (batchTurn) {
        setRouteDecision(trace, "pendingBatch", { rule: `focus.${focus.focus}→batchHandler`, interceptedByRule: true })
        return { kind: "sync", turn: batchTurn }
      }
      // 边界闲聊：本地直接回答
      if (focus.focus === "route_to_smalltalk") {
        const boundary = classifyConversationBoundary(text)
        if (boundary === "identityOrMeta" || boundary === "realtimeExternal" || boundary === "casual") {
          setRouteDecision(trace, "pendingBatch", { rule: "route_to_smalltalk.boundary", interceptedByRule: true })
          return {
            kind: "sync",
            turn: { kind: "answer" as const, message: composeBoundaryAnswer(boundary, text) }
          }
        }
      }
      // 查询 / 闲聊 / 低置信：不执行 batch，落回 decideSync 后续流程
      setRouteDecision(trace, "pendingBatch", { rule: `focus.${focus.focus}`, routeToLlm: focus.focus === "route_to_llm" })
      return null
    }

    case "route_to_navigate": {
      // 能力收缩：管理类请求只导航，不执行。不影响当前 pendingBatch。
      return handleNavigateIntent(text, state, trace, interpretation.intent)
    }

    default:
      // continue_pending_collection / continue_pending_batch / continue_pending_plan / continue_pending_draft / route_to_write_draft
      // 这些分支在 pendingBatch 场景下不应出现（focusResolver 已分流），兜底交回 decideSync。
      return null
  }
}

/**
 * 阶段 2C：pendingCollection 下本地低置信（route_to_llm）时，调用 LLM Turn Interpreter
 * 重新做结构化理解，再用 resolveConversationFocus 二次路由。
 *
 * 阶段 4B.6：扩展支持 pendingDraft（无 pendingCollection 时也能进入）。
 * pendingDraft + 混合信号（如「我花了多少钱买的这 5 袋猫砂」）从 handlePendingDraftFocusDecision
 * 路由到 needTurnInterpreterLlm，由本函数调用 LLM 结合 pendingDraft 上下文重新理解。
 *
 * 决策契约：
 *   - LLM 解释成功且高/中置信 → 复用 handlePendingCollectionIntent（用合成输入）走 collection 流程；
 *     或 pendingDraft 场景走 continue_pending_draft / query_current_pending
 *   - LLM 解释失败 / 低置信 / unknown → 返回 clarification，询问是否补当前记录，
 *     禁止回复「超出家务范围」
 *   - LLM 判定为 query_current_pending → 直接从 pending 回答字段（不交 answer LLM）
 *   - LLM 判定为 query / smalltalk → 返回 needLlm，交常规 answer LLM 兜底
 *
 * clientOverride 供单测注入 mock；真实运行时内部构造 desktop bridge client。
 */
async function interpretAndRouteSync(
  input: OrchestrateInput,
  clientOverride?: TurnInterpreterLlmClient
): Promise<OrchestrateDecision> {
  const { text, state, itemViews, dateContext, pendingCollection, pendingPlan, pendingDraft, pendingBatch, trace } = input

  // 阶段 3B.1：进入 interpretAndRouteSync 表示 shouldCall=true（decideSync 返回 needTurnInterpreterLlm）
  // 覆盖 createTrace 默认的 shouldCall=false / skipReason="local_high_confidence"
  if (trace) {
    if (trace.llmInterpreter) {
      trace.llmInterpreter.shouldCall = true
      trace.llmInterpreter.skipReason = "entering_interpretAndRoute"
    } else {
      trace.llmInterpreter = {
        shouldCall: true,
        called: false,
        skipReason: "entering_interpretAndRoute"
      }
    }
  }

  // 阶段 4B.6：允许 pendingDraft-only 进入（不再要求 pendingCollection 必须存在）
  if (!pendingCollection && !pendingDraft) {
    // 无 pending 上下文不应进入此路径；兜底交常规 LLM
    if (trace) {
      trace.llmInterpreter!.skipReason = "no_pending_context"
    }
    setRouteDecision(trace, "needLlm", { rule: "interpretAndRoute.no_pending_context", routeToLlm: true, reason: "interpretAndRoute without pendingCollection or pendingDraft" })
    setFinalDecision(trace, { kind: "needLlm" })
    return { kind: "needLlm", reason: "interpretAndRoute without pendingCollection or pendingDraft" }
  }

  const llmInterpretation = await askTurnInterpreterLlm({
    text,
    pendingCollection,
    pendingDraft,
    pendingPlan,
    pendingBatch,
    state,
    itemViews,
    dateContext,
    client: clientOverride,
    trace
  })

  // LLM 失败 / 低置信 / unknown → clarification（不回复「超出家务范围」）
  if (!llmInterpretation) {
    const clarificationTurn = composePendingClarificationTurn(pendingCollection, pendingDraft)
    setRouteDecision(trace, "turnInterpreter", { rule: "llm_failed_or_low_confidence→clarification", interceptedByRule: true })
    setFinalDecision(trace, { kind: "sync", turnKind: clarificationTurn.kind, message: clarificationTurn.message })
    return { kind: "sync", turn: clarificationTurn }
  }

  const focus = resolveConversationFocus({
    interpretation: llmInterpretation,
    text,
    pendingCollection,
    pendingPlan,
    pendingDraft,
    pendingBatch
  })
  if (trace) {
    trace.secondFocusDecision = focus
  }

  switch (focus.focus) {
    case "continue_pending_collection":
    case "correct_pending_collection": {
      if (!pendingCollection) {
        // 不应发生（focusResolver 只在有 pendingCollection 时返回此 focus），兜底 clarification
        const clarificationTurn = composePendingClarificationTurn(pendingCollection, pendingDraft)
        setFinalDecision(trace, { kind: "sync", turnKind: clarificationTurn.kind, message: clarificationTurn.message })
        return { kind: "sync", turn: clarificationTurn }
      }
      // 用 LLM 解释出的 fields 合成等价用户输入，复用旧 collection 处理逻辑抽取/写入字段
      const synthText = synthesizeInputFromInterpretation(llmInterpretation, pendingCollection)
      if (trace) {
        trace.synthesizedInput = synthText
      }
      const collectionTurn = handlePendingCollectionIntent(synthText, pendingCollection, state, itemViews, dateContext)
      if (collectionTurn) {
        setRouteDecision(trace, "turnInterpreter", { rule: `secondFocus.${focus.focus}`, interceptedByRule: true })
        setFinalDecision(trace, { kind: "sync", turnKind: collectionTurn.kind, message: collectionTurn.message })
        return { kind: "sync", turn: collectionTurn }
      }
      // 合成输入仍抽不出字段 → clarification
      const clarificationTurn = composePendingClarificationTurn(pendingCollection, pendingDraft)
      setRouteDecision(trace, "turnInterpreter", { rule: "secondFocus.synth_no_extract→clarification", interceptedByRule: true })
      setFinalDecision(trace, { kind: "sync", turnKind: clarificationTurn.kind, message: clarificationTurn.message })
      return { kind: "sync", turn: clarificationTurn }
    }

    case "continue_pending_draft": {
      // 阶段 4B.6：pendingDraft 场景，LLM 判定为修订当前草稿字段（如「我花了120买的这5袋猫砂」）
      if (!pendingDraft) {
        const clarificationTurn = composePendingClarificationTurn(pendingCollection, pendingDraft)
        setFinalDecision(trace, { kind: "sync", turnKind: clarificationTurn.kind, message: clarificationTurn.message })
        return { kind: "sync", turn: clarificationTurn }
      }
      // 用 LLM 解释出的 fields 合成等价输入，复用旧 draft handler 的 revise 逻辑
      const synthText = synthesizeInputForDraft(llmInterpretation)
      if (trace) {
        trace.synthesizedInput = synthText
      }
      const draftTurn = handlePendingDraftIntent(synthText, pendingDraft, state, trace)
      if (draftTurn) {
        setRouteDecision(trace, "turnInterpreter", { rule: "secondFocus.continue_pending_draft", interceptedByRule: true })
        setFinalDecision(trace, { kind: "sync", turnKind: draftTurn.kind, message: draftTurn.message })
        return { kind: "sync", turn: draftTurn }
      }
      // revise 失败：回退到 pending reminder
      const reminderTurn: AgentTurn = { kind: "answer", message: composePendingReminder(pendingDraft) }
      setFinalDecision(trace, { kind: "sync", turnKind: "answer", message: reminderTurn.message })
      return { kind: "sync", turn: reminderTurn }
    }

    case "query_current_pending": {
      // 阶段 4B.6：LLM 判定为查询当前待确认草稿字段 → 直接从 pending 回答
      const targetField = focus.focus === "query_current_pending"
        ? (focus as { targetField?: "price" | "platform" | "qty" | "status" | "date" | "summary" }).targetField
        : undefined
      const message = composePendingFieldAnswer(pendingDraft, pendingCollection, targetField)
      setRouteDecision(trace, "turnInterpreter", { rule: `secondFocus.query_current_pending(${targetField ?? "summary"})`, interceptedByRule: true })
      setFinalDecision(trace, { kind: "sync", turnKind: "answer", message })
      return { kind: "sync", turn: { kind: "answer", message } }
    }

    case "start_new_collection": {
      // LLM 判定为新物品补货记录（itemName 与当前 pending 不同）：走 writeDraft 流程
      setRouteDecision(trace, "turnInterpreter", { rule: "secondFocus.start_new_collection" })
      const writeDraftDecision = handleWriteDraftIntent(input)
      if (writeDraftDecision) {
        if (writeDraftDecision.kind === "sync") {
          setFinalDecision(trace, { kind: "sync", turnKind: writeDraftDecision.turn.kind, message: "message" in writeDraftDecision.turn ? writeDraftDecision.turn.message : undefined })
        }
        return writeDraftDecision
      }
      const clarificationTurn = composePendingClarificationTurn(pendingCollection, pendingDraft)
      setFinalDecision(trace, { kind: "sync", turnKind: clarificationTurn.kind, message: clarificationTurn.message })
      return { kind: "sync", turn: clarificationTurn }
    }

    case "route_to_query":
      // LLM 判定为查询：不打断 pending，交常规 answer LLM 回答查询
      setRouteDecision(trace, "needLlm", { rule: "secondFocus.route_to_query", routeToLlm: true, reason: "llm interpreted as query, defer to answer llm" })
      setFinalDecision(trace, { kind: "needLlm" })
      return { kind: "needLlm", reason: "llm interpreted as query, defer to answer llm" }

    case "route_to_smalltalk": {
      const boundary = classifyConversationBoundary(text)
      if (boundary === "identityOrMeta" || boundary === "realtimeExternal" || boundary === "casual") {
        const turn = { kind: "answer" as const, message: composeBoundaryAnswer(boundary, text) }
        setRouteDecision(trace, "boundary", { rule: `boundary.${boundary}`, interceptedByRule: true })
        setFinalDecision(trace, { kind: "sync", turnKind: "answer", message: turn.message })
        return { kind: "sync", turn }
      }
      setRouteDecision(trace, "needLlm", { rule: "secondFocus.route_to_smalltalk.not_boundary", routeToLlm: true, reason: "llm interpreted as smalltalk" })
      setFinalDecision(trace, { kind: "needLlm" })
      return { kind: "needLlm", reason: "llm interpreted as smalltalk" }
    }

    case "route_to_navigate": {
      // 能力收缩：管理类请求只导航，不执行。
      const decision = handleNavigateIntent(text, state, trace, llmInterpretation.intent)
      if (decision.kind === "sync") {
        setFinalDecision(trace, { kind: "sync", turnKind: decision.turn.kind, message: decision.turn.message })
      }
      return decision
    }

    case "report_inventory_status": {
      // 403：LLM 在 pending 上下文中检测到库存状态报告 → 生成 planProposal
      const decision = handleInventoryStatusReport(llmInterpretation, state, text, trace)
      if (decision.kind === "sync") {
        setFinalDecision(trace, { kind: "sync", turnKind: decision.turn.kind, message: "message" in decision.turn ? decision.turn.message : undefined })
      }
      return decision
    }

    case "undo_last_mutation": {
      // 403：LLM 在 pending 上下文中检测到撤销请求 → planCommand
      setRouteDecision(trace, "undoLastMutation", { rule: "secondFocus.undo_last_mutation", interceptedByRule: true })
      const turn: AgentTurn = {
        kind: "planCommand",
        message: "撤销刚才那条。",
        command: { command: "undoLastMutation" }
      }
      setFinalDecision(trace, { kind: "sync", turnKind: "planCommand", message: turn.message })
      return { kind: "sync", turn }
    }

    case "correct_last_mutation": {
      // 403：LLM 在 pending 上下文中检测到纠错请求 → planCommand
      const field = llmInterpretation.fields.correctionField
      const value = llmInterpretation.fields.correctionValue
      if (field && value !== undefined) {
        setRouteDecision(trace, "correctLastMutation", { rule: `secondFocus.correct_last_mutation.${field}`, interceptedByRule: true })
        const turn: AgentTurn = {
          kind: "planCommand",
          message: `修正刚才那条的${field === "price" ? "金额" : field === "qty" ? "数量" : field === "platform" ? "平台" : "日期"}。`,
          command: { command: "correctLastMutation", field, value }
        }
        setFinalDecision(trace, { kind: "sync", turnKind: "planCommand", message: turn.message })
        return { kind: "sync", turn }
      }
      // 字段不完整 → clarification
      const clarificationTurn = composePendingClarificationTurn(pendingCollection, pendingDraft)
      setFinalDecision(trace, { kind: "sync", turnKind: clarificationTurn.kind, message: clarificationTurn.message })
      return { kind: "sync", turn: clarificationTurn }
    }

    default:
      // route_to_llm / 其他：clarification 兜底
      const clarificationTurn = composePendingClarificationTurn(pendingCollection, pendingDraft)
      setRouteDecision(trace, "turnInterpreter", { rule: "secondFocus.default→clarification", interceptedByRule: true })
      setFinalDecision(trace, { kind: "sync", turnKind: clarificationTurn.kind, message: clarificationTurn.message })
      return { kind: "sync", turn: clarificationTurn }
  }
}

/**
 * 阶段 4B.6：构造 pending clarification turn。
 * 有 pendingCollection 时复用旧 collection clarification；只有 pendingDraft 时用 draft 口吻。
 */
function composePendingClarificationTurn(
  pendingCollection: DraftCollection | undefined,
  pendingDraft: AgentDraft | undefined
): AgentTurn {
  if (pendingCollection) {
    return composeCollectionClarificationTurn(pendingCollection)
  }
  if (pendingDraft) {
    const name = pendingDraft.kind === "restock" ? pendingDraft.itemName
      : pendingDraft.kind === "createItemWithRestock" ? pendingDraft.item.itemName
      : pendingDraft.kind === "createItem" ? pendingDraft.itemName
      : undefined
    const message = `你是想改刚才那条${name ? `「${name}」` : "记录"}的字段吗？比如「改成 120 元」「换成京东」。如果不打算记了，可以说「算了」。`
    return { kind: "clarification", message, options: [] }
  }
  return { kind: "clarification", message: "你想让我做什么？可以直接说要记录、查询、修改还是取消。", options: [] }
}

/**
 * 阶段 4B.6：把 LLM 解释出的 fields 合成等价用户输入，供 handlePendingDraftIntent 复用旧 revise 逻辑。
 * 例如 { price: 120 } → "120元"；{ platform: "京东" } → "京东"。
 */
function synthesizeInputForDraft(interpretation: TurnInterpretation): string {
  const f = interpretation.fields
  const parts: string[] = []
  if (f.platform) parts.push(f.platform)
  if (f.price !== undefined) parts.push(`${f.price}元`)
  if (f.review) parts.push(f.review)
  if (f.quantity !== undefined) parts.push(`${f.quantity}${f.unit ?? ""}`)
  if (f.date !== undefined) parts.push(String(f.date))
  return parts.length > 0 ? parts.join("，") : ""
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
  _dateContext: import("../llm/householdChat").ChatDateContext,
  trace?: AgentDecisionTrace
): AgentTurn | null {
  const isHighRisk = pendingPlan.requiresSecondConfirm === true || pendingPlan.risk === "high"

  // ---------- awaitingSecondConfirm 状态：只接受「确认删除」 ----------
  if (pendingPlan.status === "awaitingSecondConfirm") {
    // 1. 二次确认删除 → planSecondConfirm command
    if (isSecondConfirmMatch(text)) {
      setRouteDecision(trace, "pendingPlan", { rule: "awaitingSecondConfirm.isSecondConfirmMatch", interceptedByRule: true })
      return {
        kind: "planCommand" as const,
        message: composePlanMessage(pendingPlan, state),
        command: { command: "planSecondConfirm" as const }
      }
    }
    // 2. 取消 → planCancel command
    const cancelIntent = classifyAgentIntent(text, true)
    if (cancelIntent === "cancelDraft") {
      setRouteDecision(trace, "pendingPlan", { rule: "awaitingSecondConfirm.cancel", interceptedByRule: true })
      return {
        kind: "planCommand" as const,
        message: composeCancelledMessage(),
        command: { command: "planCancel" as const }
      }
    }
    // 3. 普通「确认」「好的」「可以」 → answer（提示需要说「确认删除」）
    if (cancelIntent === "confirmDraft") {
      setRouteDecision(trace, "pendingPlan", { rule: "awaitingSecondConfirm.weak_confirm", interceptedByRule: true })
      return {
        kind: "answer" as const,
        message: "这是高风险删除操作，需要你明确说「确认删除」才能执行。输入「取消」可以放弃。"
      }
    }
    // 4. 询问状态 → answer
    if (cancelIntent === "pendingStatus") {
      setRouteDecision(trace, "pendingPlan", { rule: "awaitingSecondConfirm.status", interceptedByRule: true })
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
    setRouteDecision(trace, "pendingPlan", { rule: "pending.directSecondConfirm", interceptedByRule: true })
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
      setRouteDecision(trace, "pendingPlan", { rule: "pending.confirm.highRisk→awaitingSecondConfirm", interceptedByRule: true })
      return {
        kind: "planCommand" as const,
        message: composePlanMessage(pendingPlan, state),
        command: { command: "planAwaitingSecondConfirm" as const }
      }
    }
    // 普通 plan → 直接执行
    setRouteDecision(trace, "pendingPlan", { rule: "pending.confirm", interceptedByRule: true })
    return {
      kind: "planCommand" as const,
      message: composePlanMessage(pendingPlan, state),
      command: { command: "planConfirm" as const }
    }
  }

  // 2. 取消 → 返回 planCancel command
  if (intent === "cancelDraft") {
    setRouteDecision(trace, "pendingPlan", { rule: "pending.cancel", interceptedByRule: true })
    return {
      kind: "planCommand" as const,
      message: composeCancelledMessage(),
      command: { command: "planCancel" as const }
    }
  }

  // 3. 询问状态 → answer（提示还没写入）
  if (intent === "pendingStatus") {
    setRouteDecision(trace, "pendingPlan", { rule: "pending.status", interceptedByRule: true })
    const lines = pendingPlan.actions.map((action, index) => `${index + 1}. ${shortActionHint(action)}`)
    const riskHint = isHighRisk ? "注意：这是高风险删除操作，确认后还需要二次「确认删除」才能执行。\n" : ""
    return {
      kind: "answer" as const,
      message: `还没真正写入，需要你确认一下。\n当前准备处理：\n${lines.join("\n")}\n${riskHint}你可以点卡片里的「确认执行」，或直接输入「确认吧」。`
    }
  }

  // 4. 修订 → 用 planner 的 tryRevisePendingPlan 生成新 planProposal
  if (intent === "reviseDraft") {
    setRouteDecision(trace, "pendingPlan", { rule: "pending.revise", interceptedByRule: true })
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

  // 403 修复：采集态确认信号直接走 draftCommit，不再先转 proposal 再让用户确认一次。
  // 旧实现：missingQualityFields + 强确认 → draftToProposal(...)，用户看到"你确认后我再写入"，
  // 还需要再输入"确认"才会真正写入——形成"确认死循环"。
  // 新实现：required 字段齐全时，无论 quality 字段（price/platform）是否缺失，强确认/轻量确认
  // 都直接返回 draftCommit 命令；App.tsx 读取后调用 onConfirmDraft 写入。
  // required 字段仍缺（missingRequiredFields）时不允许确认，继续追问 required 字段。
  if (collection.completeness !== "missingRequiredFields") {
    if (isCollectionStrongConfirmSignal(text)) {
      return { kind: "planCommand", message: "", command: { command: "draftCommit" } }
    }
    if (collection.completeness === "readyToConfirm" && isCollectionConfirmSignal(text)) {
      return { kind: "planCommand", message: "", command: { command: "draftCommit" } }
    }
  }

  const result = reviseDraftCollection(collection, text, state, dateContext.now)

  if (result.status === "cancelled") {
    return { kind: "cancelled", message: composeCollectionCancelledMessage() }
  }

  if (result.status === "forceProposal") {
    // 用户明确要求直接保存（就这样/先保存/直接记下）：直接走 draftCommit，不转 proposal
    return { kind: "planCommand", message: "", command: { command: "draftCommit" } }
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
function handleBatchIntent(text: string, pendingBatch: AgentDraft[], _state: import("../types").AppState, trace?: AgentDecisionTrace): AgentTurn | null {
  const batchIntent = classifyBatchIntent(text)
  if (!batchIntent) return null

  // 批量意图由调用方在 App.tsx 处理（因为涉及 batchDraftStatuses 数组操作）
  // orchestrator 只返回 typed command，不直接执行写入
  if (batchIntent.intent === "batchConfirm") {
    setRouteDecision(trace, "pendingBatch", { rule: "batchConfirm", interceptedByRule: true })
    return { kind: "planCommand", message: "", command: { command: "batchConfirm" } }
  }
  if (batchIntent.intent === "batchCancel") {
    setRouteDecision(trace, "pendingBatch", { rule: "batchCancel", interceptedByRule: true })
    return { kind: "planCommand", message: "", command: { command: "batchCancel" } }
  }
  if (batchIntent.intent === "batchCancelIndex") {
    setRouteDecision(trace, "pendingBatch", { rule: `batchCancelIndex[${batchIntent.index}]`, interceptedByRule: true })
    return { kind: "planCommand", message: "", command: { command: "batchCancelIndex", index: batchIntent.index } }
  }
  if (batchIntent.intent === "batchReviseIndex") {
    setRouteDecision(trace, "pendingBatch", { rule: `batchReviseIndex[${batchIntent.index}]`, interceptedByRule: true })
    return { kind: "planCommand", message: "", command: { command: "batchReviseIndex", index: batchIntent.index } }
  }
  if (batchIntent.intent === "batchReviseAll") {
    setRouteDecision(trace, "pendingBatch", { rule: "batchReviseAll", interceptedByRule: true })
    return { kind: "planCommand", message: "", command: { command: "batchReviseAll" } }
  }
  return null
}

/**
 * 把 LLM 返回的原始内容规范化为 AgentTurn。
 * LLM 输出经过 parseAgentResponse 后，再由 composer 重新生成文案，
 * 不直接采用 LLM 的 message 字段。
 *
 * 阶段 2C+：同时填充 trace.parseResult 与 trace.validationResult，
 * 便于外部 reviewer 判断问题出在 parse 还是 normalize。
 *
 * 阶段 4B.4 重写：
 *   1. parse 失败时优先抢救 answer/message 字段（从残缺 JSON、非标准 JSON、自然语言中提取）
 *   2. 不再因含 { } 一票否决
 *   3. 不再因含写入动词词表否决纯文本（纯文本不会直接写入，没有安全收益）
 *   4. allowedActions 成为代码级硬约束：draft / clarification 不在 allowedActions 内时拒绝写入
 *   5. 旧「超出家务范围」等错误兜底文案被替换成中性管家式回答
 *   6. 不返回 null 给 App.tsx 走 composeBoundaryAnswer(unsupported)
 */

/**
 * 阶段 4B.4：旧错误兜底文案黑名单。
 * 如果 LLM 返回的内容包含这些文案，不原样展示，替换成中性管家式回答。
 */
const FORBIDDEN_ANSWER_PHRASES = [
  "超出家务范围",
  "不太属于我能直接处理的家务范围",
  "不太属于我能直接处理"
]

/** answer 抢救的最大长度（避免把超长 LLM 输出当 answer 吐给用户） */
const SALVAGE_ANSWER_MAX_LENGTH = 2000

/**
 * 从残缺 JSON / 非标准 JSON 中提取 answer / message 字段值。
 *
 * 覆盖场景：
 *   {"kind":"queryAnswer","answer":"目前没有待确认的记录了"}
 *   {"kind":"answer","message":"目前没有待确认的记录了",}
 *   {"answer":"目前没有待确认的记录了"
 *   前后带说明文字的 JSON 片段
 */
function extractAnswerFromJsonLike(content: string): string | null {
  const trimmed = content.trim()
  // 尝试匹配 "answer":"..." 或 "answer": "..."
  // 使用非贪婪匹配，支持转义字符
  const answerMatch = trimmed.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/s)
  if (answerMatch?.[1] !== undefined) {
    return unescapeJsonString(answerMatch[1])
  }
  // 尝试匹配 "message":"..."
  const messageMatch = trimmed.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/s)
  if (messageMatch?.[1] !== undefined) {
    return unescapeJsonString(messageMatch[1])
  }
  return null
}

/** 把 JSON 字符串中的转义序列还原成实际字符 */
function unescapeJsonString(raw: string): string {
  try {
    // 用 JSON.parse 还原转义序列（把 raw 当作字符串内容包在引号里解析）
    return JSON.parse(`"${raw}"`)
  } catch {
    // 解析失败时直接返回原始匹配（已去掉外层引号）
    return raw
  }
}

/**
 * 判断内容是否看起来像 JSON（用于区分"纯文本 answer"和"JSON 但没有 answer/message 字段"）。
 * 如果内容看起来像 JSON 但没有 answer/message，不应把原始 JSON 吐给用户。
 */
function looksLikeJson(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.startsWith("{") && trimmed.includes("}")) return true
  if (/"kind"\s*:/.test(trimmed)) return true
  return false
}

/**
 * 对抢救出来的 answer 文本做污染过滤。
 * - 空文本或超长文本返回 null
 * - 包含旧错误兜底文案时替换成中性管家式回答
 * - 其他情况原样返回
 */
function sanitizeAnswerText(answer: string): string | null {
  const trimmed = answer.trim()
  if (!trimmed) return null
  if (trimmed.length > SALVAGE_ANSWER_MAX_LENGTH) return null
  for (const phrase of FORBIDDEN_ANSWER_PHRASES) {
    if (trimmed.includes(phrase)) {
      return composeParseFailedMessage()
    }
  }
  return trimmed
}

/**
 * 阶段 4B.4：从 LLM 返回内容中抢救 answer。
 *
 * 优先级：
 *   1. 从 JSON-like 内容中提取 answer/message 字段
 *   2. 如果内容看起来像 JSON 但没有 answer/message → 中性兜底（不把原始 JSON 吐给用户）
 *   3. 纯文本（含偶然出现的大括号如「我看到 {抽纸} 这条记录」）→ 作为 answer
 *   4. 包含旧错误兜底文案 → 替换成中性管家式回答
 */
function salvageAnswerFromContent(content: string): string | null {
  const trimmed = content.trim()
  if (!trimmed) return null

  // 1. 尝试从 JSON-like 内容中提取 answer/message
  const jsonAnswer = extractAnswerFromJsonLike(trimmed)
  if (jsonAnswer) {
    return sanitizeAnswerText(jsonAnswer)
  }

  // 2. 内容看起来像 JSON 但没有 answer/message 字段 → 中性兜底
  if (looksLikeJson(trimmed)) {
    return composeParseFailedMessage()
  }

  // 3. 纯文本（含偶然大括号）→ 作为 answer
  return sanitizeAnswerText(trimmed)
}

/**
 * 阶段 4B.4：检查 action 是否被 allowedActions 允许。
 * allowedActions 未提供时（旧测试兼容）允许所有动作。
 */
function isActionAllowed(action: AllowedAction, allowedActions?: AllowedAction[]): boolean {
  if (!allowedActions || allowedActions.length === 0) return true
  return allowedActions.includes(action)
}

/**
 * 阶段 4B.5：把 LLM 返回的 draft 字段 patch 到当前 collection 的 draft 上。
 * 采用「只补缺失字段」语义：当前 collection 已有的字段不被 LLM draft 覆盖。
 * 这防止 LLM 幻觉（如 qty=1）覆盖用户已确认的字段（如 qty=5）。
 * - qty: 当前已有有效值时保留，否则取 LLM 值
 * - unit: 当前已有非空值时保留，否则取 LLM 值
 * - price: 当前已有值时保留，否则取 LLM 值
 * - platform: 当前已有非空值时保留，否则取 LLM 值
 * - review: 当前已有非空值时保留，否则取 LLM 值
 * - restockDate: 当前已有值时保留，否则取 LLM 值
 */
function mergeDraftFields(current: AgentDraft, llmDraft: AgentDraft): AgentDraft {
  if (current.kind === "restock" && llmDraft.kind === "restock") {
    return {
      ...current,
      qty: (current.qty !== undefined && current.qty > 0) ? current.qty : llmDraft.qty,
      unit: current.unit || llmDraft.unit,
      price: current.price !== undefined ? current.price : llmDraft.price,
      platform: current.platform || llmDraft.platform,
      review: current.review || llmDraft.review,
      restockDate: current.restockDate !== undefined ? current.restockDate : llmDraft.restockDate,
      purchaseProductName: current.purchaseProductName || llmDraft.purchaseProductName,
      purchaseMeasureAmount: current.purchaseMeasureAmount !== undefined ? current.purchaseMeasureAmount : llmDraft.purchaseMeasureAmount,
      purchaseMeasureUnit: current.purchaseMeasureUnit || llmDraft.purchaseMeasureUnit,
    }
  }
  if (current.kind === "createItemWithRestock" && llmDraft.kind === "createItemWithRestock") {
    return {
      ...current,
      restock: {
        ...current.restock,
        qty: (current.restock.qty !== undefined && current.restock.qty > 0) ? current.restock.qty : llmDraft.restock.qty,
        unit: current.restock.unit || llmDraft.restock.unit,
        price: current.restock.price !== undefined ? current.restock.price : llmDraft.restock.price,
        platform: current.restock.platform || llmDraft.restock.platform,
        review: current.restock.review || llmDraft.restock.review,
        restockDate: current.restock.restockDate !== undefined ? current.restock.restockDate : llmDraft.restock.restockDate,
        purchaseProductName: current.restock.purchaseProductName || llmDraft.restock.purchaseProductName,
        purchaseMeasureAmount: current.restock.purchaseMeasureAmount !== undefined ? current.restock.purchaseMeasureAmount : llmDraft.restock.purchaseMeasureAmount,
        purchaseMeasureUnit: current.restock.purchaseMeasureUnit || llmDraft.restock.purchaseMeasureUnit,
      }
    }
  }
  // kind 不一致：返回当前 draft，不用 LLM draft 覆盖
  return current
}

function normalizeLlm(content: string, input: OrchestrateInput): AgentTurn | null {
  const trace = input.trace
  const allowedActions = input.allowedActions
  const parsed = parseAgentResponse(content, input.state)

  if (!parsed) {
    // 阶段 4B.4：parse 失败时优先抢救 answer
    const salvagedAnswer = salvageAnswerFromContent(content)
    if (salvagedAnswer) {
      if (trace) {
        trace.parseResult = { ok: false, error: "parse_failed_but_answer_salvaged" }
        trace.validationResult = { passed: true, turnKind: "answer" }
      }
      return { kind: "answer", message: salvagedAnswer }
    }
    // 真正无法抢救 → 返回 null，App.tsx 使用 composeParseFailedMessage 中性兜底
    if (trace) {
      trace.parseResult = { ok: false, error: "parse_failed" }
      trace.validationResult = { passed: false, rejectReason: "normalize_returned_null" }
    }
    return null
  }

  if (parsed.kind === "queryAnswer") {
    // 阶段 4B.7：data-grounded 校验。
    // 如果用户输入涉及已管理物品的补货历史，LLM 答案中出现的事实字段
    // （日期/数量/金额/平台）必须能在 evidenceFacts 里找到。
    // 不一致时拒绝 LLM 答案，改用本地 grounded answer。
    const recordQuery = detectItemRecordQuery(input.text, input.state)
    if (recordQuery) {
      const evidence = extractEvidenceFacts(recordQuery.item)
      const grounding = validateAnswerGrounding(parsed.answer, evidence)
      if (!grounding.grounded) {
        if (trace) {
          trace.parseResult = { ok: true, kind: "queryAnswer" }
          trace.validationResult = { passed: false, rejectReason: "answer_not_grounded" }
          trace.finalDecision = {
            kind: "sync",
            turnKind: "grounded_query_answer",
            message: composeGroundedItemRecordAnswer(recordQuery)
          }
        }
        return { kind: "answer", message: composeGroundedItemRecordAnswer(recordQuery) }
      }
    }
    // queryAnswer 是只读回答，不触发写入，始终允许
    if (trace) {
      trace.parseResult = { ok: true, kind: "queryAnswer" }
      trace.validationResult = { passed: true, turnKind: "answer" }
    }
    return { kind: "answer", message: parsed.answer }
  }
  if (parsed.kind === "clarification") {
    // 阶段 4B.4：clarification 需要通过 allowedActions 校验
    if (!isActionAllowed("clarification", allowedActions)) {
      if (trace) {
        trace.parseResult = { ok: true, kind: "clarification" }
        trace.validationResult = { passed: false, rejectReason: "action_not_allowed" }
      }
      // 降级为 answer：如果有 question 就用 question，否则返回中性兜底
      const answerText = sanitizeAnswerText(parsed.clarification.question)
      if (answerText) {
        return { kind: "answer", message: answerText }
      }
      return { kind: "answer", message: composeParseFailedMessage() }
    }
    if (trace) {
      trace.parseResult = { ok: true, kind: "clarification" }
      trace.validationResult = { passed: true, turnKind: "clarification" }
    }
    return {
      kind: "clarification",
      // LLM 的 question 可以采用，但走 composer 校验是否包含禁用词
      message: parsed.clarification.question,
      options: parsed.clarification.options,
      provisional: parsed.clarification.provisional
    }
  }
  if (parsed.kind === "draft") {
    // 阶段 4B.4：draft 必须通过 allowedActions 代码级硬约束
    if (!isActionAllowed("draft", allowedActions)) {
      if (trace) {
        trace.parseResult = { ok: true, kind: "draft" }
        trace.validationResult = { passed: false, rejectReason: "action_not_allowed" }
      }
      // 不进入 collection/proposal/plan/batch，不修改 pending 状态，不写入数据
      // 如果有 message，降级为 answer
      if (parsed.message) {
        const answerText = sanitizeAnswerText(parsed.message)
        if (answerText) {
          return { kind: "answer", message: answerText }
        }
      }
      return { kind: "answer", message: composeParseFailedMessage() }
    }

    // 阶段 4B.5：pendingCollection 存在时，LLM draft 不能直接覆盖当前 collection。
    // - 如果 LLM draft 的 itemName 与当前 collection 相同 → 合并字段（patch），不创建新 collection
    // - 如果 LLM draft 的 itemName 不同，但用户输入没有明确提到新物品名 → 拒绝写入，转 clarification
    // - 只有用户明确说了新物品名时，才允许创建新 collection（由上层 focusResolver 处理）
    if (input.pendingCollection) {
      const currentItemName = input.pendingCollection.draft.kind === "restock"
        ? input.pendingCollection.draft.itemName
        : input.pendingCollection.draft.kind === "createItemWithRestock"
          ? input.pendingCollection.draft.item.itemName
          : undefined
      const draftItemName = parsed.draft.kind === "restock"
        ? parsed.draft.itemName
        : parsed.draft.kind === "createItemWithRestock"
          ? parsed.draft.item.itemName
          : undefined

      if (currentItemName && draftItemName && draftItemName.trim() === currentItemName.trim()) {
        // ItemName 匹配：把 LLM draft 的字段 patch 到当前 collection，不创建新 collection
        const mergedDraft = mergeDraftFields(input.pendingCollection.draft, parsed.draft)
        if (trace) {
          trace.parseResult = { ok: true, kind: "draft" }
          trace.validationResult = { passed: true, turnKind: "collection_merge" }
        }
        // 用合并后的 draft 重新走 collection/proposal 判断
        if (shouldEnterCollection(mergedDraft, input.text)) {
          return draftToCollection(mergedDraft, input.state, input.itemViews, input.dateContext)
        }
        return draftToProposal(mergedDraft, input.state, input.itemViews)
      }

      // ItemName 不同：用户没有明确提到新物品名时，拒绝 LLM draft 覆盖
      // 转为 clarification，让用户确认是否要切换物品
      if (trace) {
        trace.parseResult = { ok: true, kind: "draft" }
        trace.validationResult = { passed: false, rejectReason: "llm_draft_item_mismatch" }
      }
      return {
        kind: "clarification",
        message: `你刚才在记「${currentItemName ?? ""}」，现在说「${draftItemName ?? ""}」是同一件吗？如果是新物品，再说一遍「今天买了几袋什么」就行。`,
        options: [],
      }
    }

    // 关键：不直接采用 LLM 的 message，由 composer 重新生成
    // 这样保证 LLM 即使文案漂移，最终用户看到的仍是统一管家口吻
    // 补货类草稿字段未齐时同样进采集态，避免 LLM 绕过 collection 直接甩确认卡
    if (shouldEnterCollection(parsed.draft, input.text)) {
      if (trace) {
        trace.parseResult = { ok: true, kind: "draft" }
        trace.validationResult = { passed: true, turnKind: "collection" }
      }
      return draftToCollection(parsed.draft, input.state, input.itemViews, input.dateContext)
    }
    if (trace) {
      trace.parseResult = { ok: true, kind: "draft" }
      trace.validationResult = { passed: true, turnKind: "proposal" }
    }
    return draftToProposal(parsed.draft, input.state, input.itemViews)
  }
  if (trace) {
    trace.parseResult = { ok: true, kind: "unknown" }
    trace.validationResult = { passed: false, rejectReason: "normalize_returned_null" }
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
