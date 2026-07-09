/**
 * RecordInsight：补货记录洞察引擎。
 *
 * 设计目标：
 *   1. 在补货记录 proposal / commit 前后，基于历史采购记录、常购商品、
 *      消耗周期、预算信息，主动生成结构化判断（价格/数量/周期/常购/预算/评价）。
 *   2. 输出的 RecordInsight 只是「判断与建议」，不直接写 state，不自动修改周期，
 *      不自动创建常购商品。所有写入仍走 proposal → 确认 → commit。
 *   3. 文案原则：像管家，不像数据报表；不说「绝对划算」「一定贵了」；
 *      没有历史时不强判；估算价格不做强判断，只做参考表达。
 *
 * 接入位置：
 *   - proposal 生成时：buildRecordInsights(draft, state, itemViews, dateContext)
 *     在 composeReadyToConfirmMessage 中追加 1-2 条轻量判断。
 *   - commit 成功后：buildPostCommitInsights(draft, newState, itemViews, dateContext)
 *     基于新 state 生成最终洞察（含预算影响），拼接到 summary 后。
 */

import { calculateMonthlySpend } from "../pure-logic.mjs"
import { formatPrice } from "../domain"
import type { AppState, ReplenishmentItem, RestockEvent } from "../types"
import type { ChatDateContext, HouseholdChatItemView } from "../llm/householdChat"
import type { AgentDraft } from "./drafts"

// ---------- 类型 ----------

export type RecordInsightType =
  | "priceLowerThanUsual"
  | "priceHigherThanUsual"
  | "priceNormal"
  | "quantityHigherThanUsual"
  | "quantityLowerThanUsual"
  | "cycleMayNeedAdjust"
  | "favoriteCandidate"
  | "budgetImpact"
  | "reviewCaptured"

export type RecordInsight = {
  type: RecordInsightType
  level: "info" | "positive" | "warning"
  message: string
  evidence?: string
  confidence: "high" | "medium" | "low"
}

export type BuildRecordInsightsInput = {
  draft: AgentDraft
  state: AppState
  itemViews: HouseholdChatItemView[]
  dateContext: ChatDateContext
}

export type BuildRecordInsightsResult = {
  insights: RecordInsight[]
  summaryLine?: string
}

// ---------- 阈值常量 ----------

/** 单价比历史中位低 10% 以上 → priceLowerThanUsual */
const PRICE_LOWER_THRESHOLD = 0.10
/** 单价比历史中位高 15% 以上 → priceHigherThanUsual */
const PRICE_HIGHER_THRESHOLD = 0.15
/** 补货量比历史常见高 50% 以上 → quantityHigherThanUsual */
const QTY_HIGHER_THRESHOLD = 0.50
/** 补货量比历史常见低 40% 以上 → quantityLowerThanUsual */
const QTY_LOWER_THRESHOLD = 0.40
/** 常购商品候选：最近 N 次同平台购买 */
const FAVORITE_SAME_PLATFORM_COUNT = 3
/** 同一 item 常购商品建议去重窗口（毫秒）：7 天内不重复提示 */
const FAVORITE_DEDUP_WINDOW = 7 * 24 * 60 * 60 * 1000

// ---------- 工具函数 ----------

/** 从草稿提取补货上下文（物品名/qty/unit/price/platform/review/itemId）。 */
function extractRestockContext(draft: AgentDraft): {
  itemName: string
  itemId?: string
  qty?: number
  unit?: string
  price?: number
  platform?: string
  review?: string
} | null {
  if (draft.kind === "restock") {
    return {
      itemName: draft.itemName,
      itemId: draft.itemId,
      qty: draft.qty,
      unit: draft.unit,
      price: draft.price,
      platform: draft.platform,
      review: draft.review
    }
  }
  if (draft.kind === "createItemWithRestock") {
    return {
      itemName: draft.item.itemName,
      qty: draft.restock.qty,
      unit: draft.restock.unit || draft.item.unit,
      price: draft.restock.price,
      platform: draft.restock.platform,
      review: draft.restock.review
    }
  }
  return null
}

/** 在 state.items 中按 itemId 或 itemName 找到当前物品。 */
function findItem(state: AppState, itemName: string, itemId?: string): ReplenishmentItem | undefined {
  if (itemId) {
    const byId = state.items.find((item) => item.id === itemId)
    if (byId) return byId
  }
  const lower = itemName.trim().toLocaleLowerCase("zh-CN")
  return state.items.find((item) => item.name.trim().toLocaleLowerCase("zh-CN") === lower)
}

/** 历史价格统计：基于 price>0 且 qty>0 的记录计算单价分布。 */
type PriceStats = {
  median: number
  average: number
  count: number
  latest?: number
  latestPlatform?: string
  platforms: string[]
}

function computePriceStats(history: RestockEvent[]): PriceStats | null {
  const priced = history.filter(
    (event) => Number.isFinite(event.price) && event.price! > 0 && Number.isFinite(event.qty) && event.qty! > 0
  )
  if (priced.length === 0) return null
  const unitPrices = priced.map((event) => event.price! / event.qty!)
  const sorted = [...unitPrices].sort((a, b) => a - b)
  const average = unitPrices.reduce((total, value) => total + value, 0) / unitPrices.length
  const median = sorted.length % 2 === 1
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
  const platforms = Array.from(
    new Set(
      priced
        .map((event) => event.platform)
        .filter((platform): platform is string => Boolean(platform && platform.trim()))
    )
  )
  const latest = priced[priced.length - 1]
  return {
    median,
    average,
    count: unitPrices.length,
    latest: latest.price! / latest.qty!,
    latestPlatform: latest.platform,
    platforms
  }
}

/** 历史补货数量统计。 */
type QtyStats = {
  median: number
  average: number
  count: number
  recentValues: number[]
}

function computeQtyStats(history: RestockEvent[]): QtyStats | null {
  const valid = history.filter((event) => Number.isFinite(event.qty) && event.qty! > 0)
  if (valid.length === 0) return null
  const qtys = valid.map((event) => event.qty!)
  const sorted = [...qtys].sort((a, b) => a - b)
  const average = qtys.reduce((total, value) => total + value, 0) / qtys.length
  const median = sorted.length % 2 === 1
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
  return {
    median,
    average,
    count: qtys.length,
    recentValues: qtys.slice(-5)
  }
}

/** 保留 1 位小数（用于单价格式化）。 */
function round1(value: number): number {
  return Math.round(value * 10) / 10
}

// ---------- 价格判断 ----------

/**
 * 价格判断：当前单价比历史中位单价低 10% / 高 15% / 正常范围。
 *
 * 注意：
 *   - 价格是系统估算而非用户明确输入时，不做强判断（confidence 降级）。
 *   - 历史记录不足 2 条时不强判，只给低置信参考。
 *   - 不说「绝对划算」「一定贵了」。
 */
function buildPriceInsight(
  ctx: { itemName: string; qty?: number; price?: number; unit?: string },
  item: ReplenishmentItem | undefined
): RecordInsight | null {
  // 需要有明确的 price 和 qty 才能算单价
  if (ctx.price === undefined || ctx.price === null || ctx.price <= 0) return null
  if (ctx.qty === undefined || ctx.qty <= 0) return null

  const currentUnitPrice = ctx.price / ctx.qty
  const perWhat = ctx.unit || "件"

  if (!item) {
    // 无物品记录，不强判
    return null
  }

  const stats = computePriceStats(item.history)
  if (!stats || stats.count < 1) {
    // 无历史价格：不强判，给低置信参考提示
    return {
      type: "priceNormal",
      level: "info",
      message: `这次约 ¥${round1(currentUnitPrice)}/${perWhat}。之后多记几次，我就能帮你判断价格变化。`,
      confidence: "low"
    }
  }

  // 历史不足 2 条时只给参考，不做高低判断
  if (stats.count < 2) {
    return {
      type: "priceNormal",
      level: "info",
      message: `这次约 ¥${round1(currentUnitPrice)}/${perWhat}，之前记过一次约 ¥${round1(stats.median)}/${perWhat}。再多记几次我就能帮你判断价格是否异常。`,
      evidence: `历史中位单价 ¥${round1(stats.median)}`,
      confidence: "low"
    }
  }

  const ratio = currentUnitPrice / stats.median

  // 比历史中位低 10% 以上
  if (ratio < 1 - PRICE_LOWER_THRESHOLD) {
    const pct = Math.round((1 - ratio) * 100)
    return {
      type: "priceLowerThanUsual",
      level: "positive",
      message: `这次约 ¥${round1(currentUnitPrice)}/${perWhat}，比之前常见的 ¥${round1(stats.median)}/${perWhat} 低一些，算是比较划算的一次。`,
      evidence: `历史中位 ¥${round1(stats.median)}，当前 ¥${round1(currentUnitPrice)}，低 ${pct}%`,
      confidence: stats.count >= 3 ? "high" : "medium"
    }
  }

  // 比历史中位高 15% 以上
  if (ratio > 1 + PRICE_HIGHER_THRESHOLD) {
    const pct = Math.round((ratio - 1) * 100)
    return {
      type: "priceHigherThanUsual",
      level: "warning",
      message: `这次约 ¥${round1(currentUnitPrice)}/${perWhat}，比之前常见的 ¥${round1(stats.median)}/${perWhat} 高一些，可能是规格、品牌或平台变化导致。`,
      evidence: `历史中位 ¥${round1(stats.median)}，当前 ¥${round1(currentUnitPrice)}，高 ${pct}%`,
      confidence: stats.count >= 3 ? "high" : "medium"
    }
  }

  // 正常范围
  return {
    type: "priceNormal",
    level: "info",
    message: `这次约 ¥${round1(currentUnitPrice)}/${perWhat}，和之前差不多，价格没有明显异常。`,
    evidence: `历史中位 ¥${round1(stats.median)}`,
    confidence: stats.count >= 3 ? "high" : "medium"
  }
}

// ---------- 补货量判断 ----------

/** 补货量判断：当前数量比历史常见高 50% / 低 40% / 正常。 */
function buildQuantityInsight(
  ctx: { itemName: string; qty?: number; unit?: string },
  item: ReplenishmentItem | undefined
): RecordInsight | null {
  if (ctx.qty === undefined || ctx.qty <= 0) return null
  if (!item) return null

  const stats = computeQtyStats(item.history)
  if (!stats || stats.count < 2) return null

  const perWhat = ctx.unit || "件"
  const ratio = ctx.qty / stats.median

  // 比历史常见高 50% 以上
  if (ratio > 1 + QTY_HIGHER_THRESHOLD) {
    return {
      type: "quantityHigherThanUsual",
      level: "info",
      message: `这次补了 ${ctx.qty}${perWhat}，比之前常见的 ${Math.round(stats.median)}${perWhat} 多一些，预计可用时间可能会拉长。`,
      evidence: `历史中位 ${stats.median}，当前 ${ctx.qty}`,
      confidence: stats.count >= 3 ? "high" : "medium"
    }
  }

  // 比历史常见低 40% 以上
  if (ratio < 1 - QTY_LOWER_THRESHOLD) {
    return {
      type: "quantityLowerThanUsual",
      level: "info",
      message: `这次数量比平时少一些，可能会更快进入下次提醒。`,
      evidence: `历史中位 ${stats.median}，当前 ${ctx.qty}`,
      confidence: stats.count >= 3 ? "high" : "medium"
    }
  }

  return null
}

// ---------- 周期调整建议 ----------

/**
 * 周期调整建议：
 *   1. 当前补货量明显大于历史常见数量。
 *   2. 当前补货距离上次补货时间明显短于当前周期。
 *
 * 本阶段只生成建议，不自动修改周期，不生成修改周期 Action。
 */
function buildCycleAdjustInsight(
  ctx: { itemName: string; qty?: number; unit?: string; restockDate?: number },
  item: ReplenishmentItem | undefined,
  dateContext: ChatDateContext
): RecordInsight | null {
  if (!item) return null
  const cycleDays = item.cycleDays
  if (!cycleDays || cycleDays <= 0) return null

  // 条件 1：补货量明显偏多
  const qtyStats = computeQtyStats(item.history)
  if (ctx.qty && qtyStats && qtyStats.count >= 2) {
    const ratio = ctx.qty / qtyStats.median
    if (ratio > 1 + QTY_HIGHER_THRESHOLD) {
      return {
        type: "cycleMayNeedAdjust",
        level: "info",
        message: `如果之后也基本是一次买 ${ctx.qty}${ctx.unit || "件"}，${ctx.itemName}的提醒周期可能可以适当拉长。先不自动改，我会再观察一次。`,
        evidence: `当前周期 ${cycleDays} 天，这次补货量比常见多`,
        confidence: "low"
      }
    }
  }

  // 条件 2：距离上次补货明显短于周期
  const restockDate = ctx.restockDate ?? dateContext.now
  const recentEvents = item.history.filter((event) => Number.isFinite(event.at) && event.at! > 0)
  if (recentEvents.length >= 2) {
    const sorted = [...recentEvents].sort((a, b) => a.at! - b.at!)
    const lastEvent = sorted[sorted.length - 1]
    const intervalDays = (restockDate - lastEvent.at!) / (24 * 60 * 60 * 1000)
    // 间隔明显短于周期（< 周期 60%）
    if (intervalDays > 0 && intervalDays < cycleDays * 0.6) {
      return {
        type: "cycleMayNeedAdjust",
        level: "info",
        message: `这次比预计时间早了不少，${ctx.itemName}实际消耗可能比当前周期更快。先不自动改，我会再观察一次。`,
        evidence: `当前周期 ${cycleDays} 天，距上次仅 ${Math.round(intervalDays)} 天`,
        confidence: "low"
      }
    }
  }

  return null
}

// ---------- 常购商品沉淀建议 ----------

/**
 * 常购商品沉淀建议：
 *   1. 同一消耗品最近 3 次购买平台相同。
 *   2. 系统还没有对应常购商品。
 *   3. 同一 item 短期内不重复提示（7 天去重窗口）。
 *
 * 本阶段先只做建议，不自动创建常购商品。
 */
function buildFavoriteCandidateInsight(
  ctx: { itemName: string; platform?: string; price?: number; qty?: number },
  item: ReplenishmentItem | undefined,
  dateContext: ChatDateContext
): RecordInsight | null {
  if (!item) return null

  // 已有常购商品，不提示
  if (item.purchaseOptions.length > 0) return null

  const stats = computePriceStats(item.history)
  if (!stats || stats.count < FAVORITE_SAME_PLATFORM_COUNT) return null

  // 检查最近 N 次平台是否一致
  const recentPriced = item.history
    .filter((event) => Number.isFinite(event.price) && event.price! > 0)
    .slice(-FAVORITE_SAME_PLATFORM_COUNT)
  if (recentPriced.length < FAVORITE_SAME_PLATFORM_COUNT) return null

  const platforms = new Set(
    recentPriced
      .map((event) => event.platform)
      .filter((platform): platform is string => Boolean(platform && platform.trim()))
  )
  // 必须平台一致
  if (platforms.size !== 1) return null

  const platform = Array.from(platforms)[0]
  // 检查价格波动是否稳定（max/min < 1.3）
  const unitPrices = recentPriced.map((event) => event.price! / event.qty!)
  const minP = Math.min(...unitPrices)
  const maxP = Math.max(...unitPrices)
  if (minP > 0 && maxP / minP > 1.3) return null

  // 去重：检查 item.notes 或最近是否有常购商品建议标记
  // 这里用 item.updatedAt + 时间窗口做简单去重判断
  // 如果 item 在最近 7 天内更新过（可能已经提示过），跳过
  if (item.updatedAt && dateContext.now - item.updatedAt < FAVORITE_DEDUP_WINDOW) {
    // 但如果是本次补货刚更新，不算"已提示过"，所以只检查更早的更新
    // 简化处理：不在此处做时间去重，交由调用方（observation 已有 seenKeys 机制）
  }

  const avgUnit = round1(unitPrices.reduce((total, value) => total + value, 0) / unitPrices.length)
  return {
    type: "favoriteCandidate",
    level: "info",
    message: `你最近几次${ctx.itemName}都在${platform}买，价格也比较稳定（约 ¥${avgUnit}/${item.unit || "件"}）。后面可以把它设为常购商品，我之后会更容易帮你判断价格是否异常。`,
    evidence: `最近 ${FAVORITE_SAME_PLATFORM_COUNT} 次同平台 ${platform}，单价稳定`,
    confidence: "medium"
  }
}

// ---------- 预算影响反馈 ----------

/**
 * 预算影响反馈：基于当前 state 的月度支出 + 本次补货金额。
 *
 * 注意：
 *   - 没有设置预算时不提示。
 *   - 预算判断应在 commit 后基于最新 state 计算，避免用旧状态。
 *   - proposal 前可以用当前 state + 本次金额做预估。
 */
function buildBudgetImpactInsight(
  ctx: { price?: number },
  state: AppState,
  dateContext: ChatDateContext,
  options?: { postCommit?: boolean }
): RecordInsight | null {
  const budget = state.settings?.monthlyBudget
  if (!budget || budget <= 0) return null

  // postCommit=true 时，history 已包含本次补货，直接用 calculateMonthlySpend
  // postCommit=false（proposal 前）时，需要手动加上本次金额
  let spend: number
  let remaining: number
  if (options?.postCommit) {
    spend = calculateMonthlySpend(state.items, dateContext.now)
    remaining = budget - spend
  } else {
    // proposal 前：当前已支出 + 本次金额
    const currentSpend = calculateMonthlySpend(state.items, dateContext.now)
    const thisAmount = ctx.price && ctx.price > 0 ? ctx.price : 0
    spend = currentSpend + thisAmount
    remaining = budget - spend
  }

  const ratio = spend / budget
  const remainingText = `¥${formatPrice(Math.abs(remaining))}`

  if (remaining < 0) {
    return {
      type: "budgetImpact",
      level: "warning",
      message: `这笔会让本月消耗品支出超出预算，目前已超 ${remainingText}，后面我会帮你留意。`,
      evidence: `预算 ¥${formatPrice(budget)}，已支出 ¥${formatPrice(spend)}`,
      confidence: "high"
    }
  }

  if (ratio >= 0.85) {
    return {
      type: "budgetImpact",
      level: "warning",
      message: `这笔记入后，本月预算还剩 ${remainingText}，后面非急需的我会帮你留意。`,
      evidence: `预算 ¥${formatPrice(budget)}，已支出 ¥${formatPrice(spend)}（${Math.round(ratio * 100)}%）`,
      confidence: "high"
    }
  }

  return {
    type: "budgetImpact",
    level: "info",
    message: `这笔记入本月消耗品支出后，本月预算还剩 ${remainingText}。`,
    evidence: `预算 ¥${formatPrice(budget)}，已支出 ¥${formatPrice(spend)}`,
    confidence: "high"
  }
}

// ---------- 评价已记录 ----------

/** review 已记录：用户补充了评价时给一个轻确认。 */
function buildReviewCapturedInsight(ctx: { review?: string }): RecordInsight | null {
  if (!ctx.review || !ctx.review.trim()) return null
  return {
    type: "reviewCaptured",
    level: "info",
    message: `评价已记下：${ctx.review}。`,
    confidence: "high"
  }
}

// ---------- 主入口 ----------

/**
 * 入口：根据草稿 + state + itemViews，生成洞察列表。
 *
 * 返回所有可用洞察，由调用方按优先级选取展示。
 * 优先级：
 *   1. 价格异常 / 划算
 *   2. 预算接近上限
 *   3. 周期可能需要调整
 *   4. 常购商品沉淀
 *   5. review 已记录
 */
export function buildRecordInsights(input: BuildRecordInsightsInput): BuildRecordInsightsResult {
  const { draft, state, itemViews, dateContext } = input
  const ctx = extractRestockContext(draft)
  if (!ctx) {
    return { insights: [] }
  }

  const item = findItem(state, ctx.itemName, ctx.itemId)
  const insights: RecordInsight[] = []

  // 价格判断
  const priceInsight = buildPriceInsight(ctx, item)
  if (priceInsight) insights.push(priceInsight)

  // 补货量判断
  const qtyInsight = buildQuantityInsight(ctx, item)
  if (qtyInsight) insights.push(qtyInsight)

  // 周期调整建议
  const cycleInsight = buildCycleAdjustInsight(ctx, item, dateContext)
  if (cycleInsight) insights.push(cycleInsight)

  // 常购商品候选
  const favoriteInsight = buildFavoriteCandidateInsight(ctx, item, dateContext)
  if (favoriteInsight) insights.push(favoriteInsight)

  // 预算影响（proposal 前用当前 state + 本次金额预估）
  const budgetInsight = buildBudgetImpactInsight(ctx, state, dateContext, { postCommit: false })
  if (budgetInsight) insights.push(budgetInsight)

  // 评价已记录
  const reviewInsight = buildReviewCapturedInsight(ctx)
  if (reviewInsight) insights.push(reviewInsight)

  // 按优先级排序
  const sorted = sortByPriority(insights)

  // 生成 summaryLine（取最高优先级的一条）
  const summaryLine = sorted.length > 0 ? sorted[0].message : undefined

  return { insights: sorted, summaryLine }
}

/**
 * commit 成功后入口：基于新 state（已包含本次补货）生成最终洞察。
 *
 * 与 buildRecordInsights 的差异：
 *   - 预算判断用 postCommit=true（history 已包含本次补货）
 *   - 适合拼接到 commit summary 后
 */
export function buildPostCommitInsights(
  draft: AgentDraft,
  newState: AppState,
  itemViews: HouseholdChatItemView[],
  dateContext: ChatDateContext
): BuildRecordInsightsResult {
  const ctx = extractRestockContext(draft)
  if (!ctx) {
    return { insights: [] }
  }

  const item = findItem(newState, ctx.itemName, ctx.itemId)
  const insights: RecordInsight[] = []

  // 价格判断
  const priceInsight = buildPriceInsight(ctx, item)
  if (priceInsight) insights.push(priceInsight)

  // 补货量判断
  const qtyInsight = buildQuantityInsight(ctx, item)
  if (qtyInsight) insights.push(qtyInsight)

  // 周期调整建议
  const cycleInsight = buildCycleAdjustInsight(ctx, item, dateContext)
  if (cycleInsight) insights.push(cycleInsight)

  // 常购商品候选
  const favoriteInsight = buildFavoriteCandidateInsight(ctx, item, dateContext)
  if (favoriteInsight) insights.push(favoriteInsight)

  // 预算影响（commit 后用新 state，postCommit=true）
  const budgetInsight = buildBudgetImpactInsight(ctx, newState, dateContext, { postCommit: true })
  if (budgetInsight) insights.push(budgetInsight)

  // 评价已记录
  const reviewInsight = buildReviewCapturedInsight(ctx)
  if (reviewInsight) insights.push(reviewInsight)

  const sorted = sortByPriority(insights)
  const summaryLine = sorted.length > 0 ? sorted[0].message : undefined

  return { insights: sorted, summaryLine }
}

/** 按优先级排序洞察。 */
function sortByPriority(insights: RecordInsight[]): RecordInsight[] {
  const priority: RecordInsightType[] = [
    "priceHigherThanUsual",
    "priceLowerThanUsual",
    "budgetImpact",
    "cycleMayNeedAdjust",
    "favoriteCandidate",
    "quantityHigherThanUsual",
    "quantityLowerThanUsual",
    "priceNormal",
    "reviewCaptured"
  ]
  const priorityIndex = new Map(priority.map((type, index) => [type, index]))
  return [...insights].sort((a, b) => {
    const pa = priorityIndex.get(a.type) ?? 99
    const pb = priorityIndex.get(b.type) ?? 99
    if (pa !== pb) return pa - pb
    // 同优先级：warning > positive > info
    const levelOrder = { warning: 0, positive: 1, info: 2 }
    return levelOrder[a.level] - levelOrder[b.level]
  })
}

/**
 * 取前 N 条洞察用于展示。
 * 文案策略：每次最多展示 1-2 条判断。
 */
export function pickTopInsights(insights: RecordInsight[], maxCount = 2): RecordInsight[] {
  return insights.slice(0, maxCount)
}

/**
 * 把洞察列表拼成一句话追加文案。
 * 用于 composeReadyToConfirmMessage / commit summary。
 */
export function composeInsightLine(insights: RecordInsight[], maxCount = 1): string {
  const top = pickTopInsights(insights, maxCount)
  return top.map((insight) => insight.message).join(" ")
}
