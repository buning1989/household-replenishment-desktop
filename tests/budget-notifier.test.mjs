import { test } from "node:test"
import assert from "node:assert/strict"
import {
  evaluateBudgetNotification,
  getBudgetLevel,
  getBudgetMonthKey,
  getBudgetNotificationState,
  resetBudgetNotificationState
} from "../electron/budget-notifier.mjs"

// 辅助函数：创建指定时间的 Date 对象
function createDateTime(hour, minute) {
  const now = new Date()
  now.setHours(hour, minute, 0, 0)
  return now
}

// 辅助函数：模拟通知发送
function createMockNotify() {
  const notifications = []
  return {
    notifications,
    notify: ({ title, body, level }) => {
      notifications.push({ title, body, level })
    }
  }
}

test("P2: 勿扰时段内触发阈值，不发送通知且不标记已通知", () => {
  resetBudgetNotificationState()
  
  // 模拟 23:00（勿扰时段 22:00-08:00）
  const now = createDateTime(23, 0)
  const { notify, notifications } = createMockNotify()
  
  // 50% 阈值
  const result = evaluateBudgetNotification(50, 500, 1000, {}, now, notify)
  
  assert.equal(result.sent, false, "勿扰时段内不应发送通知")
  assert.equal(notifications.length, 0, "不应调用 notify 回调")
  
  // 验证状态未被标记
  const state = getBudgetNotificationState()
  assert.equal(state.level, "", "勿扰时段内不应标记档位已通知")
})

test("P2: 勿扰时段结束后，下一次检查应补发通知", () => {
  resetBudgetNotificationState()
  
  // 第一次：23:00 触发 50% 阈值（勿扰时段）
  const night = createDateTime(23, 0)
  const { notify: notify1, notifications: notifications1 } = createMockNotify()
  evaluateBudgetNotification(50, 500, 1000, {}, night, notify1)
  
  assert.equal(notifications1.length, 0, "勿扰时段内不应发送")
  
  // 第二次：09:00（勿扰时段结束）再次检查
  const morning = createDateTime(9, 0)
  const { notify: notify2, notifications: notifications2 } = createMockNotify()
  const result = evaluateBudgetNotification(50, 500, 1000, {}, morning, notify2)
  
  assert.equal(result.sent, true, "勿扰结束后应发送通知")
  assert.equal(notifications2.length, 1, "应调用 notify 回调一次")
  assert.equal(notifications2[0].level, "budget-50", "应发送 50% 档位通知")
  
  // 验证状态已标记
  const state = getBudgetNotificationState()
  assert.equal(state.level, "budget-50", "发送后应标记档位已通知")
})

test("P2: 补发后同月同档位不重复发送", () => {
  resetBudgetNotificationState()
  
  const now = createDateTime(10, 0)
  const { notify, notifications } = createMockNotify()
  
  // 第一次发送
  evaluateBudgetNotification(50, 500, 1000, {}, now, notify)
  assert.equal(notifications.length, 1, "第一次应发送")
  
  // 第二次相同档位
  evaluateBudgetNotification(50, 500, 1000, {}, now, notify)
  assert.equal(notifications.length, 1, "同月同档位不应重复发送")
})

test("P2: 90% 已通知后达到 100%，仍须单独通知", () => {
  resetBudgetNotificationState()
  
  const now = createDateTime(10, 0)
  const { notify, notifications } = createMockNotify()
  
  // 90% 阈值
  evaluateBudgetNotification(90, 900, 1000, {}, now, notify)
  assert.equal(notifications.length, 1, "90% 应发送")
  assert.equal(notifications[0].level, "budget-90", "应发送 90% 档位")
  
  // 100% 阈值
  evaluateBudgetNotification(100, 1000, 1000, {}, now, notify)
  assert.equal(notifications.length, 2, "100% 应单独发送")
  assert.equal(notifications[1].level, "budget-100", "应发送 100% 档位")
})

test("P2: 月份变化后重置提醒状态", () => {
  resetBudgetNotificationState()
  
  const now = new Date()
  const { notify, notifications } = createMockNotify()
  
  // 当月发送 50% 通知
  evaluateBudgetNotification(50, 500, 1000, {}, now, notify)
  assert.equal(notifications.length, 1, "当月应发送")
  
  // 模拟下个月
  const nextMonth = new Date(now)
  nextMonth.setMonth(nextMonth.getMonth() + 1)
  
  // 下个月相同档位应重新发送
  evaluateBudgetNotification(50, 500, 1000, {}, nextMonth, notify)
  assert.equal(notifications.length, 2, "月份变化后应重新发送")
})

test("P2: 预算降到阈值以下时状态复位", () => {
  resetBudgetNotificationState()
  
  const now = createDateTime(10, 0)
  const { notify, notifications } = createMockNotify()
  
  // 发送 50% 通知
  evaluateBudgetNotification(50, 500, 1000, {}, now, notify)
  assert.equal(notifications.length, 1, "50% 应发送")
  
  // 预算降到 40%
  evaluateBudgetNotification(40, 400, 1000, {}, now, notify)
  assert.equal(notifications.length, 1, "低于阈值不应发送")
  
  // 状态应复位
  const state = getBudgetNotificationState()
  assert.equal(state.level, "", "低于阈值后状态应复位")
  
  // 再次达到 50% 应重新发送
  evaluateBudgetNotification(50, 500, 1000, {}, now, notify)
  assert.equal(notifications.length, 2, "复位后再次达到阈值应重新发送")
})

test("P2: 四档阈值各自独立标识", () => {
  resetBudgetNotificationState()
  
  assert.equal(getBudgetLevel(49), null, "49% 无档位")
  assert.equal(getBudgetLevel(50), "budget-50", "50% 为 budget-50")
  assert.equal(getBudgetLevel(74), "budget-50", "74% 为 budget-50")
  assert.equal(getBudgetLevel(75), "budget-75", "75% 为 budget-75")
  assert.equal(getBudgetLevel(89), "budget-75", "89% 为 budget-75")
  assert.equal(getBudgetLevel(90), "budget-90", "90% 为 budget-90")
  assert.equal(getBudgetLevel(99), "budget-90", "99% 为 budget-90")
  assert.equal(getBudgetLevel(100), "budget-100", "100% 为 budget-100")
})

test("P2: 月份 key 计算正确", () => {
  const date1 = new Date(2026, 5, 15) // 2026-06-15
  const date2 = new Date(2026, 5, 20) // 2026-06-20
  const date3 = new Date(2026, 6, 1)  // 2026-07-01
  
  assert.equal(getBudgetMonthKey(date1), "2026-5", "6月 key 应为 2026-5")
  assert.equal(getBudgetMonthKey(date2), "2026-5", "同月 key 相同")
  assert.equal(getBudgetMonthKey(date3), "2026-6", "7月 key 应为 2026-6")
})

test("P2: 完整状态机流程 - 50→75→90→100→复位→50", () => {
  resetBudgetNotificationState()
  
  const now = createDateTime(10, 0)
  const { notify, notifications } = createMockNotify()
  
  // 50%
  evaluateBudgetNotification(50, 500, 1000, {}, now, notify)
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].level, "budget-50")
  
  // 75%
  evaluateBudgetNotification(75, 750, 1000, {}, now, notify)
  assert.equal(notifications.length, 2)
  assert.equal(notifications[1].level, "budget-75")
  
  // 90%
  evaluateBudgetNotification(90, 900, 1000, {}, now, notify)
  assert.equal(notifications.length, 3)
  assert.equal(notifications[2].level, "budget-90")
  
  // 100%
  evaluateBudgetNotification(100, 1000, 1000, {}, now, notify)
  assert.equal(notifications.length, 4)
  assert.equal(notifications[3].level, "budget-100")
  
  // 预算清空（0%）
  evaluateBudgetNotification(0, 0, 1000, {}, now, notify)
  assert.equal(notifications.length, 4, "0% 不应发送")
  
  const state = getBudgetNotificationState()
  assert.equal(state.level, "", "清空后状态应复位")
  
  // 再次 50%
  evaluateBudgetNotification(50, 500, 1000, {}, now, notify)
  assert.equal(notifications.length, 5, "复位后应重新发送")
  assert.equal(notifications[4].level, "budget-50")
})
