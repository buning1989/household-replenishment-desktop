// 预算提醒状态机：按月份重置，四档阈值（50/75/90/100）各自独立，
// 达到 90% 后继续达到 100% 仍需触发"预算已用完"提醒。
// 同一月份、同一阈值不重复通知；预算清空或降到阈值以下后状态复位。
// 勿扰时段内不得发送通知，也不得标记该档位已通知。

let lastBudgetNotificationLevel = ""
let lastBudgetNotificationMonth = ""

export function getBudgetMonthKey(now = new Date()) {
  return `${now.getFullYear()}-${now.getMonth()}`
}

export function getBudgetLevel(percent) {
  if (percent >= 100) return "budget-100"
  if (percent >= 90) return "budget-90"
  if (percent >= 75) return "budget-75"
  if (percent >= 50) return "budget-50"
  return null
}

export function getBudgetReminderText(percent) {
  if (percent >= 100) return "本月预算已用完，下个月再买吧"
  if (percent >= 90) return "本月预算即将用完，谨慎消费"
  if (percent >= 75) return "本月预算已用四分之三，注意控制开销"
  if (percent >= 50) return "本月预算已使用一半，继续保持"
  return ""
}

export function inQuietHours(now, start, end) {
  const [startHour, startMinute] = String(start || "22:00").split(":").map(Number)
  const [endHour, endMinute] = String(end || "08:00").split(":").map(Number)
  const minute = now.getHours() * 60 + now.getMinutes()
  const startValue = startHour * 60 + startMinute
  const endValue = endHour * 60 + endMinute
  return startValue > endValue
    ? minute >= startValue || minute < endValue
    : minute >= startValue && minute < endValue
}

// 读取内部状态，供测试验证
export function getBudgetNotificationState() {
  return { level: lastBudgetNotificationLevel, month: lastBudgetNotificationMonth }
}

// 重置内部状态，供测试使用
export function resetBudgetNotificationState() {
  lastBudgetNotificationLevel = ""
  lastBudgetNotificationMonth = ""
}

// 核心状态机逻辑。
// notify 为可选回调，实际发送通知时调用；测试时可注入 mock。
// 返回 { sent: boolean, level: string | null } 描述本次调用结果。
export function evaluateBudgetNotification(percent, spent, budget, settings, now, notify) {
  const level = getBudgetLevel(percent)
  const monthKey = getBudgetMonthKey(now)

  // 月份变化后重置当月提醒状态
  if (lastBudgetNotificationMonth !== monthKey) {
    lastBudgetNotificationMonth = monthKey
    lastBudgetNotificationLevel = ""
  }

  // 预算被清空或降到阈值以下后，状态复位
  if (!level) {
    lastBudgetNotificationLevel = ""
    return { sent: false, level: null }
  }

  // 同一月份、同一阈值不得每分钟重复通知
  if (level === lastBudgetNotificationLevel) {
    return { sent: false, level }
  }

  // 勿扰时段内不得发送通知，也不得标记该档位已通知
  if (inQuietHours(now, settings?.quietStart, settings?.quietEnd)) {
    return { sent: false, level }
  }

  // 实际发送通知
  if (notify) {
    const title = level === "budget-100" || level === "budget-90" ? "预算提醒" : "预算进度"
    const body = `${getBudgetReminderText(percent)}（已用 ¥${spent.toFixed(0)} / ¥${budget.toFixed(0)}）`
    notify({ title, body, level })
  }

  // 只有通知实际发送后，才记录该档位已通知
  lastBudgetNotificationLevel = level
  return { sent: true, level }
}
