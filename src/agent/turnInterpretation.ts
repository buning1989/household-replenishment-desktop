/**
 * Turn Interpretation：把用户每一轮输入先解释成结构化 TurnInterpretation。
 *
 * 设计目标（阶段 1）：
 *   1. 它只回答「用户这一轮到底说了什么」，不负责执行，也不负责写入。
 *   2. 它是纯函数：不调用 LLM、不修改 state、不依赖 pending 状态。
 *      pending 状态的仲裁由后续的 focusResolver 负责（阶段 2 引入）。
 *   3. 复用现有 drafts / intent / draftCollection / conversationBoundary 的抽取与识别逻辑，
 *      不重写 itemName/qty/price 等解析，也不为单个物品名写特判。
 *   4. 本文件不接入 decideSync，不替代任何现有 handler；它只是一个新的解释层，
 *      供阶段 2 的路由层（routeByFocusDecision）消费。
 *
 * 判定优先级（高 → 低）：
 *   1. 二次确认删除短语（确认删除/删除吧）→ confirm_current_task（带 hasDeleteSignal）
 *   2. 删除请求（删除/删掉/不再管理/清空…）→ delete_request
 *   3. 显式修正「不是 X，是 Y」→ correct_current_collection
 *   4. 强制保存信号（就这样/先保存）→ force_proposal
 *   5. 取消信号（算了/取消/不记了）→ cancel_current_task
 *   6. 确认信号（确认/可以/好的）→ confirm_current_task
 *   7. 完整新补货记录（购买动词 + 数量单位 + 物品名）→ new_restock_record
 *   8. 批量修订信号（第 N 个 / 都改成）→ batch_revision
 *   9. 预算管理（预算设/月预算）→ manage_budget
 *   10. 物品管理（添加/新建/改/重命名/移动/周期…）→ manage_item
 *   11. 短句字段补充（纯数字/平台/日期/评价/数量）→ supplement_current_collection
 *   12. 查询（还能用多久/花了多少钱/哪些快没了）→ query_inventory
 *   13. 闲聊/身份（你好/你是谁/哈哈）→ smalltalk
 *   14. 兜底 → unknown
 *
 * 注意：删除请求必须在新补货记录之前判定，避免「删除猫砂」被「猫砂」带入 new_restock。
 */

import {
  buildLocalDraftFromText,
  parseItemNameRevision,
  parsePlatform,
  parseQty,
  parseNaturalDate,
  extractReviewText,
  type AgentDraft
} from "./drafts"
import { classifyAgentIntent, classifyBatchIntent, isSecondConfirmMatch } from "./intent"
import { isCancelCollectionSignal, isForceProposalSignal } from "./draftCollection"
import { classifyConversationBoundary } from "./conversationBoundary"
import type { AppState } from "../types"
import type { ChatDateContext, HouseholdChatItemView } from "../llm/householdChat"

export type TurnIntent =
  | "new_restock_record"
  | "supplement_current_collection"
  | "correct_current_collection"
  | "confirm_current_task"
  | "cancel_current_task"
  | "force_proposal"
  | "query_inventory"
  | "manage_item"
  | "manage_budget"
  | "delete_request"
  | "batch_revision"
  | "smalltalk"
  | "unknown"

export type TurnInterpretation = {
  intent: TurnIntent

  fields: {
    itemName?: string
    categoryName?: string
    quantity?: number
    unit?: string
    date?: number
    price?: number
    platform?: string
    spec?: string
    review?: string
  }

  signals: {
    hasPurchaseVerb: boolean
    hasExplicitCorrection: boolean
    hasConfirmSignal: boolean
    hasCancelSignal: boolean
    hasDeleteSignal: boolean
    hasOnlyShortField: boolean
    /** 当前输入提到的物品名是否与 pendingCollection 不同；阶段 1 无 pending 状态，留给 focusResolver 填充 */
    mentionedDifferentItem?: boolean
  }

  confidence: "high" | "medium" | "low"
  reason: string
}

/** 购买动词：用于识别「完整新补货记录」意图。 */
const PURCHASE_VERB_PATTERN = /买了|买的|下单|购入|入手|囤了|续上|补了|补货了|收货了|快递到了|记一下|记录一下|记一笔/

/** 删除请求关键词。与 planner 的删除 parser 对齐，但不包含「去掉」以免误吞字段修订。 */
const DELETE_REQUEST_PATTERN = /删除|删掉|移除|清空|不再管理|不再管/

/** 预算管理关键词。 */
const BUDGET_KEYWORD_PATTERN = /预算设|预算改|预算调成|月预算|预算调/

/** 物品管理关键词：建档 + 编辑类。 */
const MANAGE_ITEM_KEYWORD_PATTERN =
  /添加|新建|创建|录入|登记|帮我加|加一个|加个|加入清单|以后提醒|帮我管|改成|改为|改名为|改叫|重命名|移到|归到|归入|放到|单位改|单位设|按包记|按瓶记|按袋记|提前|快用完前|默认商品设|设为默认|设成默认|周期改|周期设|周期调成|补货周期/

/** 闲聊/问候。conversationBoundary 不覆盖「你好」等问候，这里补一层。 */
const GREETING_PATTERN = /你好|您好|嗨|早上好|晚上好|下午好|早呀|哈喽|^hello$|^hi$/i

/** 查询类疑问关键词。 */
const QUESTION_PATTERN =
  /还能用多久|还能撑多久|还能用|还剩多少|还剩|剩多少|剩几|快没|还有多少|还有.*吗|花了多少钱|多少钱|哪些|哪个|哪一些|几条|几包|几瓶|几袋|多少|吗$|怎么|什么/

/** 短句最大长度：超过则不视为短句字段补充。 */
const SHORT_FIELD_MAX_LENGTH = 6

/** 纯数字（含全角、小数）。 */
const PURE_NUMBER_PATTERN = /^[0-9０-９]+(?:\.[0-9０-９]+)?$/

/** 把一句话压成只含中文/字母数字的紧凑串，便于关键词匹配。与 intent.ts 的 compact 对齐。 */
function compact(value: string): string {
  return value.trim().replace(/[\s，。！？、,.!?]/g, "")
}

/** 从 restock/createItem/createItemWithRestock 草稿中抽取可解释字段。 */
function extractFieldsFromDraft(draft: AgentDraft): TurnInterpretation["fields"] {
  const fields: TurnInterpretation["fields"] = {}
  if (draft.kind === "restock") {
    fields.itemName = draft.itemName
    if (draft.qty !== undefined) fields.quantity = draft.qty
    if (draft.unit) fields.unit = draft.unit
    if (draft.price !== undefined) fields.price = draft.price
    if (draft.platform) fields.platform = draft.platform
    if (draft.review) fields.review = draft.review
    if (draft.restockDate !== undefined) fields.date = draft.restockDate
    if (draft.purchaseMeasureAmount !== undefined && draft.purchaseMeasureUnit) {
      fields.spec = `${draft.purchaseMeasureAmount}${draft.purchaseMeasureUnit}`
    }
  } else if (draft.kind === "createItemWithRestock") {
    fields.itemName = draft.item.itemName
    if (draft.restock.qty !== undefined) fields.quantity = draft.restock.qty
    if (draft.restock.unit) fields.unit = draft.restock.unit
    if (draft.restock.price !== undefined) fields.price = draft.restock.price
    if (draft.restock.platform) fields.platform = draft.restock.platform
    if (draft.restock.review) fields.review = draft.restock.review
    if (draft.restock.restockDate !== undefined) fields.date = draft.restock.restockDate
    if (draft.restock.purchaseMeasureAmount !== undefined && draft.restock.purchaseMeasureUnit) {
      fields.spec = `${draft.restock.purchaseMeasureAmount}${draft.restock.purchaseMeasureUnit}`
    }
  } else if (draft.kind === "createItem") {
    fields.itemName = draft.itemName
    if (draft.unit) fields.unit = draft.unit
  }
  return fields
}

/**
 * 解释用户这一轮输入。纯函数：不调用 LLM、不修改 state、不读取 pending 状态。
 *
 * 输入只含本轮 text + 当前只读上下文（state / itemViews / dateContext）。
 * 是否继续旧 pending 任务由 focusResolver 在阶段 2 决定。
 */
export function interpretUserTurn(input: {
  text: string
  state: AppState
  itemViews: HouseholdChatItemView[]
  dateContext: ChatDateContext
}): TurnInterpretation {
  const { text, state, dateContext } = input
  const normalized = compact(text)
  const hasText = normalized.length > 0

  // 预计算共享信号
  const hasPurchaseVerb = PURCHASE_VERB_PATTERN.test(normalized)
  const itemNameRevision = parseItemNameRevision(text)
  const hasExplicitCorrection = Boolean(itemNameRevision)
  const isForceProposal = isForceProposalSignal(text)
  const isCancel = isCancelCollectionSignal(text)
  const isSecondConfirm = isSecondConfirmMatch(text)
  const hasDeleteSignal = DELETE_REQUEST_PATTERN.test(normalized) || isSecondConfirm
  const isConfirmDraft = classifyAgentIntent(text, true) === "confirmDraft"
  const hasConfirmSignal = isSecondConfirm || isConfirmDraft || isForceProposal
  const hasCancelSignal = isCancel

  const baseSignals = {
    hasPurchaseVerb,
    hasExplicitCorrection,
    hasConfirmSignal,
    hasCancelSignal,
    hasDeleteSignal,
    hasOnlyShortField: false
  }

  if (!hasText) {
    return {
      intent: "unknown",
      fields: {},
      signals: baseSignals,
      confidence: "low",
      reason: "输入为空"
    }
  }

  // 1. 二次确认删除短语：在删除请求之前判定，避免「确认删除」被当成新删除请求
  if (isSecondConfirm) {
    return {
      intent: "confirm_current_task",
      fields: {},
      signals: { ...baseSignals, hasDeleteSignal: true, hasConfirmSignal: true },
      confidence: "high",
      reason: "命中二次确认删除短语，视为对当前高风险删除任务的确认"
    }
  }

  // 2. 删除请求：必须在新补货之前，避免「删除猫砂」被物品名带入 new_restock
  if (DELETE_REQUEST_PATTERN.test(normalized)) {
    return {
      intent: "delete_request",
      fields: {},
      signals: baseSignals,
      confidence: "high",
      reason: "命中删除请求关键词，删除类只能进入 AgentPlan 并保留二次确认"
    }
  }

  // 3. 显式修正「不是 X，是 Y」
  if (hasExplicitCorrection && itemNameRevision) {
    return {
      intent: "correct_current_collection",
      fields: { itemName: itemNameRevision.to },
      signals: baseSignals,
      confidence: "high",
      reason: `命中显式修正「不是 X，是 Y」，目标物品名：${itemNameRevision.to}`
    }
  }

  // 4. 强制保存信号
  if (isForceProposal) {
    return {
      intent: "force_proposal",
      fields: {},
      signals: baseSignals,
      confidence: "high",
      reason: "用户明确要求直接保存当前采集态"
    }
  }

  // 5. 取消信号
  if (isCancel) {
    return {
      intent: "cancel_current_task",
      fields: {},
      signals: baseSignals,
      confidence: "high",
      reason: "命中取消信号，撤回当前 pending 任务"
    }
  }

  // 6. 确认信号（普通「确认/可以/好的」）
  if (isConfirmDraft) {
    return {
      intent: "confirm_current_task",
      fields: {},
      signals: baseSignals,
      confidence: "high",
      reason: "命中确认信号"
    }
  }

  // 7. 完整新补货记录：购买动词 + 本地草稿能抽出 itemName
  //    复用 buildLocalDraftFromText 抽取 itemName/qty/unit/price/platform/spec/review/date
  if (hasPurchaseVerb) {
    const draft = buildLocalDraftFromText(text, state)
    if (draft && (draft.kind === "restock" || draft.kind === "createItemWithRestock")) {
      const fields = extractFieldsFromDraft(draft)
      if (fields.itemName) {
        return {
          intent: "new_restock_record",
          fields,
          signals: baseSignals,
          confidence: fields.quantity !== undefined ? "high" : "medium",
          reason: `购买动词 + 物品名「${fields.itemName}」+ 数量单位，视为新补货记录`
        }
      }
    }
    // 购买动词命中但本地解析不出 itemName：仍视为新补货记录（低置信，留给 LLM 兜底）
    const qty = parseQty(normalized)
    return {
      intent: "new_restock_record",
      fields: qty.qty !== undefined ? { quantity: qty.qty, unit: qty.unit } : {},
      signals: baseSignals,
      confidence: "low",
      reason: "命中购买动词，但本地解析不出物品名，需 LLM 兜底"
    }
  }

  // 8. 批量修订信号
  const batchIntent = classifyBatchIntent(text)
  if (batchIntent && (batchIntent.intent === "batchReviseIndex" || batchIntent.intent === "batchReviseAll")) {
    return {
      intent: "batch_revision",
      fields: {},
      signals: baseSignals,
      confidence: "medium",
      reason: "命中批量修订信号"
    }
  }

  // 9. 预算管理
  if (BUDGET_KEYWORD_PATTERN.test(normalized)) {
    return {
      intent: "manage_budget",
      fields: {},
      signals: baseSignals,
      confidence: "medium",
      reason: "命中预算管理关键词"
    }
  }

  // 10. 物品管理（建档 / 编辑类）
  if (MANAGE_ITEM_KEYWORD_PATTERN.test(normalized)) {
    return {
      intent: "manage_item",
      fields: {},
      signals: baseSignals,
      confidence: "medium",
      reason: "命中物品管理关键词（建档或编辑）"
    }
  }

  // 11. 短句字段补充：纯数字 / 平台 / 日期 / 评价 / 数量
  const shortField = detectShortField(normalized, text, dateContext.now)
  if (shortField) {
    return {
      intent: "supplement_current_collection",
      fields: shortField.fields,
      signals: { ...baseSignals, hasOnlyShortField: true },
      confidence: "high",
      reason: shortField.reason
    }
  }

  // 12. 查询
  if (QUESTION_PATTERN.test(normalized)) {
    return {
      intent: "query_inventory",
      fields: {},
      signals: baseSignals,
      confidence: "medium",
      reason: "命中查询疑问关键词"
    }
  }
  const boundary = classifyConversationBoundary(text)
  if (boundary === "adjacentHomeLife" || boundary === "realtimeExternal") {
    return {
      intent: "query_inventory",
      fields: {},
      signals: baseSignals,
      confidence: "medium",
      reason: `对话边界判定为 ${boundary}，按查询处理`
    }
  }

  // 13. 闲聊 / 身份
  if (boundary === "casual" || boundary === "identityOrMeta" || GREETING_PATTERN.test(text.trim())) {
    return {
      intent: "smalltalk",
      fields: {},
      signals: baseSignals,
      confidence: "medium",
      reason: "闲聊或身份/问候类输入"
    }
  }

  // 14. 兜底
  return {
    intent: "unknown",
    fields: {},
    signals: baseSignals,
    confidence: "low",
    reason: "本地规则无法归类，需 LLM 兜底"
  }
}

/**
 * 检测短句字段补充（采集态场景）：纯数字/平台/日期/评价/数量。
 * 返回 null 表示不是短句字段。
 */
function detectShortField(
  normalized: string,
  raw: string,
  now: number
): { fields: TurnInterpretation["fields"]; reason: string } | null {
  if (normalized.length === 0 || normalized.length > SHORT_FIELD_MAX_LENGTH) return null

  // 纯数字 → 价格补充
  if (PURE_NUMBER_PATTERN.test(normalized)) {
    // 兼容全角数字
    const half = normalized.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    const price = Number(half)
    if (Number.isFinite(price)) {
      return { fields: { price }, reason: "纯数字短句，视为价格补充" }
    }
  }

  // 平台短句
  const platform = parsePlatform(normalized)
  if (platform && normalized.length <= 4) {
    return { fields: { platform }, reason: `短句命中平台「${platform}」` }
  }

  // 日期短句（今天/昨天/前天/大前天）
  const date = parseNaturalDate(raw, now)
  if (date !== undefined && /^(今天|今日|昨天|昨日|前天|大前天)$/.test(normalized)) {
    return { fields: { date }, reason: "短句命中相对日期" }
  }

  // 评价短句
  const review = extractReviewText(raw)
  if (review) {
    return { fields: { review }, reason: `短句命中评价「${review}」` }
  }

  // 数量+单位短句（如「两袋」「3 包」）
  const qty = parseQty(normalized)
  if (qty.qty !== undefined && qty.unit && /^(?:[一二两三四五六七八九十]+|\d+)\s*(?:包|瓶|袋|盒|支|卷|件|kg|斤|L|升)$/.test(normalized)) {
    return { fields: { quantity: qty.qty, unit: qty.unit }, reason: `短句命中数量「${qty.qty}${qty.unit}」` }
  }

  return null
}
