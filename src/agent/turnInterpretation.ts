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
  findItemMatch,
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
import { isManagementRequest } from "./managementGuard"
import type { AppState } from "../types"
import type { ChatDateContext, HouseholdChatItemView } from "../llm/householdChat"

// 重新导出，供 householdOrchestrator / focusResolver 等使用
export { isManagementRequest } from "./managementGuard"

export type TurnIntent =
  | "new_restock_record"
  | "supplement_current_collection"
  | "correct_current_collection"
  | "confirm_current_task"
  | "cancel_current_task"
  | "force_proposal"
  | "query_inventory"
  | "query_current_pending"
  | "manage_item"
  | "create_item"
  | "manage_budget"
  | "delete_request"
  | "batch_revision"
  | "report_inventory_status"
  | "correct_last_mutation"
  | "undo_last_mutation"
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
    /** 阶段 4B.6：query_current_pending 时，用户想查的字段（price/platform/qty/status/date/summary） */
    targetField?: "price" | "platform" | "qty" | "status" | "date" | "summary"
    /** 403：report_inventory_status 时，库存状态描述 */
    inventoryStatus?: "depleted" | "low" | "half" | "plenty"
    /** 403：report_inventory_status 时，结构化数量（如"还剩两包"的 2） */
    remainingQty?: number
    /** 403：report_inventory_status 时，剩余天数估算（从 remainingQty 推算） */
    remainingDays?: number
    /** 403：correct_last_mutation 时，要修正的字段 */
    correctionField?: "price" | "qty" | "platform" | "date"
    /** 403：correct_last_mutation 时，修正值 */
    correctionValue?: number | string
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
    /** 阶段 4B.6：是否含疑问/指代信号（多少钱/哪个/来着/记的是/刚才） */
    hasQuestionSignal?: boolean
    /** 阶段 4B.6：是否含明确新增信号（又买了/另外买了/还买了/重新记一条） */
    hasExplicitNewRecord?: boolean
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

/**
 * 403：物品创建关键词——仅建档类，不含编辑。
 * 创建意图不拦截，落到 writeDraft → buildLocalDraftFromText 生成 createItem 草稿。
 *
 * 403 修复：新增「以后提醒」「帮我管理」「消耗品叫」「消耗品：」等显式建档信号，
 * 确保它们在 manage_item 拦截之前被识别为 create_item。
 */
const CREATE_ITEM_KEYWORD_PATTERN = /添加|新建|创建|录入|登记|帮我加|加一个|加个|加入清单|以后提醒|帮我管理|消耗品叫|消耗品[:：]/

/**
 * 物品管理关键词：编辑类（重命名/移动/改单位/改周期/改提醒/设默认/提醒设置）。
 * 403 后这些走导航，不直接写入。
 *
 * 注意：「改成」和「改为」不在此 pattern 中，因为它们也常用于当前草稿字段修订
 * （如「改成 3 袋」「金额改成 78」）。只有在前面有管理目标词时才算管理请求
 * （如「周期改成」「常购商品平台改成」），这些由其他更具体的 pattern 覆盖。
 */
const MANAGE_ITEM_KEYWORD_PATTERN =
  /改名为|改叫|重命名|移到|归到|归入|放到|单位改|单位设|按包记|按瓶记|按袋记|快用完前|默认商品设|设为默认|设成默认|周期改|周期设|周期调成|补货周期|设为.*默认|设成.*默认|常购商品.*改|常购商品.*设|常购商品.*默认|默认常购|提前.*天.*提醒|提醒.*改|提醒.*设|提醒.*提前/

/**
 * 403：统一管理请求检测——用于在任何录入解析前拦截。
 * 实现已移至 managementGuard.ts（避免循环依赖），此处通过 re-export 暴露。
 * 覆盖删除、编辑、预算、周期、提醒、常购商品管理、默认商品设置等所有已关闭能力。
 */

/**
 * 403：当前录入草稿字段修订判定。
 * 只允许与本次录入直接相关的字段修订，不允许管理类修订。
 *
 * 允许修订的字段：
 *   - 物品名称（不是 X，是 Y / 改成 Y）
 *   - 数量（改成 N 袋）
 *   - 单位
 *   - 金额（金额改成 N / 不是 N，是 M）
 *   - 平台（平台是 X / 平台改成 X）
 *   - 日期（日期改成昨天）
 *   - 本次订单商品信息
 *
 * 不允许的修订（无论是否有 pending，都只能导航）：
 *   - 周期 / 提醒 / 分类 / 预算 / 历史记录 / 常购商品历史信息 / 默认商品 / 删除
 */
export function isCurrentEntryFieldRevision(text: string): boolean {
  // 如果是管理请求，一定不是当前录入字段修订
  if (isManagementRequest(text)) return false
  const normalized = compact(text)
  // 显式物品名修订：「不是 X，是 Y」
  if (parseItemNameRevision(text)) return true
  // 含「改成」但仅限录入字段（数量/金额/平台/日期/商品名）
  if (/改成|改为|是/.test(normalized)) {
    // 排除管理类「改成」
    if (isManagementRequest(text)) return false
    // 检查是否含录入字段信号
    const hasQtySignal = /\d+\s*(?:包|瓶|袋|盒|支|卷|件|提|桶|罐|箱|套|kg|斤|L|升|ml)/.test(normalized)
    const hasPriceSignal = /\d+(?:\.\d+)?(?:\s*元|块钱|块)/.test(normalized)
    const hasPlatformSignal = /京东|淘宝|天猫|拼多多|抖音|1688|盒马|山姆|美团|超市|线下|苏宁|当当|蜜芽|网易|拼多多/.test(normalized)
    const hasDateSignal = /今天|昨天|前天|大前天|三天前/.test(normalized)
    const hasAmountSignal = /金额|价格|多少钱/.test(normalized)
    const hasQtyWord = /数量|几袋|几包|几瓶|几个/.test(normalized)
    const hasPlatformWord = /平台/.test(normalized)
    const hasDateWord = /日期/.test(normalized)
    if (hasQtySignal || hasPriceSignal || hasPlatformSignal || hasDateSignal
        || hasAmountSignal || hasQtyWord || hasPlatformWord || hasDateWord) {
      return true
    }
  }
  // 短句字段补充：纯数字 / 纯平台名 / 纯日期
  if (/^\d+(?:\.\d+)?$/.test(normalized)) return true
  if (/^京东$|^淘宝$|^天猫$|^拼多多$|^抖音$|^1688$|^盒马$|^山姆$|^美团$|^超市$|^线下$/.test(normalized)) return true
  return false
}

/** 闲聊/问候。conversationBoundary 不覆盖「你好」等问候，这里补一层。 */
const GREETING_PATTERN = /你好|您好|嗨|早上好|晚上好|下午好|早呀|哈喽|^hello$|^hi$/i

/** 查询类疑问关键词。 */
const QUESTION_PATTERN =
  /还能用多久|还能撑多久|还能用|还剩多少|还剩|剩多少|剩几|快没|还有多少|还有.*吗|花了多少钱|多少钱|哪些|哪个|哪一些|几条|几包|几瓶|几袋|多少|吗$|怎么|什么/

/**
 * 403：库存状态报告——用户陈述当前库存状态（不是查询）。
 * 必须满足：含状态词 + 无疑问信号。
 * 状态词分四档：用完 / 快没 / 还能用一阵 / 还很多。
 * 数量表达如「还剩两包」「还剩3袋」也属于状态报告。
 */
const INVENTORY_DEPLETED_PATTERN = /用完了|用光|没了|空了|没有了/
const INVENTORY_LOW_PATTERN = /快没|快用完|不多了|所剩无几|快完了|快用完了/
const INVENTORY_HALF_PATTERN = /还能用一阵|还能用一段时间|还能撑一阵|还能撑一会儿|不多了|还剩一点/
const INVENTORY_PLENTY_PATTERN = /还有很多|还很多|很多|充足|还多|够用/
const INVENTORY_QTY_PATTERN = /还剩\s*([0-9０-９一二三四五六七八九十两]+)\s*([包袋瓶盒件支卷桶块])/

/**
 * 403：最近一次 Agent 写入的纠错和撤销。
 * 纠错：刚才金额是78元 / 刚才是3袋 / 平台改成拼多多 / 日期应该是昨天
 * 撤销：撤销刚才那条 / 刚才记重复了 / 去掉刚才那条
 */
const LAST_MUTATION_REF_PATTERN = /刚才|刚刚|那条刚记的|刚才那条/
const UNDO_LAST_PATTERN = /撤销刚才|撤销刚刚|撤销那条|去掉刚才|删掉刚才|刚才.*重复|刚才.*记重复|刚才记重了/
const CORRECT_LAST_PRICE_PATTERN = /(?:刚才|刚刚).*(?:金额|价格).*?(?:不是|是|改成|换成|应该是)?\s*([0-9０-９]+)/
const CORRECT_LAST_QTY_PATTERN = /(?:刚才|刚刚).*(?:数量|几袋|几包|几瓶|几个).*?(?:不是|是|改成|换成|应该是)?\s*([0-9０-９]+)/
const CORRECT_LAST_PLATFORM_PATTERN = /(?:刚才|刚刚).*平台.*?(?:改成|换成|是|不是)\s*(京东|淘宝|天猫|拼多多|抖音|1688|盒马|山姆|美团|超市|线下|苏宁|当当|蜜芽|网易)/
const CORRECT_LAST_DATE_PATTERN = /(?:刚才|刚刚).*日期.*?(?:是|应该是|改成)\s*(昨天|前天|今天|大前天|三天前)/

/**
 * 阶段 4B.6：混合信号检测——购买动词 + 疑问/指代词同时出现时，本地无权高置信写入。
 * 这些输入需要结合 pending 上下文才能判断是「问当前草稿」还是「开新记录」。
 */
const MIXED_SIGNAL_QUESTION_PATTERN =
  /多少钱|哪个平台|哪里买的|哪家|几袋|几包|几瓶|多少|吗$|呢$|？|\?|来着|记的是|刚才|还没记|记了没|还没保存|那条|这条/

/**
 * 阶段 4B.6：明确新增信号——用户确实在说「又买了一条/另外买了/重新记一条」。
 * 只有这些信号才允许在 pending 存在时 start_new_collection（同物品也不拦）。
 */
export const EXPLICIT_NEW_RECORD_PATTERN = /又买了|另外买了|还买了|重新记|再记一条|再买|另外记/

/** 阶段 4B.6：判断输入是否含明确新增信号。 */
export function hasExplicitNewRecordSignal(text: string): boolean {
  return EXPLICIT_NEW_RECORD_PATTERN.test(compact(text)) || EXPLICIT_NEW_RECORD_PATTERN.test(text)
}

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
  // 阶段 4B.6：混合信号——购买动词 + 疑问/指代词同时出现
  const hasQuestionSignal = MIXED_SIGNAL_QUESTION_PATTERN.test(normalized) || MIXED_SIGNAL_QUESTION_PATTERN.test(text)
  // 阶段 4B.6：明确新增信号——又买了/另外买了/还买了/重新记一条
  const hasExplicitNewRecord = EXPLICIT_NEW_RECORD_PATTERN.test(normalized) || EXPLICIT_NEW_RECORD_PATTERN.test(text)

  const baseSignals = {
    hasPurchaseVerb,
    hasExplicitCorrection,
    hasConfirmSignal,
    hasCancelSignal,
    hasDeleteSignal,
    hasOnlyShortField: false,
    hasQuestionSignal,
    hasExplicitNewRecord
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

  // 5.5. 403：最近一次 Agent 写入的纠错和撤销
  //      必须含「刚才/刚刚」引用词 + 纠错或撤销信号
  //      无 pending 时由 orchestrator 检查 lastAgentMutation 决定是否执行
  if (LAST_MUTATION_REF_PATTERN.test(normalized) || LAST_MUTATION_REF_PATTERN.test(text)) {
    // 撤销优先
    if (UNDO_LAST_PATTERN.test(normalized) || UNDO_LAST_PATTERN.test(text)) {
      return {
        intent: "undo_last_mutation",
        fields: {},
        signals: baseSignals,
        confidence: "high",
        reason: "命中「撤销刚才那条」类表达，请求撤销最近一次 Agent 写入"
      }
    }
    // 纠错：金额/价格
    const priceMatch = text.match(CORRECT_LAST_PRICE_PATTERN) || normalized.match(CORRECT_LAST_PRICE_PATTERN)
    if (priceMatch) {
      const val = Number(priceMatch[1].replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)))
      if (Number.isFinite(val)) {
        return {
          intent: "correct_last_mutation",
          fields: { correctionField: "price", correctionValue: val },
          signals: baseSignals,
          confidence: "high",
          reason: `命中「刚才金额是 N」类表达，修正最近记录价格：${val}`
        }
      }
    }
    // 纠错：数量
    const qtyMatch = text.match(CORRECT_LAST_QTY_PATTERN) || normalized.match(CORRECT_LAST_QTY_PATTERN)
    if (qtyMatch) {
      const raw = qtyMatch[1]
      const num = parseChineseNumber(raw)
      if (Number.isFinite(num)) {
        return {
          intent: "correct_last_mutation",
          fields: { correctionField: "qty", correctionValue: num },
          signals: baseSignals,
          confidence: "high",
          reason: `命中「刚才数量是 N」类表达，修正最近记录数量：${num}`
        }
      }
    }
    // 纠错：平台
    const platformMatch = text.match(CORRECT_LAST_PLATFORM_PATTERN) || normalized.match(CORRECT_LAST_PLATFORM_PATTERN)
    if (platformMatch) {
      return {
        intent: "correct_last_mutation",
        fields: { correctionField: "platform", correctionValue: platformMatch[1] },
        signals: baseSignals,
        confidence: "high",
        reason: `命中「刚才平台改成 X」类表达，修正最近记录平台：${platformMatch[1]}`
      }
    }
    // 纠错：日期
    const dateMatch = text.match(CORRECT_LAST_DATE_PATTERN) || normalized.match(CORRECT_LAST_DATE_PATTERN)
    if (dateMatch) {
      return {
        intent: "correct_last_mutation",
        fields: { correctionField: "date", correctionValue: dateMatch[1] },
        signals: baseSignals,
        confidence: "high",
        reason: `命中「刚才日期应该是 X」类表达，修正最近记录日期：${dateMatch[1]}`
      }
    }
  }

  // 6. 确认信号（普通「确认/可以/好的」）
  //    阶段 4B.6：pending 活跃期白名单准入——含疑问/指代信号时不允许高置信确认。
  //    如「猫砂你还没记上呢」含「记上」会被 classifyAgentIntent 误判为 confirmDraft，
  //    但「还没记」是疑问/指代信号，应降级交 LLM 结合 pending 判断。
  if (isConfirmDraft && !hasQuestionSignal) {
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
  //    阶段 4B.6：混合信号（购买动词 + 疑问/指代词）时不得高置信写入。
  //    如「我花了多少钱买的这 5 袋猫砂」含「买了」+「多少钱」，应降级交 LLM 结合 pending 判断。
  if (hasPurchaseVerb) {
    const draft = buildLocalDraftFromText(text, state)
    if (draft && (draft.kind === "restock" || draft.kind === "createItemWithRestock")) {
      const fields = extractFieldsFromDraft(draft)
      if (fields.itemName) {
        // 阶段 4B.6：混合信号降级——购买动词 + 疑问/指代词同时出现
        if (hasQuestionSignal && !EXPLICIT_NEW_RECORD_PATTERN.test(normalized)) {
          return {
            intent: "unknown",
            fields,
            signals: baseSignals,
            confidence: "low",
            reason: `购买动词 + 疑问/指代信号（混合信号），本地无权高置信写入，需 LLM 结合 pending 判断`
          }
        }
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
    // 阶段 4B.6：混合信号降级同样适用于此分支——如「这 5 袋猫砂哪个平台买的」
    // 含「买的」+「哪个平台」，本地解析不出干净 itemName，但也不应高置信新建记录。
    const qty = parseQty(normalized)
    if (hasQuestionSignal && !EXPLICIT_NEW_RECORD_PATTERN.test(normalized)) {
      return {
        intent: "unknown",
        fields: qty.qty !== undefined ? { quantity: qty.qty, unit: qty.unit } : {},
        signals: baseSignals,
        confidence: "low",
        reason: "购买动词 + 疑问/指代信号（混合信号），本地解析不出物品名且无权高置信写入，需 LLM 结合 pending 判断"
      }
    }
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

  // 9.5. 403：库存状态报告——用户陈述当前库存状态（不是查询）
  //     必须满足：含状态词 + 无疑问信号 + 无购买动词 + 匹配到已管理物品
  //     不匹配 manage_item 关键词（避免「快用完前」误吞「快用完了」）
  if (!hasQuestionSignal && !hasPurchaseVerb) {
    const inventoryReport = detectInventoryStatusReport(text, normalized, state)
    if (inventoryReport) {
      return inventoryReport
    }
  }

  // 10a. 403：物品创建——建档类关键词，不拦截，落到 writeDraft → buildLocalDraftFromText。
  //      必须在 manage_item 之前，避免「加个消耗品」被误判为编辑管理。
  if (CREATE_ITEM_KEYWORD_PATTERN.test(normalized)) {
    return {
      intent: "create_item",
      fields: {},
      signals: baseSignals,
      confidence: "medium",
      reason: "命中物品创建关键词（建档），不拦截，落到 writeDraft"
    }
  }

  // 10b. 物品管理（仅编辑类：重命名/移动/改单位/改周期/改提醒/设默认）
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

  // 带币种单位的价格短句（如「45块」「36元」「128块钱」「45.5元」）
  // 注意：用 raw 而非 normalized 匹配——compact 会把小数点「.」当作标点删除，
  // 导致「45.5元」被压成「455元」。此处对 raw 做兼容全角数字后正则匹配。
  const priceWithUnit = raw.trim().replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
  const priceUnitMatch = /^(\d+(?:\.\d+)?)\s*(?:块钱?|元)$/.exec(priceWithUnit)
  if (priceUnitMatch) {
    const price = Number(priceUnitMatch[1])
    if (Number.isFinite(price)) {
      return { fields: { price }, reason: `带币种的价格短句「${raw}」，归一为 price=${price}` }
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
  if (qty.qty !== undefined && qty.unit && /^(?:[一二两三四五六七八九十]+|\d+)\s*(?:包|瓶|袋|盒|支|卷|件|提|桶|罐|箱|套|kg|斤|L|升|ml)$/.test(normalized)) {
    return { fields: { quantity: qty.qty, unit: qty.unit }, reason: `短句命中数量「${qty.qty}${qty.unit}」` }
  }

  return null
}

/**
 * 403：从库存状态陈述中提取候选物品名。
 * 移除状态词后，剩余部分作为候选物品名。
 * 如「猫砂快没了」→ 「猫砂」，「洗衣液已经用完了」→ 「洗衣液」。
 */
function extractItemNameFromStatusText(text: string, normalized: string): string | undefined {
  const cleaned = normalized
    .replace(INVENTORY_DEPLETED_PATTERN, "")
    .replace(INVENTORY_LOW_PATTERN, "")
    .replace(INVENTORY_HALF_PATTERN, "")
    .replace(INVENTORY_PLENTY_PATTERN, "")
    .replace(/已经|快|很|还|不多了|所剩无几|充足|够用/g, "")
    .replace(/还剩.*[包袋瓶盒件支卷桶块]/g, "")
  const name = cleaned.trim()
  if (name && name.length >= 1 && name.length <= 10) {
    return name
  }
  return undefined
}

/**
 * 403：检测库存状态报告。
 * 用户用陈述句报告当前库存状态，如「猫砂快没了」「纸巾还剩两包」「洗衣液已经用完了」。
 * 未匹配到已管理物品时也返回意图，让 orchestrator 引导用户先添加物品。
 *
 * 映射策略（不创建新物品、不创建补货记录）：
 *   - 用完了 / 没了 → depleted, remainingDays=0
 *   - 快没了 / 不多了 → low, remainingDays 用 bufferDays 或 2
 *   - 还能用一阵 → half, remainingDays 用 cycleDays/2
 *   - 还有很多 → plenty, remainingDays 用 cycleDays
 *   - 还剩 N 包 → remainingDays 从 dailyUse 推算
 */
function detectInventoryStatusReport(
  text: string,
  normalized: string,
  state: AppState
): TurnInterpretation | null {
  // 先检查是否含状态词
  const hasDepleted = INVENTORY_DEPLETED_PATTERN.test(normalized)
  const hasLow = INVENTORY_LOW_PATTERN.test(normalized)
  const hasHalf = INVENTORY_HALF_PATTERN.test(normalized)
  const hasPlenty = INVENTORY_PLENTY_PATTERN.test(normalized)
  const qtyMatch = text.match(INVENTORY_QTY_PATTERN) || normalized.match(INVENTORY_QTY_PATTERN)

  if (!hasDepleted && !hasLow && !hasHalf && !hasPlenty && !qtyMatch) {
    return null
  }

  // 尝试匹配已管理物品
  const match = findItemMatch(state, text)
  if (!match.item || match.confidence === "ambiguous" || match.confidence === "template") {
    // 403：未管理物品也返回意图，让 orchestrator 的 handleInventoryStatusReport
    // 返回「未管理，请先添加」的引导回答，而不是落到 needLlm。
    // 从 candidates 或文本中提取候选物品名。
    let candidateName: string | undefined
    if (match.candidates.length > 0) {
      candidateName = match.candidates[0]
    } else {
      // 从文本中移除状态词，提取候选物品名
      candidateName = extractItemNameFromStatusText(text, normalized)
    }
    if (candidateName) {
      // 用默认值推算 remainingDays（无 item 数据）
      const fallbackDays = hasDepleted ? 0 : hasLow ? 2 : hasHalf ? 7 : 14
      const fallbackStatus = hasDepleted ? "depleted" : hasLow ? "low" : hasHalf ? "half" : "plenty"
      const fallbackLabel = hasDepleted ? "用完了" : hasLow ? "快没了" : hasHalf ? "还能用一阵" : "还有很多"
      return {
        intent: "report_inventory_status",
        fields: {
          itemName: candidateName,
          inventoryStatus: fallbackStatus,
          remainingDays: fallbackDays,
          unit: fallbackLabel
        },
        signals: {
          hasPurchaseVerb: false,
          hasExplicitCorrection: false,
          hasConfirmSignal: false,
          hasCancelSignal: false,
          hasDeleteSignal: false,
          hasOnlyShortField: false
        },
        confidence: "medium",
        reason: `库存状态报告：${candidateName} ${fallbackLabel}（未管理物品，待 orchestrator 引导先添加）`
      }
    }
    return null
  }

  const item = match.item

  // 数量表达优先：还剩 N 包 → 从 dailyUse 反推 remainingDays
  if (qtyMatch) {
    const raw = qtyMatch[1]
    const qty = parseChineseNumber(raw)
    const unit = qtyMatch[2]
    if (Number.isFinite(qty) && qty >= 0) {
      const dailyUse = estimateDailyUse(item)
      let remainingDays: number
      if (dailyUse && dailyUse > 0) {
        remainingDays = Math.max(0, Math.round(qty / dailyUse))
      } else {
        // 无日均消耗数据时用 cycleDays 兜底
        remainingDays = qty <= 1 ? 0 : Math.max(1, Math.round(item.cycleDays / 2))
      }
      return {
        intent: "report_inventory_status",
        fields: {
          itemName: item.name,
          inventoryStatus: remainingDays === 0 ? "depleted" : remainingDays <= 3 ? "low" : "half",
          remainingQty: qty,
          remainingDays,
          unit
        },
        signals: {
          hasPurchaseVerb: false,
          hasExplicitCorrection: false,
          hasConfirmSignal: false,
          hasCancelSignal: false,
          hasDeleteSignal: false,
          hasOnlyShortField: false
        },
        confidence: "high",
        reason: `库存状态报告：${item.name} 还剩 ${qty} ${unit}，推算 remainingDays=${remainingDays}`
      }
    }
  }

  // 模糊状态词映射
  // 注意：hasLow 必须在 hasDepleted 之前检查，因为「快没了」同时包含「快没」和「没了」，
  // 但语义是「快用完」而非「已用完」。
  let inventoryStatus: "depleted" | "low" | "half" | "plenty"
  let remainingDays: number
  let statusLabel: string

  if (hasLow) {
    inventoryStatus = "low"
    // 快没了 → 用 bufferDays 或 2 天
    remainingDays = Math.max(1, item.bufferDays || 2)
    statusLabel = "快没了"
  } else if (hasDepleted) {
    inventoryStatus = "depleted"
    remainingDays = 0
    statusLabel = "用完了"
  } else if (hasHalf) {
    inventoryStatus = "half"
    remainingDays = Math.max(1, Math.round(item.cycleDays / 2))
    statusLabel = "还能用一阵"
  } else {
    // plenty
    inventoryStatus = "plenty"
    remainingDays = item.cycleDays
    statusLabel = "还有很多"
  }

  return {
    intent: "report_inventory_status",
    fields: {
      itemName: item.name,
      inventoryStatus,
      remainingDays,
      unit: statusLabel
    },
    signals: {
      hasPurchaseVerb: false,
      hasExplicitCorrection: false,
      hasConfirmSignal: false,
      hasCancelSignal: false,
      hasDeleteSignal: false,
      hasOnlyShortField: false
    },
    confidence: "high",
    reason: `库存状态报告：${item.name} ${statusLabel}，映射 remainingDays=${remainingDays}`
  }
}

/** 估算物品日均消耗量（件/天）。无数据时返回 null。 */
function estimateDailyUse(item: import("../types").ReplenishmentItem): number | null {
  if (!item.history || item.history.length === 0) return null
  const latestPriced = [...item.history].reverse().find((h) => h.qty && h.qty > 0)
  const qty = latestPriced?.qty
  if (!qty || qty <= 0) return null
  const cycle = Math.max(1, item.cycleDays)
  return qty / cycle
}

/** 解析中文数字（含全角）。支持「两」「三」「十二」等。 */
function parseChineseNumber(raw: string): number {
  const half = raw.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
  const num = Number(half)
  if (Number.isFinite(num)) return num

  const map: Record<string, number> = { "零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10 }
  if (map[raw] !== undefined) return map[raw]
  if (raw.length === 2 && raw[0] === "十") return 10 + (map[raw[1]] ?? 0)
  if (raw.length === 2 && raw[1] === "十") return (map[raw[0]] ?? 0) * 10
  return NaN
}
