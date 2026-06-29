import type { AppState, ConsumptionInfo, ItemComputed, ItemDraft, ItemUrgency, PriceAnchor, PricingMode, ReplenishmentItem, RestockEvent } from "./types"
import { createInitialOnboardingState } from "./model/onboarding"
// calculateMonthlySpend 的实现放在 pure-logic.mjs，供 .mjs 测试直接 import；
// 这里仅按类型重新导出，保持 domain.ts 对外 API 不变。
export { calculateMonthlySpend } from "./pure-logic.mjs"

const DAY_MS = 24 * 60 * 60 * 1000

export const DEFAULT_CYCLES: Record<string, number> = {
  卫生纸: 30,
  抽纸: 24,
  牛奶: 7,
  鸡蛋: 10,
  洗衣液: 45,
  沐浴露: 60,
  猫砂: 14,
  猫粮: 30,
  大桶水: 10
}

export function id(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export function startOfDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export function addDays(timestamp: number, days: number): number {
  const date = new Date(timestamp)
  date.setDate(date.getDate() + days)
  return startOfDay(date.getTime())
}

function calendarDayNumber(timestamp: number): number {
  const date = new Date(timestamp)
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS)
}

export function differenceInDays(later: number, earlier: number): number {
  return calendarDayNumber(later) - calendarDayNumber(earlier)
}

export function computeItem(item: ReplenishmentItem, now = Date.now()): ItemComputed {
  const depletionAt = Number.isFinite(item.inventoryDepletionAt)
    ? startOfDay(item.inventoryDepletionAt!)
    : addDays(item.lastRestockedAt, item.cycleDays)
  const dueAt = addDays(depletionAt, -item.bufferDays)
  const daysUntilDue = differenceInDays(dueAt, now)
  const daysUntilDepletion = differenceInDays(depletionAt, now)
  const isSnoozed = Number(item.snoozeUntil || 0) > now
  const status: ItemUrgency = daysUntilDepletion <= 0
    ? "urgent"
    : daysUntilDue <= 0
      ? "warning"
      : "normal"
  const isLowConfidence = item.source === "onboarding" && item.confidence === "low"
  const statusLabel: ItemComputed["statusLabel"] = isLowConfidence
    ? status === "normal" ? "初始估算中" : "可能快到补货周期了"
    : status === "urgent" ? "急需补货" : status === "warning" ? "快用完" : "充足"
  const displayStatus = status
  const isDue = !isSnoozed && status !== "normal"

  let remainingText = isLowConfidence
    ? status === "normal" ? `约 ${Math.max(0, daysUntilDepletion)} 天后再看看` : "现在还够用吗？"
    : `还剩约 ${Math.max(0, daysUntilDepletion)} 天`
  let statusText: string = statusLabel
  if (!isLowConfidence && daysUntilDepletion < 0) remainingText = `预计已用完 ${Math.abs(daysUntilDepletion)} 天`
  if (!isLowConfidence && daysUntilDepletion === 0) remainingText = "预计今天用完"
  if (isSnoozed && status !== "normal") statusText = `${statusLabel} · 已推迟至 ${formatDateTime(item.snoozeUntil!)}`

  return {
    status,
    displayStatus,
    statusLabel,
    dueAt,
    depletionAt,
    daysUntilDue,
    daysUntilDepletion,
    isDue,
    isSnoozed,
    remainingText,
    statusText
  }
}

export function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(timestamp)
}

export function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(timestamp)
}

export function formatPrice(value: number): string {
  return value.toFixed(2)
}

export function formatCompactPrice(value: number): string {
  return value.toFixed(1)
}

export function nextSnoozeTime(hours: number, now = Date.now()): number {
  const safeHours = Math.min(24, Math.max(1, Math.round(Number(hours) || 1)))
  return now + safeHours * 60 * 60 * 1000
}

function weightedCycle(intervals: number[], currentCycle: number): number | undefined {
  if (!intervals.length) return undefined
  const lower = Math.max(1, currentCycle * 0.5)
  const upper = currentCycle * 1.5
  let weightedTotal = 0
  let weightTotal = 0
  intervals.slice(-5).forEach((interval, index, list) => {
    const weight = index + 2
    const clipped = Math.min(upper, Math.max(lower, interval))
    weightedTotal += clipped * weight
    weightTotal += weight
    if (index === list.length - 1) {
      weightedTotal += clipped
      weightTotal += 1
    }
  })
  return Math.max(1, Math.round(weightedTotal / weightTotal))
}


function safeRestockQty(value: number | undefined): number {
  return Number.isFinite(value) && value! >= 1 ? Math.round(value!) : 1
}

function normalizeRestockHistory(history: RestockEvent[]): RestockEvent[] {
  return history
    .slice()
    .sort((a, b) => a.at - b.at)
    .map((event, index, list) => ({
      ...event,
      at: startOfDay(event.at),
      intervalDays: index > 0 ? Math.max(1, differenceInDays(event.at, list[index - 1].at)) : event.intervalDays
    }))
}

export function restockItem(
  item: ReplenishmentItem,
  now = Date.now(),
  price?: number,
  qty?: number,
  platform?: string,
  purchaseOptionId?: string,
  purchaseProductName?: string,
  purchaseUnit?: string,
  purchasePricingMode?: PricingMode,
  purchaseMeasureBaseAmount?: number,
  purchaseMeasureAmount?: number,
  purchaseMeasureUnit?: string,
  review?: string,
  restockDate?: number
): ReplenishmentItem {
  const effectiveRestockAt = restockDate !== undefined ? startOfDay(restockDate) : startOfDay(now)
  const actualInterval = item.anchorEstimated
    ? undefined
    : Math.max(1, differenceInDays(effectiveRestockAt, item.lastRestockedAt))

  const safeQty = safeRestockQty(qty)

  const history = normalizeRestockHistory([
    ...item.history,
    {
      id: id("restock"),
      at: effectiveRestockAt,
      intervalDays: actualInterval,
      price,
      qty: safeQty,
      platform: platform?.trim() || undefined,
      purchaseOptionId: purchaseOptionId?.trim() || undefined,
      purchaseProductName: purchaseProductName?.trim() || undefined,
      purchaseUnit: purchaseUnit?.trim() || undefined,
      purchasePricingMode,
      purchaseMeasureBaseAmount: Number.isFinite(purchaseMeasureBaseAmount) && purchaseMeasureBaseAmount! > 0 ? purchaseMeasureBaseAmount : undefined,
      purchaseMeasureAmount: Number.isFinite(purchaseMeasureAmount) && purchaseMeasureAmount! > 0 ? purchaseMeasureAmount : undefined,
      purchaseMeasureUnit: purchaseMeasureUnit?.trim() || undefined,
      review: review?.trim() || undefined
    }
  ])

  const previousQty = safeRestockQty(item.history[item.history.length - 1]?.qty)
  const currentSingleItemCycle = Math.max(1, Math.round(item.cycleDays / previousQty))

  const singleItemIntervals = history.flatMap((event, index) => {
    if (!event.intervalDays) return []
    const batchQty = index > 0 ? safeRestockQty(history[index - 1]?.qty) : 1
    return [Math.max(1, event.intervalDays / batchQty)]
  })

  const singleItemCandidate = item.learningEnabled !== false
    ? weightedCycle(singleItemIntervals, currentSingleItemCycle)
    : undefined

  const candidateCycleDays = singleItemCandidate
    ? Math.max(1, Math.round(singleItemCandidate * safeQty))
    : undefined

  // 周期学习必须先建议，用户确认后才生效：
  // - 候选周期与当前 cycleDays 不同时，写入 suggestedCycleDays，不覆盖 cycleDays；
  // - 固定周期或关闭学习的物品不生成建议；
  // - 差异过小（<1 天）时不生成建议，避免频繁打扰。
  const hasSuggestion = candidateCycleDays !== undefined && Math.abs(candidateCycleDays - item.cycleDays) >= 1
  const newCycleDays = hasSuggestion ? item.cycleDays : (candidateCycleDays ?? item.cycleDays)
  const suggestedCycleDays = hasSuggestion ? candidateCycleDays : undefined

  const confidence = item.source === "onboarding"
    ? history.length >= 2 ? "high" : "medium"
    : item.confidence

  const latestRestock = history[history.length - 1]

  return {
    ...item,
    cycleDays: newCycleDays,
    lastRestockedAt: latestRestock?.at ?? effectiveRestockAt,
    inventoryDepletionAt: undefined,
    anchorEstimated: false,
    history,
    price: price ?? item.price,
    platform: platform || item.platform,
    snoozeUntil: undefined,
    suggestedCycleDays,
    confidence,
    inventoryStatus: "justRestocked",
    modelNote: item.source === "onboarding"
      ? history.length >= 2 ? "已根据多次真实补货记录学习周期" : "已记录首次真实补货，继续观察中"
      : item.modelNote,
    updatedAt: now
  }
}

export function updateRestockRecord(
  item: ReplenishmentItem,
  eventId: string,
  patch: Pick<RestockEvent, "at" | "qty" | "price"> & Partial<Pick<RestockEvent, "platform" | "purchasePricingMode" | "purchaseMeasureBaseAmount" | "purchaseMeasureAmount" | "purchaseMeasureUnit" | "review">>,
  now = Date.now()
): ReplenishmentItem {
  const history = normalizeRestockHistory(item.history.map((event) => event.id === eventId
    ? {
        ...event,
        at: startOfDay(patch.at),
        qty: safeRestockQty(patch.qty),
        price: Math.max(0, Number(patch.price) || 0),
        platform: patch.platform?.trim() || undefined,
        purchasePricingMode: patch.purchasePricingMode,
        purchaseMeasureBaseAmount: Number.isFinite(patch.purchaseMeasureBaseAmount) && patch.purchaseMeasureBaseAmount! > 0 ? patch.purchaseMeasureBaseAmount : undefined,
        purchaseMeasureAmount: Number.isFinite(patch.purchaseMeasureAmount) && patch.purchaseMeasureAmount! > 0 ? patch.purchaseMeasureAmount : undefined,
        purchaseMeasureUnit: patch.purchaseMeasureUnit?.trim() || undefined,
        review: patch.review?.trim() || undefined
      }
    : event
  ))
  const latestRestock = history[history.length - 1]

  return {
    ...item,
    history,
    lastRestockedAt: latestRestock?.at ?? item.lastRestockedAt,
    price: latestRestock?.price ?? item.price,
    platform: latestRestock?.platform || item.platform,
    updatedAt: now
  }
}

export function calibrateRemainingDays(item: ReplenishmentItem, remainingDays: number, now = Date.now()): ReplenishmentItem {
  const normalizedRemainingDays = Math.max(0, Math.round(remainingDays))
  return {
    ...item,
    inventoryDepletionAt: addDays(now, normalizedRemainingDays),
    anchorEstimated: true,
    updatedAt: now
  }
}

export function createItem(draft: ItemDraft, now = Date.now()): ReplenishmentItem {
  const cycleDays = Math.max(1, Number(draft.cycleDays))
  const parsedInventoryDays = Number(draft.remainingDays)
  const inventoryDays = draft.remainingDays === "" || !Number.isFinite(parsedInventoryDays)
    ? undefined
    : Math.max(0, Math.round(parsedInventoryDays))
  return {
    id: id("item"),
    name: draft.name.trim(),
    category: draft.category.trim() || "其他用品",
    type: "learning",
    learningEnabled: draft.learningEnabled,
    cycleDays,
    bufferDays: Math.min(Math.max(0, cycleDays - 1), Math.max(0, Number(draft.bufferDays))),
    lastRestockedAt: startOfDay(now),
    inventoryDepletionAt: inventoryDays === undefined ? undefined : addDays(now, inventoryDays),
    anchorEstimated: true,
    purchaseOptions: draft.purchaseOptions || [],
    history: [],
    link: draft.link.trim() || undefined,
    price: draft.price !== undefined ? draft.price : undefined,
    unit: draft.unit.trim() || undefined,
    platform: draft.platform.trim() || undefined,
    defaultQty: draft.defaultQty ? Math.max(1, Number(draft.defaultQty)) : undefined,
    source: "manual",
    confidence: "medium",
    createdAt: now,
    updatedAt: now
  }
}

export function updateItemFromDraft(item: ReplenishmentItem, draft: ItemDraft): ReplenishmentItem {
  const cycleDays = Math.max(1, Number(draft.cycleDays))
  const now = Date.now()
  const parsedInventoryDays = Number(draft.remainingDays)
  const inventoryDays = draft.remainingDays === "" || !Number.isFinite(parsedInventoryDays)
    ? undefined
    : Math.max(0, Math.round(parsedInventoryDays))
  return {
    ...item,
    name: draft.name.trim(),
    category: draft.category.trim() || "其他用品",
    type: "learning",
    learningEnabled: draft.learningEnabled,
    cycleDays,
    bufferDays: Math.min(Math.max(0, cycleDays - 1), Math.max(0, Number(draft.bufferDays))),
    inventoryDepletionAt: inventoryDays === undefined ? item.inventoryDepletionAt : addDays(now, inventoryDays),
    link: draft.link.trim() || undefined,
    unit: draft.unit.trim() || undefined,
    platform: draft.platform.trim() || undefined,
    defaultQty: draft.defaultQty ? Math.max(1, Number(draft.defaultQty)) : undefined,
    purchaseOptions: (draft.purchaseOptions || item.purchaseOptions).map((option) => ({
      ...option,
      unit: option.unit || draft.unit.trim() || "件"
    })),
    suggestedCycleDays: undefined,
    updatedAt: now
  }
}

export function createInitialState(): AppState {
  const now = Date.now()

  return {
    version: 3,
    categories: ["卫生间", "厨房", "洗衣清洁", "宠物用品", "日常护理", "饮品零食", "其他用品"],
    items: [],
    settings: {
      reminderIntervalHours: 1,
      quietStart: "22:00",
      quietEnd: "08:00",
      notificationEnabled: true
    },
    householdProfile: null,
    onboarding: createInitialOnboardingState(now),
    updatedAt: now
  }
}

export function calculatePriceAnchor(history: ReplenishmentItem["history"]): PriceAnchor {
  const priced = history.filter((e) =>
    Number.isFinite(e.price) && e.price! > 0 &&
    Number.isFinite(e.qty) && e.qty! > 0
  )
  if (!priced.length) {
    return { lowestUnitPrice: null, avgUnitPrice: null, latestUnitPrice: null, priceCount: 0 }
  }

  const unitPrices = priced.map((e) => e.price! / e.qty!)
  return {
    lowestUnitPrice: Math.min(...unitPrices),
    avgUnitPrice: unitPrices.reduce((a, b) => a + b, 0) / unitPrices.length,
    latestUnitPrice: unitPrices[unitPrices.length - 1],
    priceCount: priced.length
  }
}

function getConsumptionUnit(item: ReplenishmentItem): string {
  const latestWithUnit = item.history.slice().reverse().find((event) => event.purchaseUnit?.trim())
  if (latestWithUnit?.purchaseUnit) return latestWithUnit.purchaseUnit
  const firstOptionUnit = item.purchaseOptions?.find((option) => option.unit?.trim())?.unit
  return firstOptionUnit || item.unit || "件"
}

export function calculateConsumption(item: ReplenishmentItem): ConsumptionInfo {
  const qtyEvents = item.history.filter((e) => Number.isFinite(e.qty) && e.qty! > 0)
  if (!qtyEvents.length || !item.cycleDays) {
    return { dailyUse: null, dailyUseText: "暂无数据" }
  }

  const latest = qtyEvents[qtyEvents.length - 1]
  const dailyUse = latest.qty! / item.cycleDays

  const unit = getConsumptionUnit(item)
  const formatted = dailyUse < 0.1
    ? dailyUse.toFixed(2)
    : dailyUse < 1
      ? dailyUse.toFixed(1)
      : String(Math.round(dailyUse * 10) / 10)

  return {
    dailyUse,
    dailyUseText: `约 ${formatted} ${unit}/天`
  }
}

export function estimateRemainingQty(item: ReplenishmentItem, now = Date.now()): string | null {
  const consumption = calculateConsumption(item)
  if (!consumption.dailyUse) return null

  const computed = computeItem(item, now)
  const remainingDays = Math.max(0, computed.daysUntilDepletion)
  const remainingQty = remainingDays * consumption.dailyUse
  const unit = getConsumptionUnit(item)

  return `约 ${Math.round(remainingQty)} ${unit}`
}

export function getLatestRating(item: ReplenishmentItem): number | null {
  const rated = item.history.filter((e) => e.rating !== undefined).reverse()
  if (!rated.length) return null
  return rated[0].rating ?? null
}

export function formatUnitPrice(price: number, unit: string): string {
  return `¥${price.toFixed(1)}/${unit}`
}
