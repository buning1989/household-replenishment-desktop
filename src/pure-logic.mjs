// 跨 renderer / 测试共享的纯逻辑。
// 这些函数不得依赖 React、Electron 或任何副作用，仅做纯计算。
// 类型声明见 pure-logic.d.ts。

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
