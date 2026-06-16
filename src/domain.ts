import type { AppState, ConsumptionInfo, ItemComputed, ItemDraft, ItemUrgency, PriceAnchor, ReplenishmentItem } from "./types"

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
  const depletionAt = addDays(item.lastRestockedAt, item.cycleDays)
  const dueAt = addDays(depletionAt, -item.bufferDays)
  const daysUntilDue = differenceInDays(dueAt, now)
  const daysUntilDepletion = differenceInDays(depletionAt, now)
  const isSnoozed = Number(item.snoozeUntil || 0) > now
  const status: ItemUrgency = daysUntilDepletion <= 0
    ? "urgent"
    : daysUntilDue <= 0
      ? "warning"
      : "normal"
  const statusLabel = status === "urgent" ? "急需补货" : status === "warning" ? "快用完" : "充足"
  const displayStatus = status
  const isDue = !isSnoozed && status !== "normal"

  let remainingText = `还剩约 ${Math.max(0, daysUntilDepletion)} 天`
  let statusText = statusLabel
  if (daysUntilDepletion < 0) remainingText = `预计已用完 ${Math.abs(daysUntilDepletion)} 天`
  if (daysUntilDepletion === 0) remainingText = "预计今天用完"
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

export function calculateMonthlySpend(items: ReplenishmentItem[], now = Date.now()): number {
  const monthStart = new Date(now)
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)
  const nextMonth = new Date(monthStart)
  nextMonth.setMonth(nextMonth.getMonth() + 1)

  return items.reduce((total, item) => total + item.history.reduce((itemTotal, event) => {
    const price = Number(event.price)
    if (event.at < monthStart.getTime() || event.at >= nextMonth.getTime() || !Number.isFinite(price) || price < 0) {
      return itemTotal
    }
    return itemTotal + price
  }, 0), 0)
}

export function nextSnoozeTime(hour: number, now = Date.now()): number {
  const target = new Date(now)
  target.setDate(target.getDate() + 1)
  target.setHours(hour, 0, 0, 0)
  return target.getTime()
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

export function restockItem(item: ReplenishmentItem, now = Date.now(), price?: number, qty?: number, platform?: string): ReplenishmentItem {
  const actualInterval = item.anchorEstimated ? undefined : Math.max(1, differenceInDays(now, item.lastRestockedAt))
  const history = [
    ...item.history,
    { id: id("restock"), at: now, intervalDays: actualInterval, price, qty, platform }
  ]
  const intervals = history.flatMap((event) => event.intervalDays ? [event.intervalDays] : [])
  const candidate = item.learningEnabled !== false ? weightedCycle(intervals, item.cycleDays) : undefined
  const meaningfulChange = candidate && Math.abs(candidate - item.cycleDays) >= Math.max(2, item.cycleDays * 0.15)

  return {
    ...item,
    lastRestockedAt: startOfDay(now),
    anchorEstimated: false,
    history,
    price: price ?? item.price,
    platform: platform || item.platform,
    snoozeUntil: undefined,
    orderedAt: undefined,
    suggestedCycleDays: meaningfulChange ? candidate : undefined,
    updatedAt: now
  }
}

export function calibrateRemainingDays(item: ReplenishmentItem, remainingDays: number, now = Date.now()): ReplenishmentItem {
  const normalizedRemainingDays = Math.min(item.cycleDays, Math.max(0, Math.round(remainingDays)))
  return {
    ...item,
    lastRestockedAt: addDays(now, -(item.cycleDays - normalizedRemainingDays)),
    anchorEstimated: true,
    updatedAt: now
  }
}

export function createItem(draft: ItemDraft, now = Date.now()): ReplenishmentItem {
  const remainingDays = draft.remainingDays === "" ? draft.cycleDays : Number(draft.remainingDays)
  const anchorOffset = Math.max(0, draft.cycleDays - Math.max(0, remainingDays))
  const cycleDays = Math.max(1, Number(draft.cycleDays))
  return {
    id: id("item"),
    name: draft.name.trim(),
    category: draft.category.trim() || "其他用品",
    type: "learning",
    learningEnabled: draft.learningEnabled,
    cycleDays,
    bufferDays: Math.min(Math.max(0, cycleDays - 1), Math.max(0, Number(draft.bufferDays))),
    lastRestockedAt: addDays(now, -anchorOffset),
    anchorEstimated: true,
    history: [],
    link: draft.link.trim() || undefined,
    unit: draft.unit.trim() || undefined,
    platform: draft.platform.trim() || undefined,
    defaultQty: draft.defaultQty ? Math.max(1, Number(draft.defaultQty)) : undefined,
    createdAt: now,
    updatedAt: now
  }
}

export function updateItemFromDraft(item: ReplenishmentItem, draft: ItemDraft): ReplenishmentItem {
  const cycleDays = Math.max(1, Number(draft.cycleDays))
  return {
    ...item,
    name: draft.name.trim(),
    category: draft.category.trim() || "其他用品",
    type: "learning",
    learningEnabled: draft.learningEnabled,
    cycleDays,
    bufferDays: Math.min(Math.max(0, cycleDays - 1), Math.max(0, Number(draft.bufferDays))),
    link: draft.link.trim() || undefined,
    unit: draft.unit.trim() || undefined,
    platform: draft.platform.trim() || undefined,
    defaultQty: draft.defaultQty ? Math.max(1, Number(draft.defaultQty)) : undefined,
    suggestedCycleDays: undefined,
    updatedAt: Date.now()
  }
}

function daysAgo(days: number): number {
  return addDays(Date.now(), -days)
}

export function createInitialState(): AppState {
  const now = Date.now()
  const item = (
    name: string,
    category: string,
    cycleDays: number,
    bufferDays: number,
    elapsedDays: number,
    type: "learning" | "fixed" = "learning",
  ): ReplenishmentItem => ({
    id: id("item"),
    name,
    category,
    type,
    learningEnabled: true,
    cycleDays,
    bufferDays,
    lastRestockedAt: daysAgo(elapsedDays),
    anchorEstimated: true,
    history: [],
    createdAt: now,
    updatedAt: now
  })

  return {
    version: 2,
    categories: ["卫生间", "厨房", "洗衣清洁", "宠物用品", "日常护理", "饮品零食", "其他用品"],
    items: [
      item("鸡蛋", "厨房", 10, 2, 8),
      item("卫生纸", "卫生间", 30, 5, 31),
      item("牛奶", "厨房", 7, 2, 3),
      item("洗洁精", "厨房", 35, 5, 18),
      item("猫砂", "宠物用品", 14, 3, 12),
      item("猫粮", "宠物用品", 30, 5, 10),
      item("洗衣液", "洗衣清洁", 45, 7, 16),
      item("洗衣凝珠", "洗衣清洁", 32, 5, 29),
      item("洗发水", "日常护理", 60, 7, 22),
      item("卸妆棉", "日常护理", 28, 4, 25),
      item("咖啡豆", "饮品零食", 21, 4, 18),
      item("气泡水", "饮品零食", 12, 2, 4),
      item("扫地机滤芯", "其他用品", 90, 7, 20, "fixed")
    ],
    settings: {
      reminderIntervalMinutes: 60,
      idleThresholdMinutes: 5,
      quietStart: "22:00",
      quietEnd: "08:00",
      snoozeUntilHour: 8
    },
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

export function calculateConsumption(item: ReplenishmentItem): ConsumptionInfo {
  const qtyEvents = item.history.filter((e) => Number.isFinite(e.qty) && e.qty! > 0)
  if (!qtyEvents.length || !item.cycleDays) {
    return { dailyUse: null, dailyUseText: "暂无数据" }
  }

  const latest = qtyEvents[qtyEvents.length - 1]
  const dailyUse = latest.qty! / item.cycleDays

  const unit = item.unit || "件"
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
  const unit = item.unit || "件"

  return `约 ${Math.round(remainingQty)} ${unit}`
}

export function getLatestRating(item: ReplenishmentItem): number | null {
  const rated = item.history.filter((e) => e.rating !== undefined).reverse()
  if (!rated.length) return null
  return rated[0].rating ?? null
}

export function formatUnitPrice(price: number, unit: string): string {
  return `¥${formatPrice(price)}/${unit}`
}
