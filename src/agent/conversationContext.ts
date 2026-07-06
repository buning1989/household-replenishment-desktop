/**
 * 对话上下文管理：单窗口内通过 active focus + context pack 管理上下文。
 *
 * 核心目标：单窗口仍然可用，但 LLM 只看到当前任务所需的信息。
 *
 * 设计原则：
 *   1. 不把完整 messages 数组原样传给 LLM
 *   2. 每轮先从 messages 推断当前 active focus（pendingDraft / orderImport / clarification / queryTopic / none）
 *   3. 根据 focus 类型检索相关的业务事实（relevantAppFacts）
 *   4. 只保留最近 3-6 轮对话，且压缩成 role/content 摘要
 *   5. pendingDraft 不从历史里读，而从 activeFocus 读，避免重复
 *   6. confirmed/cancelled 的旧卡片不进入 LLM
 *
 * 本模块是纯函数（除 seenObservationKeys 的副作用 mutation），可被测试直接覆盖。
 */

import { formatDate, formatPrice } from "../domain"
import { calculateMonthlySpend } from "../pure-logic.mjs"
import type { AgentClarification, AgentDraft } from "./drafts"
import type { OrderImportRow } from "../orderImportRows"
import type { AppState, ReplenishmentItem } from "../types"
import type {
  ChatDateContext,
  HouseholdChatItemView,
  HouseholdChatMessage
} from "../llm/householdChat"
import {
  buildManagerObservations,
  filterUnseenObservations,
  markObservationsSeen,
  observationKey,
  pickObservationByPreference,
  serializeHouseholdProfile
} from "./observations"
import { buildManagedItemsLine, buildQueryFacts } from "../llm/householdChat"

// ---------- ConversationFocus ----------

export type ConversationFocus =
  | { kind: "pendingDraft"; draft: AgentDraft; messageId: string; updatedAt: number }
  | { kind: "orderImport"; rows: OrderImportRow[]; messageId: string; updatedAt: number }
  | { kind: "clarification"; clarification: AgentClarification; updatedAt: number }
  | { kind: "queryTopic"; topic: "budget" | "weekly" | "missingInfo" | "price"; updatedAt: number }
  | { kind: "none" }

// ---------- AgentContextPack ----------

/** 允许 LLM 输出的动作类型；不同 focus 下允许的动作不同。 */
export type AllowedAction =
  | "confirm"
  | "cancel"
  | "revise"
  | "offTopic"
  | "skip"
  | "queryAnswer"
  | "draft"
  | "clarification"

export type AgentContextPack = {
  /** 当前日期上下文 */
  dateContext: ChatDateContext
  /** 用户这一轮说的话 */
  currentUserText: string
  /** 当前对话焦点 */
  activeFocus: ConversationFocus
  /** 压缩后的最近若干轮对话（最多 6 条），不含系统提示和完整 messages */
  recentMessages: Array<{ role: "user" | "assistant"; content: string }>
  /** 与当前焦点相关的业务事实（紧凑文本），LLM 据此回答 */
  relevantAppFacts: string
  /** 当前 pending 的可执行草稿（仅 pendingDraft 焦点时存在） */
  pendingExecutable?: AgentDraft
  /** 允许 LLM 输出的动作类型 */
  allowedActions: AllowedAction[]
}

// ---------- 常量 ----------

/** queryTopic 焦点超过 5 分钟视为过期 */
export const QUERY_TOPIC_FRESH_MS = 5 * 60 * 1000

/** compactRecentMessages 默认保留的消息条数 */
const DEFAULT_RECENT_LIMIT = 6

// ---------- 焦点推断 ----------

/**
 * 从 messages 推断当前 active focus。
 *
 * 优先级：
 *   1. 最新 pending draft（draftStatus === "pending"）
 *   2. 最新 pending orderImport（orderImportStatus === "pending"）
 *   3. 最新 clarification（assistant 发起，且之后没有用户消化）
 *   4. 用户当前输入命中的 queryTopic
 *   5. none
 *
 * 注意：superseded/confirmed/cancelled 的旧 draft 不再作为 focus。
 */
export function inferActiveFocus(
  messages: HouseholdChatMessage[],
  dateContext: ChatDateContext,
  currentUserText: string
): ConversationFocus {
  const now = dateContext.now

  // 1. 最新 pending draft
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "assistant" && msg.agentDraft && msg.draftStatus === "pending") {
      return {
        kind: "pendingDraft",
        draft: msg.agentDraft,
        messageId: String(i),
        updatedAt: now
      }
    }
  }

  // 2. 最新 pending orderImport
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "assistant" && msg.orderImportRows && msg.orderImportStatus === "pending") {
      return {
        kind: "orderImport",
        rows: msg.orderImportRows,
        messageId: String(i),
        updatedAt: now
      }
    }
  }

  // 3. 最新 clarification：最后一条 assistant 消息带 clarification 即视为 active
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "assistant" && msg.clarification) {
      return {
        kind: "clarification",
        clarification: msg.clarification,
        updatedAt: now
      }
    }
  }

  // 4. 用户当前输入命中的 queryTopic
  const topic = detectQueryTopicFromText(currentUserText)
  if (topic) {
    return { kind: "queryTopic", topic, updatedAt: now }
  }

  return { kind: "none" }
}

/** 从文本推断 queryTopic 类型（与 detectQueryFactType 对齐，但只返回 4 类） */
function detectQueryTopicFromText(
  text: string
): "budget" | "weekly" | "missingInfo" | "price" | null {
  const lower = text.trim().toLocaleLowerCase("zh-CN")
  if (!lower) return null
  // 写入意图不归为查询
  if (/添加|新建|创建|录入|登记|帮我加|记一笔|记录一下|买了|下单|购入|入手/.test(lower)) return null
  if (/预算|还剩|花了|支出|超支|本月预算|月预算/.test(lower)) return "budget"
  if (/这周|本周|下周|未来|一周内|7天|几天|补什么|要补/.test(lower)) return "weekly"
  if (/缺|没有|补全|信息|哪些信息|信息缺失/.test(lower)) return "missingInfo"
  if (/价格异常|均价|偏贵|贵了|便宜|涨价|多少钱/.test(lower)) return "price"
  return null
}

// ---------- 最近消息压缩 ----------

/**
 * 把 HouseholdChatMessage[] 压缩成 LLM 可见的最近若干轮。
 *
 * 规则：
 *   - 只保留最近 limit 条（默认 6）
 *   - 去掉大段订单识别卡片内容（orderImportRows 的完整表格不进入 LLM）
 *   - 图片只保留「用户上传了订单截图」
 *   - pendingDraft 不从历史里读完整内容，只留简短标记（实际内容从 activeFocus 读）
 *   - confirmed/cancelled/superseded 的旧卡片不进入 LLM
 */
export function compactRecentMessages(
  messages: HouseholdChatMessage[],
  limit = DEFAULT_RECENT_LIMIT
): Array<{ role: "user" | "assistant"; content: string }> {
  if (!messages.length) return []
  // 先处理所有消息（压缩/跳过），再取最近 limit 条
  // 这样跳过的卡片不会挤占 limit 名额，保证输出是真正的「最近 limit 条有效对话」
  const compacted: Array<{ role: "user" | "assistant"; content: string }> = []

  for (const msg of messages) {
    // 临时 loading 消息不进入 LLM 上下文
    if (msg.isTransient) continue

    if (msg.role === "user") {
      // 图片只保留「用户上传了订单截图」
      if (msg.imageAttachments?.length) {
        const text = msg.content?.trim()
        compacted.push({
          role: "user",
          content: text ? `${text}（附带订单截图）` : "用户上传了订单截图"
        })
        continue
      }
      compacted.push({ role: "user", content: msg.content })
      continue
    }

    // assistant: 跳过 confirmed/cancelled/superseded 的旧 draft 卡片
    if (msg.agentDraft && msg.draftStatus && msg.draftStatus !== "pending") {
      continue
    }

    // 跳过已确认/取消的订单导入卡片（不再作为上下文）
    if (msg.orderImportRows && msg.orderImportStatus && msg.orderImportStatus !== "pending") {
      continue
    }

    // pending draft 卡片：从 activeFocus 读，历史里只留简短标记
    if (msg.agentDraft && msg.draftStatus === "pending") {
      compacted.push({
        role: "assistant",
        content: "（当前待确认草稿，详见上下文 focus 段）"
      })
      continue
    }

    // 订单导入卡片：跳过完整表格，只留简短标记
    if (msg.orderImportRows) {
      compacted.push({
        role: "assistant",
        content: "（订单截图识别结果，详见上下文 focus 段）"
      })
      continue
    }

    // 普通文本消息：保留
    compacted.push({ role: "assistant", content: msg.content })
  }

  return compacted.slice(-limit)
}

// ---------- 业务事实检索 ----------

/**
 * 根据当前 focus 检索相关业务事实，拼成紧凑文本注入 LLM 上下文。
 *
 * 不同 focus 的检索规则：
 *   - pendingDraft：只给 draft 相关物品的历史记录
 *   - orderImport：只给订单候选物品和常购商品
 *   - queryTopic：复用 buildQueryFacts 的结果
 *   - clarification / none：给 managed items line + 预算 + 观察作为基线
 *
 * 所有 focus 都会附带：
 *   - managedItemsLine（管家已管理物品概览）
 *   - budgetLine（预算摘要）
 *   - observations（管家最近注意到，会话级去重）
 */
export function buildRelevantAppFacts(
  text: string,
  state: AppState,
  itemViews: HouseholdChatItemView[],
  focus: ConversationFocus,
  dateContext: ChatDateContext,
  seenObservationKeys?: Set<string>
): string {
  const lines: string[] = []

  // 1. 基线：管家已管理物品概览
  lines.push(buildManagedItemsLine(state.items))

  // 2. 预算摘要（短，始终提供）
  lines.push(buildBudgetFactLine(state, dateContext))

  // 3. 家庭画像（如果有）
  const profileSegment = serializeHouseholdProfile(state.householdProfile)
  if (profileSegment) {
    lines.push(profileSegment)
  }

  // 4. focus 特定事实
  if (focus.kind === "pendingDraft") {
    const relatedItems = findRelatedItemsForDraft(focus.draft, state)
    if (relatedItems.length) {
      lines.push("【当前草稿相关物品】")
      for (const item of relatedItems) {
        lines.push(serializeItemForContext(item))
      }
    } else {
      lines.push("【当前草稿相关物品】无（新建物品）")
    }
  } else if (focus.kind === "orderImport") {
    const candidateItems = findCandidateItemsForOrderImport(focus.rows, state)
    if (candidateItems.length) {
      lines.push("【订单相关已有物品】")
      for (const item of candidateItems) {
        lines.push(serializeItemForContext(item))
      }
    } else {
      lines.push("【订单相关已有物品】无（均为新物品）")
    }
  } else if (focus.kind === "queryTopic") {
    // 复用 buildQueryFacts 的结果
    const facts = buildQueryFacts(text, state, itemViews, dateContext)
    if (facts) {
      lines.push(facts)
    }
  }

  // 5. 观察引擎：会话级去重
  const allObservations = buildManagerObservations(state, itemViews, dateContext)
  const unseen = seenObservationKeys && seenObservationKeys.size > 0
    ? filterUnseenObservations(allObservations, seenObservationKeys)
    : allObservations
  if (unseen.length) {
    const top = unseen.slice(0, 3)
    const obsText = top.map((obs) => `- ${obs.text}`).join("\n")
    lines.push(`【管家最近注意到】\n${obsText}`)
    if (seenObservationKeys) markObservationsSeen(top, seenObservationKeys)
  }

  return lines.join("\n")
}

/** 预算摘要短句 */
function buildBudgetFactLine(state: AppState, dateContext: ChatDateContext): string {
  const spend = calculateMonthlySpend(state.items, dateContext.now)
  const budget = state.settings.monthlyBudget
  if (!budget || budget <= 0) {
    return `本月预算：未设置；本月已支出 ¥${formatPrice(spend)}`
  }
  const remaining = budget - spend
  const percent = Math.round((spend / budget) * 100)
  const remainingText = remaining >= 0 ? `剩余 ¥${formatPrice(remaining)}` : `已超出 ¥${formatPrice(Math.abs(remaining))}`
  return `本月预算：¥${formatPrice(budget)}；本月已支出 ¥${formatPrice(spend)}（使用率 ${percent}%）；${remainingText}`
}

/** 找到 draft 相关的物品 */
function findRelatedItemsForDraft(draft: AgentDraft, state: AppState): ReplenishmentItem[] {
  if (draft.kind === "restock") {
    if (draft.itemId) {
      const item = state.items.find((i) => i.id === draft.itemId)
      return item ? [item] : []
    }
    if (draft.itemName) {
      const item = state.items.find(
        (i) => i.name === draft.itemName || i.name.includes(draft.itemName) || draft.itemName.includes(i.name)
      )
      return item ? [item] : []
    }
  }
  if (draft.kind === "createItemWithRestock") {
    // 新建物品，但可能同分类下有相似物品
    return state.items
      .filter((i) => i.category === draft.item.category)
      .slice(0, 2)
  }
  if (draft.kind === "addPurchaseOption") {
    if (draft.itemId) {
      const item = state.items.find((i) => i.id === draft.itemId)
      return item ? [item] : []
    }
    if (draft.itemName) {
      const item = state.items.find(
        (i) => i.name === draft.itemName || i.name.includes(draft.itemName)
      )
      return item ? [item] : []
    }
  }
  return []
}

/** 找到订单导入相关的候选物品 */
function findCandidateItemsForOrderImport(rows: OrderImportRow[], state: AppState): ReplenishmentItem[] {
  const candidateNames = rows
    .map((row) => row.coreName || row.brandName || row.productName)
    .filter((name): name is string => Boolean(name?.trim()))
  const matches: ReplenishmentItem[] = []
  for (const name of candidateNames) {
    const found = state.items.find(
      (item) => item.name.includes(name) || name.includes(item.name)
    )
    if (found && !matches.includes(found)) matches.push(found)
  }
  return matches.slice(0, 5)
}

/** 把单个物品序列化为紧凑上下文文本 */
function serializeItemForContext(item: ReplenishmentItem): string {
  const lines: string[] = [
    `- ${item.name}（${item.category || "未分类"}）`,
    `  周期：${item.cycleDays}天，提前${item.bufferDays}天提醒`,
  ]
  if (item.lastRestockedAt) {
    lines.push(`  上次补货：${formatDate(item.lastRestockedAt)}`)
  }
  if (item.history.length) {
    const recent = item.history.slice(-3)
    lines.push(`  最近${recent.length}次记录：`)
    for (const evt of recent) {
      const parts: string[] = []
      if (evt.at) parts.push(formatDate(evt.at))
      if (evt.qty) parts.push(`${evt.qty}${evt.purchaseUnit || item.unit || "件"}`)
      if (evt.price) parts.push(`¥${formatPrice(evt.price)}`)
      if (evt.platform) parts.push(evt.platform)
      if (evt.review) parts.push(`评价：${evt.review}`)
      lines.push(`    - ${parts.join("，")}`)
    }
  }
  if (item.purchaseOptions.length) {
    lines.push(`  常购：${item.purchaseOptions.slice(0, 3).map((opt) => opt.productName).join("、")}`)
  }
  return lines.join("\n")
}

// ---------- ContextPack 构建 ----------

/**
 * 构造 AgentContextPack。
 *
 * 调用方传入完整 messages + 用户当前输入 + state + itemViews + dateContext，
 * 本函数内部推断 active focus、压缩最近消息、检索相关事实，输出自包含的 context pack。
 *
 * 之后 askHouseholdAssistant 只需要 contextPack，不再接收完整 messages。
 */
export function buildAgentContextPack(params: {
  messages: HouseholdChatMessage[]
  currentUserText: string
  state: AppState
  itemViews: HouseholdChatItemView[]
  dateContext: ChatDateContext
  seenObservationKeys?: Set<string>
  /** 调用方可显式传入 focus（如外层维护的状态），否则自动推断 */
  focus?: ConversationFocus
}): AgentContextPack {
  const { messages, currentUserText, state, itemViews, dateContext, seenObservationKeys } = params
  const activeFocus = params.focus ?? inferActiveFocus(messages, dateContext, currentUserText)
  const recentMessages = compactRecentMessages(messages, DEFAULT_RECENT_LIMIT)
  const relevantAppFacts = buildRelevantAppFacts(
    currentUserText,
    state,
    itemViews,
    activeFocus,
    dateContext,
    seenObservationKeys
  )
  const pendingExecutable = activeFocus.kind === "pendingDraft" ? activeFocus.draft : undefined
  const allowedActions = computeAllowedActions(activeFocus)

  return {
    dateContext,
    currentUserText,
    activeFocus,
    recentMessages,
    relevantAppFacts,
    pendingExecutable,
    allowedActions
  }
}

/** 根据 focus 类型计算允许 LLM 输出的动作 */
function computeAllowedActions(focus: ConversationFocus): AllowedAction[] {
  if (focus.kind === "pendingDraft") {
    return ["confirm", "cancel", "revise", "offTopic"]
  }
  if (focus.kind === "orderImport") {
    return ["confirm", "cancel", "revise", "skip", "offTopic"]
  }
  if (focus.kind === "clarification") {
    return ["draft", "clarification", "offTopic"]
  }
  if (focus.kind === "queryTopic") {
    return ["queryAnswer", "offTopic"]
  }
  return ["queryAnswer", "draft", "clarification"]
}

// ---------- Focus 生命周期辅助 ----------

/**
 * Focus 生命周期：commit/cancel 后清除对应 focus。
 *
 * - confirm / cancel：清除 pendingDraft focus
 * - confirmOrderImport / cancelOrderImport：清除 orderImport focus
 * - revise：保留 pendingDraft focus（draft 由调用方更新）
 *
 * 注意：实际 focus 清除是通过 messages 状态变化实现的（draftStatus 改为 confirmed/cancelled），
 * 下次 inferActiveFocus 会自动返回 none。本函数供调用方在做完操作后、下次构建 context pack 前显式确认。
 */
export function clearFocusOnCommit(
  focus: ConversationFocus,
  action: "confirm" | "cancel" | "revise" | "confirmOrderImport" | "cancelOrderImport"
): ConversationFocus {
  if (action === "confirm" || action === "cancel") {
    if (focus.kind === "pendingDraft") return { kind: "none" }
  }
  if (action === "confirmOrderImport" || action === "cancelOrderImport") {
    if (focus.kind === "orderImport") return { kind: "none" }
  }
  // revise 保留原 focus
  return focus
}

/** 判断 queryTopic 是否过期（超过 5 分钟） */
export function isQueryTopicStale(focus: ConversationFocus, now: number): boolean {
  if (focus.kind !== "queryTopic") return false
  return now - focus.updatedAt > QUERY_TOPIC_FRESH_MS
}

/**
 * 用户发起新的写入任务时，把旧 pendingDraft 标记为 superseded。
 * 返回新的 messages 数组（不可变）。
 */
export function supersedeOldPendingDraft(
  messages: HouseholdChatMessage[]
): HouseholdChatMessage[] {
  return messages.map((msg) =>
    msg.role === "assistant" && msg.agentDraft && msg.draftStatus === "pending"
      ? { ...msg, draftStatus: "superseded" as const }
      : msg
  )
}

// 重新导出 pickObservationByPreference 以保持兼容（部分代码可能从 conversationContext 引入）
export {
  pickObservationByPreference,
  observationKey,
  filterUnseenObservations,
  markObservationsSeen
} from "./observations"
