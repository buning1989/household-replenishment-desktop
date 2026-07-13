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

import { isCurrentEntryFieldRevision, type TurnInterpretation } from "./turnInterpretation"
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
  | { focus: "query_current_pending"; reason: string; targetField?: "price" | "platform" | "qty" | "status" | "date" | "summary" }
  | { focus: "route_to_navigate"; reason: string }
  | { focus: "report_inventory_status"; reason: string }
  | { focus: "correct_last_mutation"; reason: string }
  | { focus: "undo_last_mutation"; reason: string }

/** focusResolver 的输入：本轮解释 + 只读 pending 上下文。 */
export type FocusResolverInput = {
  interpretation: TurnInterpretation
  /** 原始用户输入文本，用于 isCurrentEntryFieldRevision 等精细判定 */
  text: string
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
  const { interpretation, text, pendingCollection, pendingPlan, pendingDraft, pendingBatch } = input
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
    //    阶段 4B.6 补口：复用共享 helper，与 pendingDraft 仲裁逻辑对齐。
    //    - different_item / explicit_new → start_new_collection（旧 collection 由调用方标 superseded）
    //    - same_item / no_item_name → continue_pending_collection（在原 collection 上叠加字段）
    if (intent === "new_restock_record") {
      const outcome = classifyNewRestockAgainstPending(interpretation, currentItemName)
      const mentioned = interpretation.fields.itemName
      if (outcome === "different_item" || outcome === "explicit_new") {
        return {
          focus: "start_new_collection",
          reason: outcome === "explicit_new"
            ? `含明确新增信号，允许开启新补货采集（当前采集态「${currentItemName}」由调用方标 superseded）`
            : `本轮提到「${mentioned}」与当前采集态「${currentItemName}」不同，视为开启新补货采集`,
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

    // 4. 阶段 4B.6：查询当前待确认草稿的字段（price/platform/qty/status）
    //    直接从 pending 回答，不打断采集态，不新建 collection。
    if (intent === "query_current_pending") {
      return {
        focus: "query_current_pending",
        reason: `查询当前采集态字段：${interpretation.fields.targetField ?? "summary"}`,
        targetField: interpretation.fields.targetField
      }
    }

    // 5. 查询 → 不打断采集态，路由到查询（collection 由调用方保留）
    if (intent === "query_inventory") {
      return {
        focus: "route_to_query",
        reason: "查询意图，不打断当前采集态"
      }
    }

    // 6. 闲聊 → 路由到闲聊（不打断采集态）
    if (intent === "smalltalk") {
      return {
        focus: "route_to_smalltalk",
        reason: "闲聊，不打断当前采集态"
      }
    }

    // 7. 明确的写入类意图（manage_item / manage_budget / delete_request）：
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

    // 8. unknown / batch_revision：不强行开启新任务，交回调用方用旧 collection
    //    处理逻辑兜底字段抽取（如「45块」这类短句价格词被 interpretUserTurn 判为 unknown，
    //    但旧 reviseDraftCollection 能抽出 price）。具体能否抽出字段由调用方决定。
    return {
      focus: "route_to_llm",
      reason: `本轮意图「${intent}」无法明确归类，交回调用方按旧 collection 逻辑兜底或交 LLM`
    }
  }

  // ---------- c. pendingBatch ----------
  // 阶段 3C：pendingBatch 接入 focusResolver。
  // 确认 / 取消 / 强制保存 / 批量修订 → 继续当前 batch（交原 batch handler 执行）。
  // 新补货记录 / 查询 / 闲聊 / 低置信 → 不继续 batch，落到下方路由。
  // 关键修复：新补货记录不再被旧 batch handler 吞掉，旧 batch 由 App.tsx 标 superseded。
  if (pendingBatch && pendingBatch.length > 0) {
    if (
      intent === "confirm_current_task" ||
      intent === "cancel_current_task" ||
      intent === "force_proposal" ||
      intent === "batch_revision"
    ) {
      return {
        focus: "continue_pending_batch",
        reason: batchContinueReason(intent)
      }
    }
    // 其他意图（新补货记录 / 查询 / 闲聊 / 删除 / 物品管理）落到下方路由。
    // 新补货记录会由 hasActivePending 分支返回 start_new_collection，
    // 旧 pendingBatch 由 App.tsx collection turn handler 标 superseded。
  }

  // ---------- d. pendingDraft ----------
  // 阶段 3B：新增 force_proposal 匹配（与 pendingPlan 阶段 3A 一致）。
  // 「确认吧」「就这样」在 interpretUserTurn 中被判为 force_proposal，
  // 但在 pendingDraft 上下文中应视为确认当前 draft（force_proposal 仅在
  // pendingCollection 上下文中才表示「强制保存采集态」）。
  //
  // 阶段 4B.6：pendingDraft 同物品仲裁 + query_current_pending。
  // - new_restock_record + 同物品 + 无明确新增信号 → continue_pending_draft（走 revise）
  // - new_restock_record + 不同物品 或 明确新增信号 → start_new_collection
  // - query_current_pending → 直接从 pending 回答字段
  if (pendingDraft) {
    if (
      intent === "confirm_current_task" ||
      intent === "cancel_current_task" ||
      intent === "force_proposal"
    ) {
      return {
        focus: "continue_pending_draft",
        reason: draftContinueReason(intent)
      }
    }

    // 阶段 4B.6 补口：supplement_current_collection 在 pendingDraft 上下文中视为修订当前草稿。
    // LLM Turn Interpreter 返回 supplement 时（如「p'd'd 买的」→ platform=拼多多），
    // 应走 continue_pending_draft 交 reviseAgentDraft 修订字段，而不是 route_to_llm。
    if (intent === "supplement_current_collection") {
      return {
        focus: "continue_pending_draft",
        reason: `补充字段，视为修订当前待确认草稿${describeFields(interpretation)}`
      }
    }

    // 阶段 4B.6：查询当前待确认草稿的字段（price/platform/qty/status）
    if (intent === "query_current_pending") {
      return {
        focus: "query_current_pending",
        reason: `查询当前待确认草稿字段：${interpretation.fields.targetField ?? "summary"}`,
        targetField: interpretation.fields.targetField
      }
    }

    // 阶段 4B.6 补口：pendingDraft 同物品仲裁，复用共享 helper。
    // - same_item → continue_pending_draft（走 revise 修订字段）
    // - different_item → 落到下方 hasActivePending 分支返回 start_new_collection
    // - explicit_new → 落到下方 hasActivePending 分支返回 start_new_collection
    // - no_item_name → route_to_llm（低置信，draft 态无 collection 的字段叠加能力，
    //   不允许 start_new_collection 覆盖 pending，交 LLM 结合 pendingDraft 判断）
    if (intent === "new_restock_record") {
      const draftItemName = extractDraftItemName(pendingDraft)
      const outcome = classifyNewRestockAgainstPending(interpretation, draftItemName)
      const mentioned = interpretation.fields.itemName
      if (outcome === "same_item") {
        return {
          focus: "continue_pending_draft",
          reason: `本轮提到「${mentioned}」与当前待确认草稿「${draftItemName}」一致，视为修订当前草稿字段`
        }
      }
      if (outcome === "no_item_name") {
        return {
          focus: "route_to_llm",
          reason: `new_restock_record 低置信（未抽出物品名），draft 态不允许直接覆盖，交 LLM 结合 pendingDraft 判断`
        }
      }
      // different_item / explicit_new：落到下方 hasActivePending 分支返回 start_new_collection
    }
    // 其他意图（查询 / 闲聊 / 删除 / 物品管理）落到下方路由。
    // 关键修复：新补货记录不再被旧 draft handler 的 reviseDraft 吞掉，
    // 而是走到下方 hasActivePending 分支返回 start_new_collection。
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

  // 能力收缩：管理类意图（删除 / 物品管理 / 预算管理）不再进入写入流程。
  //   - 不创建 pendingPlan
  //   - 不写入 state
  //   - 不进入二次确认
  //   - 只定位对象并导航到对应 UI
  //   - 不影响当前 pending 状态（导航是只读回答）
  //
  // 例外（403 收窄）：有活跃 pending 时，仅当文本命中 isCurrentEntryFieldRevision
  //      （即只修订当前录入草稿的字段：物品名/数量/单位/金额/平台/日期/订单商品信息），
  //      才允许进入修订链路。其他管理类请求（周期/提醒/分类/预算/历史记录/常购商品/默认商品/删除）
  //      无论是否有 pending，都只能导航。
  if (
    intent === "manage_budget" ||
    intent === "delete_request" ||
    (intent === "manage_item" && !isCurrentEntryFieldRevision(text))
  ) {
    return {
      focus: "route_to_navigate",
      reason: `管理类意图「${intent}」已关闭对话执行，路由到导航回答（定位不执行）`
    }
  }

  // 403：库存状态报告——用户陈述当前库存状态，进入校准流程
  if (intent === "report_inventory_status") {
    return {
      focus: "report_inventory_status",
      reason: "库存状态报告，进入校准流程"
    }
  }

  // 403：最近一次 Agent 写入的纠错和撤销
  if (intent === "undo_last_mutation") {
    return {
      focus: "undo_last_mutation",
      reason: "请求撤销最近一次 Agent 写入"
    }
  }
  if (intent === "correct_last_mutation") {
    return {
      focus: "correct_last_mutation",
      reason: "请求修正最近一次 Agent 写入的字段"
    }
  }

  // 写入类意图：新补货记录 / 创建消耗品 / 批量修订 / 有 pending 时的当前草稿字段修订
  //   注意：manage_item 已在上方通过 isCurrentEntryFieldRevision 筛选——
  //   只有录入字段修订（如「改成 3 袋」「金额改成 78」）才到达这里，
  //   周期/提醒/分类/预算/历史记录等管理类已被路由到导航。
  //
  // 403 修复：create_item 必须路由到 writeDraft——buildLocalDraftFromText 内部会先做
  //   显式 createItem 信号 + 已存在物品去重（返回 null），由 orchestrator 生成
  //   alreadyExists/navigate turn；不存在才生成 createItem 待确认草稿。若不路由到
  //   writeDraft，create_item 会落到 LLM 兜底，已存在物品时无法返回 navigate。
  if (
    intent === "new_restock_record" ||
    intent === "create_item" ||
    intent === "batch_revision" ||
    (hasActivePending && intent === "manage_item" && isCurrentEntryFieldRevision(text))
  ) {
    if (hasActivePending) {
      // 阶段 4B.6 补口：low confidence new_restock_record 不得 start_new_collection。
      // 覆盖 pending 是半破坏性操作，必须有明确分歧证据（高置信不同物品名或显式新增信号）。
      // 低置信（无 itemName）只能升级 interpreter 或澄清，禁止直接覆盖。
      if (intent === "new_restock_record" && interpretation.confidence === "low") {
        return {
          focus: "route_to_llm",
          reason: "低置信 new_restock_record（无明确物品名），不允许覆盖当前 pending，交 LLM 澄清"
        }
      }
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

  // 阶段 4B.6：query_current_pending 在无 pendingDraft/pendingCollection 时
  //（如 pendingPlan/pendingBatch 活跃，或无 pending）→ route_to_llm 兜底
  if (intent === "query_current_pending") {
    return {
      focus: "route_to_llm",
      reason: "query_current_pending 但无 pendingDraft/pendingCollection 可查，交 LLM 兜底"
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

/**
 * 阶段 4B.6 补口：new_restock_record 与当前 pending 的物品名比对结果。
 * pendingCollection 和 pendingDraft 共用此判定，保证同物品仲裁逻辑一致。
 */
export type NewRestockArbitrationOutcome =
  | "same_item"
  | "different_item"
  | "explicit_new"
  | "no_item_name"

/**
 * 把 new_restock_record 与当前 pending 的物品名做结构化比对。
 *
 * 判定规则：
 *   - hasExplicitNewRecord（又买了/另外买了/还买了/重新记一条）→ explicit_new
 *   - 有明确 itemName 且与当前 pending 物品名不同 → different_item
 *   - 有明确 itemName 且与当前 pending 物品名相同 → same_item
 *   - 无明确 itemName（低置信）→ no_item_name
 */
export function classifyNewRestockAgainstPending(
  interpretation: TurnInterpretation,
  currentItemName: string | undefined
): NewRestockArbitrationOutcome {
  const mentioned = interpretation.fields.itemName
  const hasExplicitNew = interpretation.signals.hasExplicitNewRecord === true

  if (hasExplicitNew) return "explicit_new"

  if (mentioned && currentItemName) {
    return mentioned.trim() === currentItemName.trim()
      ? "same_item"
      : "different_item"
  }

  // 无明确 itemName（低置信 fallback）
  return "no_item_name"
}

/** 取出当前 collection 草稿对应的物品名。 */
function extractCollectionItemName(collection: DraftCollection): string | undefined {
  const draft = collection.draft
  if (draft.kind === "restock") return draft.itemName
  if (draft.kind === "createItemWithRestock") return draft.item.itemName
  return undefined
}

/** 阶段 4B.6：取出 pendingDraft 对应的物品名。 */
function extractDraftItemName(draft: AgentDraft): string | undefined {
  if (draft.kind === "restock") return draft.itemName
  if (draft.kind === "createItemWithRestock") return draft.item.itemName
  if (draft.kind === "createItem") return draft.itemName
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

/**
 * 生成 continue_pending_draft 的 reason（阶段 3B）。
 * force_proposal 在 pendingDraft 上下文中视为确认当前 draft。
 */
function draftContinueReason(intent: TurnInterpretation["intent"]): string {
  if (intent === "cancel_current_task") {
    return "命中取消信号，继续当前 pending draft 的取消流程"
  }
  if (intent === "force_proposal") {
    return "命中强制保存信号，在 pendingDraft 上下文中视为确认当前 draft"
  }
  return "命中确认信号，继续当前 pending draft 的确认流程"
}

/**
 * 生成 continue_pending_batch 的 reason（阶段 3C）。
 * force_proposal 在 pendingBatch 上下文中视为确认当前 batch。
 */
function batchContinueReason(intent: TurnInterpretation["intent"]): string {
  if (intent === "cancel_current_task") {
    return "命中取消信号，继续当前 pending batch 的取消流程"
  }
  if (intent === "force_proposal") {
    return "命中强制保存信号，在 pendingBatch 上下文中视为确认当前 batch"
  }
  if (intent === "batch_revision") {
    return "命中批量修订信号，继续当前批量待确认方案"
  }
  return "命中确认信号，继续当前 pending batch 的确认流程"
}
