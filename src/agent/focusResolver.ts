/**
 * Focus Resolver：结合 TurnInterpretation 与当前 pending 状态，判断这一轮输入的「对话焦点」。
 *
 * 设计目标（阶段 2A）：
 *   1. 只回答「这一轮应聚焦在哪个任务上」，不执行任何 action，不调用 executor，
 *      不生成 UI message，不接入 decideSync。
 *   2. 纯函数：不读 state、不调 LLM、不修改任何 pending 状态。
 *      输入只有 interpretation + 四种 pending 上下文（只读）。
 *   3. 决策优先级与 decideSync 对齐，便于阶段 2B 接入时 1:1 替换：
 *        a. pendingPlan（pending / awaitingSecondConfirm）
 *        b. pendingCollection
 *        c. pendingBatch
 *        d. pendingDraft
 *        e. 无 pending → 路由到 writeDraft / query / smalltalk / llm
 *   4. 关键修正点（修复 decideSync 旧 collection「串物品」bug 的前置判断）：
 *        - pendingCollection + new_restock_record 且本轮提到的物品名 ≠ 当前 collection 物品名
 *          → start_new_collection（旧 collection 由调用方标 superseded）
 *        - pendingCollection + new_restock_record 且物品名相同 → continue_pending_collection
 *   5. 关键保护点（高风险删除不应被新操作触发执行）：
 *        - pendingPlan + new_restock_record / query / smalltalk 等非确认意图
 *          → start_new_collection / route_to_query / route_to_smalltalk（绝不返回 continue_pending_plan）
 *        - 二次确认删除 / 普通确认 / 取消 → continue_pending_plan（具体执行仍由原二次确认状态机决定）
 *
 * 本文件不修改任何现有行为，只是阶段 2B 路由层的纯输入。
 */

import type { TurnInterpretation } from "./turnInterpretation"
import type { DraftCollection } from "./draftCollection"
import type { AgentDraft } from "./drafts"
import type { AgentPlan } from "./actions"

/**
 * 对话焦点决策。下游（阶段 2B 的 agentRouter）据此分发到对应 handler。
 * 本类型只描述「聚焦在哪个任务」，不携带执行细节。
 */
export type FocusDecision =
  | { focus: "continue_pending_collection"; reason: string; mentionedDifferentItem?: boolean }
  | { focus: "correct_pending_collection"; reason: string }
  | { focus: "continue_pending_plan"; reason: string }
  | { focus: "continue_pending_batch"; reason: string }
  | { focus: "continue_pending_draft"; reason: string }
  | { focus: "start_new_collection"; reason: string; mentionedDifferentItem?: boolean }
  | { focus: "route_to_write_draft"; reason: string }
  | { focus: "route_to_query"; reason: string }
  | { focus: "route_to_smalltalk"; reason: string }
  | { focus: "route_to_llm"; reason: string }

/** focusResolver 的输入：本轮解释 + 只读 pending 上下文。 */
export type FocusResolverInput = {
  interpretation: TurnInterpretation
  pendingCollection?: DraftCollection
  pendingPlan?: AgentPlan
  pendingDraft?: AgentDraft
  pendingBatch?: AgentDraft[]
}

/**
 * 判定这一轮输入应聚焦在哪个任务上。
 *
 * 返回 FocusDecision。不执行任何 action，不生成文案，不修改 pending。
 */
export function resolveConversationFocus(input: FocusResolverInput): FocusDecision {
  const { interpretation, pendingCollection, pendingPlan, pendingDraft, pendingBatch } = input
  const intent = interpretation.intent

  // ---------- a. pendingPlan 优先 ----------
  // 仅 pending / awaitingSecondConfirm 状态的 plan 是活跃的。
  if (pendingPlan && (pendingPlan.status === "pending" || pendingPlan.status === "awaitingSecondConfirm")) {
    // 确认 / 二次确认删除 / 取消 / 强制保存信号 → 继续当前 plan
    // 注意：「确认吧」「就这样」在 interpretUserTurn 中被判为 force_proposal，
    // 但在 pendingPlan 上下文中应视为确认当前 plan（force_proposal 仅在
    // pendingCollection 上下文中才表示「强制保存采集态」）。
    // 具体执行/推进/取消由原状态机决定，二次确认删除约束不被绕过。
    if (
      intent === "confirm_current_task" ||
      intent === "cancel_current_task" ||
      intent === "force_proposal"
    ) {
      return {
        focus: "continue_pending_plan",
        reason: planContinueReason(intent, pendingPlan, interpretation)
      }
    }
    // 其他意图（新补货记录 / 查询 / 闲聊 / 删除新请求 / 物品管理 / 预算 …）
    // 一律不继续当前 plan，落到下方路由。
    // 高风险删除 plan 在 awaitingSecondConfirm 下尤其不能因新操作而执行。
  }

  // ---------- b. pendingCollection ----------
  if (pendingCollection) {
    const currentItemName = extractCollectionItemName(pendingCollection)

    // 1. 显式修正「不是 X，是 Y」→ 修正当前 collection 的物品名
    if (intent === "correct_current_collection") {
      return {
        focus: "correct_pending_collection",
        reason: `显式修正当前采集态物品名${currentItemName ? `（原 ${currentItemName} → ${interpretation.fields.itemName ?? "?"}）` : ""}`
      }
    }

    // 2. 字段补充 / 强制保存 / 确认 / 取消 → 继续当前 collection
    if (
      intent === "supplement_current_collection" ||
      intent === "force_proposal" ||
      intent === "confirm_current_task" ||
      intent === "cancel_current_task"
    ) {
      return {
        focus: "continue_pending_collection",
        reason: collectionContinueReason(intent, interpretation)
      }
    }

    // 3. 新补货记录：判断是否「串物品」
    //    - 本轮物品名 ≠ 当前 collection 物品名 → start_new_collection（旧 collection 由调用方标 superseded）
    //    - 物品名相同或无法判断 → continue_pending_collection（在原 collection 上叠加字段）
    if (intent === "new_restock_record") {
      const mentioned = interpretation.fields.itemName
      const different = Boolean(
        mentioned && currentItemName && mentioned.trim() !== currentItemName.trim()
      )
      if (different) {
        return {
          focus: "start_new_collection",
          reason: `本轮提到「${mentioned}」与当前采集态「${currentItemName}」不同，视为开启新补货采集`,
          mentionedDifferentItem: true
        }
      }
      return {
        focus: "continue_pending_collection",
        reason: mentioned
          ? `本轮提到「${mentioned}」与当前采集态物品名一致，继续补充字段`
          : "本轮含购买动词但未抽出物品名，继续当前采集态",
        mentionedDifferentItem: false
      }
    }

    // 4. 查询 → 不打断采集态，路由到查询（collection 由调用方保留）
    if (intent === "query_inventory") {
      return {
        focus: "route_to_query",
        reason: "查询意图，不打断当前采集态"
      }
    }

    // 5. 闲聊 → 路由到闲聊（不打断采集态）
    if (intent === "smalltalk") {
      return {
        focus: "route_to_smalltalk",
        reason: "闲聊，不打断当前采集态"
      }
    }

    // 6. 明确的写入类意图（manage_item / manage_budget / delete_request）：
    //    与当前采集态不相关，开启新任务，旧 collection 由调用方标 superseded。
    if (
      intent === "manage_item" ||
      intent === "manage_budget" ||
      intent === "delete_request"
    ) {
      return {
        focus: "start_new_collection",
        reason: `本轮意图「${intent}」与当前采集态不相关，开启新写入任务`
      }
    }

    // 7. unknown / batch_revision：不强行开启新任务，交回调用方用旧 collection
    //    处理逻辑兜底字段抽取（如「45块」这类短句价格词被 interpretUserTurn 判为 unknown，
    //    但旧 reviseDraftCollection 能抽出 price）。具体能否抽出字段由调用方决定。
    return {
      focus: "route_to_llm",
      reason: `本轮意图「${intent}」无法明确归类，交回调用方按旧 collection 逻辑兜底或交 LLM`
    }
  }

  // ---------- c. pendingBatch ----------
  if (pendingBatch && pendingBatch.length > 0) {
    if (intent === "batch_revision") {
      return {
        focus: "continue_pending_batch",
        reason: "命中批量修订信号，继续当前批量待确认方案"
      }
    }
    // 非 batch 意图落到下方路由（查询 / 新写入 / LLM）
  }

  // ---------- d. pendingDraft ----------
  if (pendingDraft) {
    if (
      intent === "confirm_current_task" ||
      intent === "cancel_current_task"
    ) {
      return {
        focus: "continue_pending_draft",
        reason: `命中${intent === "confirm_current_task" ? "确认" : "取消"}信号，继续当前 pending draft`
      }
    }
    // 其他意图落到下方路由（新写入 / 查询 / LLM）
  }

  // ---------- e. 路由 ----------
  // 若仍有活跃 pending（pendingPlan / pendingCollection / pendingBatch / pendingDraft 任一），
  // 写入类意图应返回 start_new_collection，提示调用方把旧 pending 标 superseded 再开新采集；
  // 无活跃 pending 时才直接 route_to_write_draft。
  const hasActivePending =
    (pendingPlan && (pendingPlan.status === "pending" || pendingPlan.status === "awaitingSecondConfirm")
      ? true : false) ||
    Boolean(pendingCollection) ||
    (pendingBatch && pendingBatch.length > 0 ? true : false) ||
    Boolean(pendingDraft)

  // 写入类意图：新补货记录 / 物品管理 / 预算管理 / 删除请求 / 批量修订
  if (
    intent === "new_restock_record" ||
    intent === "manage_item" ||
    intent === "manage_budget" ||
    intent === "delete_request" ||
    intent === "batch_revision"
  ) {
    if (hasActivePending) {
      return {
        focus: "start_new_collection",
        reason: `本轮意图「${intent}」与当前 pending 任务不相关，开启新写入任务（旧 pending 由调用方标 superseded）`
      }
    }
    return {
      focus: "route_to_write_draft",
      reason: `本轮意图「${intent}」，路由到写入流程（collection / proposal / planProposal）`
    }
  }

  // 查询
  if (intent === "query_inventory") {
    return {
      focus: "route_to_query",
      reason: "查询意图，路由到查询回答"
    }
  }

  // 闲聊 / 身份
  if (intent === "smalltalk") {
    return {
      focus: "route_to_smalltalk",
      reason: "闲聊或身份类，本地自然回应"
    }
  }

  // 兜底：显式修正 / 强制保存 / 确认 / 取消 在无 pending 时无对象可作用，交 LLM 兜底
  return {
    focus: "route_to_llm",
    reason: `意图「${intent}」无对应 pending 任务可作用，交 LLM 兜底`
  }
}

// ---------- 辅助 ----------

/** 取出当前 collection 草稿对应的物品名。 */
function extractCollectionItemName(collection: DraftCollection): string | undefined {
  const draft = collection.draft
  if (draft.kind === "restock") return draft.itemName
  if (draft.kind === "createItemWithRestock") return draft.item.itemName
  return undefined
}

/** 生成 continue_pending_plan 的 reason。 */
function planContinueReason(
  intent: TurnInterpretation["intent"],
  plan: AgentPlan,
  interpretation: TurnInterpretation
): string {
  if (intent === "confirm_current_task") {
    if (interpretation.signals.hasDeleteSignal) {
      return "命中二次确认删除短语，继续当前 plan 的二次确认删除流程"
    }
    const isHighRisk = plan.requiresSecondConfirm === true || plan.risk === "high"
    return isHighRisk
      ? "命中确认信号，继续当前高风险 plan（推进到二次确认，不直接执行）"
      : "命中确认信号，继续当前 plan 的确认流程"
  }
  return "命中取消信号，继续当前 plan 的取消流程"
}

/** 生成 continue_pending_collection 的 reason。 */
function collectionContinueReason(
  intent: TurnInterpretation["intent"],
  interpretation: TurnInterpretation
): string {
  switch (intent) {
    case "supplement_current_collection":
      return `补充字段${describeFields(interpretation)}`
    case "force_proposal":
      return "命中强制保存信号，当前采集态直接转 proposal（带未补全标记）"
    case "confirm_current_task":
      return "命中确认信号，当前采集态转 proposal 走确认链路"
    case "cancel_current_task":
      return "命中取消信号，撤回当前采集态"
    default:
      return "继续当前采集态"
  }
}

function describeFields(interpretation: TurnInterpretation): string {
  const f = interpretation.fields
  const parts: string[] = []
  if (f.platform) parts.push(`平台=${f.platform}`)
  if (f.price !== undefined) parts.push(`价格=${f.price}`)
  if (f.review) parts.push(`评价=${f.review}`)
  if (f.quantity !== undefined) parts.push(`数量=${f.quantity}${f.unit ?? ""}`)
  if (f.date !== undefined) parts.push(`日期=${f.date}`)
  return parts.length > 0 ? `（${parts.join("，")}）` : ""
}
