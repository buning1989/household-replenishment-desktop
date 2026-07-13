// 跨 renderer / main / 测试共享的纯逻辑。
// 这些函数不得依赖 React、Electron 或任何副作用，仅做纯计算。
// 类型声明见 pure-logic.d.ts。

const DAY_MS = 24 * 60 * 60 * 1000

export function startOfDay(timestamp) {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export function addDays(timestamp, days) {
  const date = new Date(timestamp)
  date.setDate(date.getDate() + days)
  return startOfDay(date.getTime())
}

function calendarDayNumber(timestamp) {
  const date = new Date(timestamp)
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS)
}

export function differenceInDays(later, earlier) {
  return calendarDayNumber(later) - calendarDayNumber(earlier)
}

function weightedCycle(intervals, currentCycle) {
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

function safeRestockQty(value) {
  return Number.isFinite(value) && value >= 1 ? Math.round(value) : 1
}

function normalizeRestockHistory(history) {
  return history
    .slice()
    .sort((a, b) => a.at - b.at)
    .map((event, index, list) => ({
      ...event,
      at: startOfDay(event.at),
      intervalDays: index > 0 ? Math.max(1, differenceInDays(event.at, list[index - 1].at)) : event.intervalDays
    }))
}

export function restockItemCore(input) {
  const {
    item,
    eventId,
    now = Date.now(),
    price,
    qty,
    platform,
    purchaseOptionId,
    purchaseProductName,
    purchaseUnit,
    purchasePricingMode,
    purchaseMeasureBaseAmount,
    purchaseMeasureAmount,
    purchaseMeasureUnit,
    review,
    restockDate
  } = input
  const effectiveRestockAt = restockDate !== undefined ? startOfDay(restockDate) : startOfDay(now)
  const actualInterval = item.anchorEstimated
    ? undefined
    : Math.max(1, differenceInDays(effectiveRestockAt, item.lastRestockedAt))

  const safeQty = safeRestockQty(qty)

  const history = normalizeRestockHistory([
    ...item.history,
    {
      id: eventId,
      at: effectiveRestockAt,
      intervalDays: actualInterval,
      price,
      qty: safeQty,
      platform: platform?.trim() || undefined,
      purchaseOptionId: purchaseOptionId?.trim() || undefined,
      purchaseProductName: purchaseProductName?.trim() || undefined,
      purchaseUnit: purchaseUnit?.trim() || undefined,
      purchasePricingMode,
      purchaseMeasureBaseAmount: Number.isFinite(purchaseMeasureBaseAmount) && purchaseMeasureBaseAmount > 0 ? purchaseMeasureBaseAmount : undefined,
      purchaseMeasureAmount: Number.isFinite(purchaseMeasureAmount) && purchaseMeasureAmount > 0 ? purchaseMeasureAmount : undefined,
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

  const hasSuggestion = candidateCycleDays !== undefined && Math.abs(candidateCycleDays - item.cycleDays) >= 1
  const newCycleDays = hasSuggestion ? item.cycleDays : (candidateCycleDays ?? item.cycleDays)
  const suggestedCycleDays = hasSuggestion ? candidateCycleDays : undefined

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
    confidence: item.confidence,
    inventoryStatus: "justRestocked",
    modelNote: item.modelNote,
    updatedAt: now
  }
}

/**
 * 计算 RestockModal 的 canConfirm 状态。
 * 不再强制要求 selectedOption：item 没有 purchaseOptions 时也能直接补货。
 *
 * 校验规则：
 * - qty >= 1
 * - price 合法且 >= 0
 * - restockDate 合法
 * - 仅在选择按含量计价的常购商品时，要求 measureAmount / measureUnit
 */
export function canConfirmRestock(input) {
  const { qty, price, restockDateValid, usesMeasurePricing, measureAmount, measureUnit } = input
  const qtyValid = !!qty && Number(qty) >= 1
  const priceValid = price !== '' && Number(price) >= 0 && Number.isFinite(Number(price))
  const measureValid = !usesMeasurePricing
    || (!!measureAmount && Number(measureAmount) > 0 && !!measureUnit)
  return qtyValid && priceValid && restockDateValid && measureValid
}

/**
 * 删除分类的纯状态转换。
 * 非空分类在没有 moveToCategory、没有 deleteItemsConfirmed 时拒绝删除，避免误删物品。
 *
 * 返回：
 * - { ok: false, reason, state } 拒绝删除（state 为原 state）
 * - { ok: true, state } 删除成功（state 为新 state）
 */
export function applyDeleteCategory(state, category, options) {
  const itemCount = (state.items || []).filter((item) => item.category === category).length
  if (itemCount > 0 && !options?.moveToCategory && !options?.deleteItemsConfirmed) {
    return {
      ok: false,
      reason: "non-empty-category-requires-move-or-confirm",
      state
    }
  }
  const now = Date.now()
  const nextState = {
    ...state,
    categories: (state.categories || []).filter((name) => name !== category),
    items: options?.moveToCategory
      ? (state.items || []).map((item) =>
        item.category === category
          ? { ...item, category: options.moveToCategory, updatedAt: now }
          : item
      )
      : options?.deleteItemsConfirmed
        ? (state.items || []).filter((item) => item.category !== category)
        : (state.items || []),
    updatedAt: now
  }
  return { ok: true, state: nextState }
}

/**
 * 计算当月已支出。与 domain.ts / electron/main.js 的统计口径保持一致：
 * - 包含 monthStart（当月 1 日 00:00）
 * - 不包含 nextMonthStart（下月 1 日 00:00）
 * - 仅统计 price 为合法非负数的记录
 */
export function calculateMonthlySpend(items, now = Date.now()) {
  const monthStart = new Date(now)
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)
  const nextMonth = new Date(monthStart)
  nextMonth.setMonth(nextMonth.getMonth() + 1)
  const monthStartMs = monthStart.getTime()
  const nextMonthMs = nextMonth.getTime()

  return (items || []).reduce((total, item) => {
    const history = item && Array.isArray(item.history) ? item.history : []
    return total + history.reduce((itemTotal, event) => {
      const price = Number(event.price)
      if (
        !Number.isFinite(event.at) ||
        event.at < monthStartMs ||
        event.at >= nextMonthMs ||
        !Number.isFinite(price) ||
        price < 0
      ) {
        return itemTotal
      }
      return itemTotal + price
    }, 0)
  }, 0)
}
