/**
 * 阶段 4B.7：data-grounded item record query。
 *
 * 当用户询问已管理物品的补货历史 / 最近记录 / 价格 / 平台 / 数量时，
 * 直接从 state.items[].history 读取真实数据生成回答，
 * 不走 answerLlm，避免 LLM 在无证据情况下凭空生成日期、数量、金额、平台。
 *
 * 设计原则：
 *   1. state / restockRecords / itemViews 是唯一事实源
 *   2. LLM 只负责表达，不能凭空生成事实字段
 *   3. 查询已有记录时优先本地回答，不调用 answerLlm
 *   4. 字段缺失时如实说明缺失，不编造
 *
 * 本模块是纯函数，不调用 LLM，不修改 state。
 */

import { formatPrice } from "../domain"
import type { AppState, ReplenishmentItem, RestockEvent } from "../types"

// ---------- 类型 ----------

export type ItemRecordQueryField = "lastRecord" | "date" | "price" | "platform" | "qty"

export type ItemRecordQuery = {
  item: ReplenishmentItem
  targetField: ItemRecordQueryField
}

// ---------- 查询信号检测 ----------

/**
 * 查询信号：用户想看已管理物品的补货历史 / 最近记录 / 某个字段。
 * 命中其中任一即视为可能的数据查询。
 */
const RECORD_QUERY_SIGNALS = [
  "最近一次", "上次", "最近记录", "最近补货", "补货记录", "记录",
  "什么时候买", "啥时候买", "哪天买", "哪天",
  "多少钱", "金额", "价格",
  "在哪买", "哪里买的", "哪个平台", "什么平台", "哪家",
  "几袋", "几瓶", "几包", "几盒", "几支", "几卷", "几件", "买了多少", "买了几个", "买了几"
]

/**
 * 强写入信号：命中时即使含查询信号也不走 data-grounded query，
 * 而是交给 writeDraft / 混合信号守卫处理。
 * 这些信号表明用户想记一笔新记录，而非查询历史。
 */
const STRONG_WRITE_SIGNALS = [
  "记一笔", "记录一下", "帮我加", "帮我记", "添加", "新建", "创建", "录入", "登记",
  "下单", "购入", "入手", "囤了", "续上", "补了", "补货了", "收货了", "快递到了",
  "今天买了", "昨天买了", "前天买了", "刚买了", "刚刚买了"
]

/** 「买了 + 数字」模式：明确写入新记录（如「买了3袋狗粮」），不走查询。 */
const BOUGHT_WITH_NUMBER_PATTERN = /买了\s*[0-9０-９]+/

/**
 * 阶段 4B.7 补口：destructive / mutation / edit 类动作信号。
 *
 * 命中其中任一即视为动作意图，不得进入 grounded query（也不得进入 item_not_found 兜底）。
 * 这些输入应交给 writeDraft / planner / boundary / LLM 处理，由它们生成删除计划、
 * 修订草稿、或追问操作对象。
 *
 * 只读事实查询（如「狗粮最近一次补货记录」「狗粮上次多少钱」）不会命中这些信号。
 */
const ACTION_INTENT_SIGNALS = [
  // 删除类
  "删除", "删掉", "删了", "移除", "去掉", "撤销", "取消这条", "不要这条",
  // 修改类
  "修改", "改一下", "改成", "修正", "纠正", "改掉"
]

/**
 * 判断文本是否含 destructive / mutation / edit 类动作意图。
 * 命中时 grounded query 路径应放行，不得拦截。
 */
export function hasActionIntentSignal(text: string): boolean {
  const normalized = text.trim()
  if (!normalized) return false
  return ACTION_INTENT_SIGNALS.some((s) => normalized.includes(s))
}

// ---------- 物品名解析 ----------

/**
 * 从用户文本中解析出已管理的物品。
 * 优先精确匹配，其次包含匹配（用户文本包含物品名，或物品名包含用户提到的词）。
 * 返回 null 表示未命中任何已管理物品。
 */
export function resolveItemFromText(text: string, items: ReplenishmentItem[]): ReplenishmentItem | null {
  const normalized = text.trim()
  if (!normalized) return null

  // 1. 精确包含：用户文本包含物品全名
  for (const item of items) {
    if (normalized.includes(item.name)) return item
  }

  // 2. 物品名包含用户文本中的连续中文片段（如用户说「狗粮」匹配「狗粮（大袋）」）
  //    仅当物品名更长时才做包含匹配，避免「狗」匹配「狗粮」过于宽泛
  //    这里要求匹配片段长度 >= 2
  const cjkFragments = normalized.match(/[\u4e00-\u9fa5]{2,}/g) ?? []
  for (const fragment of cjkFragments) {
    for (const item of items) {
      if (item.name.includes(fragment) || fragment.includes(item.name)) {
        // 排除泛化词（如「最近」「一次」「记录」「补货」等）
        if (!isGenericFragment(fragment)) return item
      }
    }
  }

  return null
}

/** 泛化片段不作为物品名匹配依据 */
const GENERIC_FRAGMENTS = new Set([
  "最近", "一次", "记录", "补货", "上次", "什么时候", "多少钱",
  "在哪", "哪里", "哪个", "什么", "平台", "几袋", "几瓶", "几包",
  "几盒", "几支", "几卷", "几件", "买了", "买的", "今天", "昨天",
  "前天", "金额", "价格", "记录一"
])

function isGenericFragment(fragment: string): boolean {
  return GENERIC_FRAGMENTS.has(fragment)
}

// ---------- 查询检测 ----------

/**
 * 检测用户输入是否为「查询已管理物品的补货历史记录」。
 *
 * 命中条件：
 *   1. 含查询信号（最近一次/上次/记录/多少钱/在哪买/几袋...）
 *   2. 含已管理物品名
 *   3. 不含强写入信号（记一笔/记录一下/今天买了/下单...）
 *   4. 不含「买了 + 数字」模式
 *
 * 返回 null 表示不是数据查询，或物品未找到。
 */
export function detectItemRecordQuery(text: string, state: AppState): ItemRecordQuery | null {
  const normalized = text.trim()
  if (!normalized) return null

  // 0. 阶段 4B.7 补口：destructive / mutation / edit 类意图不走 grounded query。
  //    「删除猫砂补货记录」「修改狗粮补货记录」等应交给 planner / writeDraft 处理。
  if (hasActionIntentSignal(normalized)) return null

  // 1. 必须含查询信号
  const hasQuerySignal = RECORD_QUERY_SIGNALS.some((s) => normalized.includes(s))
  if (!hasQuerySignal) return null

  // 2. 不能含强写入信号
  if (STRONG_WRITE_SIGNALS.some((s) => normalized.includes(s))) return null
  if (BOUGHT_WITH_NUMBER_PATTERN.test(normalized)) return null

  // 3. 解析物品
  const item = resolveItemFromText(normalized, state.items)
  if (!item) return null

  // 4. 确定查询字段
  const targetField = detectTargetField(normalized)

  return { item, targetField }
}

/**
 * 判断文本是否含补货记录查询信号（不含强写入信号）。
 * 用于 decideSync 的「未找到物品」兜底：有查询信号但物品未命中时，
 * 不编造记录，引导用户确认物品名。
 */
export function hasItemRecordQuerySignal(text: string): boolean {
  const normalized = text.trim()
  if (!normalized) return false
  // 阶段 4B.7 补口：destructive / mutation / edit 类意图不走 item_not_found 兜底。
  //   「删除这条补货记录」不应被当成物品名去查询。
  if (hasActionIntentSignal(normalized)) return false
  if (!RECORD_QUERY_SIGNALS.some((s) => normalized.includes(s))) return false
  if (STRONG_WRITE_SIGNALS.some((s) => normalized.includes(s))) return false
  if (BOUGHT_WITH_NUMBER_PATTERN.test(normalized)) return false
  return true
}

/** 从文本推断用户想查哪个字段 */
function detectTargetField(text: string): ItemRecordQueryField {
  if (/多少钱|金额|价格|花了/.test(text)) return "price"
  if (/在哪买|哪里买|哪个平台|什么平台|哪家/.test(text)) return "platform"
  if (/几袋|几瓶|几包|几盒|几支|几卷|几件|买了多少|买了几个|买了几|数量/.test(text)) return "qty"
  if (/什么时候|啥时候|哪天|哪日|日期|时间/.test(text)) return "date"
  return "lastRecord"
}

// ---------- 记录查询 ----------

/**
 * 取 item 的最新补货记录（按 at 字段降序）。
 * history 默认按时间升序追加，但这里仍做防御性排序。
 */
export function getLatestRestockEvent(item: ReplenishmentItem): RestockEvent | null {
  if (!item.history || item.history.length === 0) return null
  const sorted = [...item.history].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  return sorted[0]
}

/**
 * 取 item 最近 N 条补货记录（按 at 字段降序）。
 */
export function getRecentRestockEvents(item: ReplenishmentItem, count: number): RestockEvent[] {
  if (!item.history || item.history.length === 0) return []
  const sorted = [...item.history].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  return sorted.slice(0, count)
}

// ---------- 日期格式化 ----------

/**
 * 把时间戳格式化为「2026/7/9」风格，与用户口语一致。
 * 不使用 Intl.DateTimeFormat 是因为它只返回「7/9」不含年份，容易与旧记录混淆。
 */
function formatRecordDate(timestamp: number): string {
  const d = new Date(timestamp)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

// ---------- 回答生成 ----------

/**
 * 根据 item 的真实补货记录生成 data-grounded 回答。
 * 字段缺失时如实说明缺失，不编造。
 */
export function composeGroundedItemRecordAnswer(query: ItemRecordQuery): string {
  const { item, targetField } = query
  const history = item.history

  if (!history || history.length === 0) {
    return `「${item.name}」目前还没有补货记录。你下次买的时候跟我说一声，我帮你记上。`
  }

  const latest = getLatestRestockEvent(item)
  if (!latest) {
    return `「${item.name}」目前还没有补货记录。你下次买的时候跟我说一声，我帮你记上。`
  }

  const dateLabel = latest.at ? formatRecordDate(latest.at) : "日期未记录"
  const qtyLabel = latest.qty ? `${latest.qty}${latest.purchaseUnit || item.unit || "件"}` : null
  const priceLabel = (latest.price !== undefined && latest.price !== null && Number.isFinite(latest.price)) ? `¥${formatPrice(latest.price)}` : null
  const platformLabel = latest.platform || null

  switch (targetField) {
    case "price": {
      if (priceLabel) {
        const parts = [`「${item.name}」最近一次补货是 ${dateLabel}，金额 ${priceLabel}。`]
        if (qtyLabel) parts.push(`这次记的是 ${qtyLabel}。`)
        if (platformLabel) parts.push(`平台 ${platformLabel}。`)
        return parts.join("")
      }
      // 价格缺失
      const parts = [`「${item.name}」最近一次补货是 ${dateLabel}。`]
      if (qtyLabel) parts.push(`这次记的是 ${qtyLabel}。`)
      parts.push("金额没有记录。")
      return parts.join("")
    }
    case "platform": {
      if (platformLabel) {
        const parts = [`「${item.name}」最近一次补货是在 ${platformLabel} 买的。`]
        parts.push(`那次是 ${dateLabel}。`)
        if (qtyLabel) parts.push(`${qtyLabel}。`)
        if (priceLabel) parts.push(priceLabel)
        return parts.join("")
      }
      const parts = [`「${item.name}」最近一次补货是 ${dateLabel}。`]
      if (qtyLabel) parts.push(`${qtyLabel}。`)
      parts.push("平台没有记录。")
      return parts.join("")
    }
    case "qty": {
      if (qtyLabel) {
        const parts = [`「${item.name}」最近一次补货买了 ${qtyLabel}。`]
        parts.push(`那次是 ${dateLabel}。`)
        if (priceLabel) parts.push(priceLabel)
        if (platformLabel) parts.push(`平台 ${platformLabel}。`)
        return parts.join("")
      }
      return `「${item.name}」最近一次补货是 ${dateLabel}，数量没有记录。`
    }
    case "date": {
      const parts = [`「${item.name}」最近一次补货是 ${dateLabel}。`]
      if (qtyLabel) parts.push(`这次记的是 ${qtyLabel}。`)
      if (priceLabel) parts.push(priceLabel)
      if (platformLabel) parts.push(`平台 ${platformLabel}。`)
      return parts.join("")
    }
    case "lastRecord":
    default: {
      const parts = [`「${item.name}」最近一次补货是 ${dateLabel}。`]
      const detail: string[] = []
      if (qtyLabel) detail.push(qtyLabel)
      if (priceLabel) detail.push(priceLabel)
      if (platformLabel) detail.push(platformLabel)
      if (detail.length > 0) {
        parts.push(`这次记的是 ${detail.join("，")}。`)
      } else {
        parts.push("数量、金额、平台都没有记录。")
      }
      return parts.join("")
    }
  }
}

/**
 * 未找到物品时的兜底回答。
 * 不编造记录，引导用户确认物品名。
 */
export function composeItemNotFoundAnswer(text: string, state: AppState): string {
  // 尝试提取用户可能说的物品名片段
  const cjkFragments = text.match(/[\u4e00-\u9fa5]{2,}/g) ?? []
  const nonGeneric = cjkFragments.filter((f) => !isGenericFragment(f))
  const mentioned = nonGeneric[0]

  if (mentioned) {
    const managedNames = state.items.map((i) => i.name).filter(Boolean)
    if (managedNames.length > 0) {
      return `没有查到「${mentioned}」的补货记录。我目前在管理的物品有：${managedNames.join("、")}。你可以确认一下物品名，或者跟我说「帮我加 ${mentioned}」把它加进来。`
    }
    return `没有查到「${mentioned}」的补货记录。我目前还没有在管理的物品。如果你想把「${mentioned}」加进来，跟我说「帮我加 ${mentioned}」就行。`
  }

  return "没有查到这个物品的补货记录。你可以确认一下物品名，或者跟我说「帮我加 物品名」把它加进来。"
}

// ---------- 证据提取（供 LLM grounding 校验用） ----------

/**
 * 从 item 的最新补货记录中提取证据字段，供 LLM 答案校验。
 * 返回的字符串集合是 LLM 答案中允许出现的事实字段。
 */
export function extractEvidenceFacts(item: ReplenishmentItem): {
  itemName: string
  dateLabels: string[]
  qtyLabels: string[]
  priceLabels: string[]
  platformLabels: string[]
} {
  const recent = getRecentRestockEvents(item, 3)
  const dateLabels = new Set<string>()
  const qtyLabels = new Set<string>()
  const priceLabels = new Set<string>()
  const platformLabels = new Set<string>()

  for (const evt of recent) {
    if (evt.at) {
      dateLabels.add(formatRecordDate(evt.at))
      // 也加入 M/D 格式（formatDate 的输出），兼容 LLM 可能用的格式
      const d = new Date(evt.at)
      dateLabels.add(`${d.getMonth() + 1}/${d.getDate()}`)
    }
    if (evt.qty) {
      const unit = evt.purchaseUnit || item.unit || "件"
      qtyLabels.add(`${evt.qty}${unit}`)
      qtyLabels.add(`${evt.qty}袋`) // 常见单位兼容
      qtyLabels.add(String(evt.qty))
    }
    if (evt.price !== undefined && evt.price !== null && Number.isFinite(evt.price)) {
      priceLabels.add(`¥${formatPrice(evt.price)}`)
      priceLabels.add(String(evt.price))
      priceLabels.add(formatPrice(evt.price))
    }
    if (evt.platform) {
      platformLabels.add(evt.platform)
    }
  }

  return {
    itemName: item.name,
    dateLabels: [...dateLabels],
    qtyLabels: [...qtyLabels],
    priceLabels: [...priceLabels],
    platformLabels: [...platformLabels]
  }
}

/**
 * 校验 LLM 答案是否与证据一致。
 *
 * 规则：
 *   - 提取 LLM 答案中出现的日期 / 数量 / 金额 / 平台
 *   - 如果出现了证据中不存在的字段值，视为不 grounded
 *   - 返回 { grounded: true } 或 { grounded: false, reason }
 */
export function validateAnswerGrounding(
  llmAnswer: string,
  evidence: ReturnType<typeof extractEvidenceFacts>
): { grounded: true } | { grounded: false; reason: string } {
  const answer = llmAnswer

  // 构建归一化的证据日期集合（兼容 / 和 - 分隔符）
  const evidenceDateSet = new Set<string>()
  for (const d of evidence.dateLabels) {
    evidenceDateSet.add(d)
    evidenceDateSet.add(d.replace(/\//g, "-"))
  }

  // 检查日期：答案中的「20XX/X/X」「X/X」「20XX-X-X」「X-X」格式
  const dateMatches = answer.match(/\d{4}[\/-]\d{1,2}[\/-]\d{1,2}|\d{1,2}[\/-]\d{1,2}/g) ?? []
  for (const date of dateMatches) {
    const normalized = date.replace(/\//g, "-")
    const evidenceHas = evidence.dateLabels.includes(date) ||
      evidence.dateLabels.includes(normalized) ||
      evidenceDateSet.has(date) ||
      evidenceDateSet.has(normalized)
    if (!evidenceHas) {
      return { grounded: false, reason: `answer_date_not_in_evidence:${date}` }
    }
  }

  // 检查数量：答案中的「N袋/N瓶/N包/N盒/N件」格式
  const qtyMatches = answer.match(/(\d+(?:\.\d+)?)\s*(?:袋|瓶|包|盒|支|卷|件|kg|L)/g) ?? []
  for (const qty of qtyMatches) {
    if (!evidence.qtyLabels.some((q) => qty.includes(q) || q.includes(qty))) {
      return { grounded: false, reason: `answer_qty_not_in_evidence:${qty}` }
    }
  }

  // 检查金额：答案中的「¥XXX」或「XXX元」格式
  const priceMatches = answer.match(/¥\s*[\d.]+|[\d.]+\s*元/g) ?? []
  for (const price of priceMatches) {
    if (!evidence.priceLabels.some((p) => price.includes(p) || p.includes(price))) {
      return { grounded: false, reason: `answer_price_not_in_evidence:${price}` }
    }
  }

  // 检查平台：答案中出现的已知平台名是否在证据中
  const knownPlatforms = ["淘宝", "京东", "拼多多", "天猫", "抖音", "1688", "盒马", "山姆", "美团", "超市", "线下"]
  for (const platform of knownPlatforms) {
    if (answer.includes(platform) && !evidence.platformLabels.includes(platform)) {
      return { grounded: false, reason: `answer_platform_not_in_evidence:${platform}` }
    }
  }

  return { grounded: true }
}
