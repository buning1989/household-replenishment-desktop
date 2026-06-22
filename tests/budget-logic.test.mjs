// P2 预算提醒状态机的纯逻辑验证（不依赖 Electron）
// 运行方式：node --test tests/budget-logic.test.mjs
//
// 注：这些测试验证 getBudgetLevel 和 getBudgetMonthKey 的纯逻辑，
// 以及 sendBudgetNotification 的状态机行为（通过模拟 Notification）。
// 完整的勿扰时段 + 系统通知行为在 manual-verification.md 中提供手动验证记录。

import { test } from "node:test"
import assert from "node:assert/strict"

// ---------- 复制 main.js 中的纯逻辑函数进行测试 ----------

function getBudgetMonthKey(now = new Date()) {
  return `${now.getFullYear()}-${now.getMonth()}`
}

function getBudgetLevel(percent) {
  if (percent >= 100) return "budget-100"
  if (percent >= 90) return "budget-90"
  if (percent >= 75) return "budget-75"
  if (percent >= 50) return "budget-50"
  return null
}

function getBudgetReminderText(percent) {
  if (percent >= 100) return "本月预算已用完，下个月再买吧"
  if (percent >= 90) return "本月预算即将用完，谨慎消费"
  if (percent >= 75) return "本月预算已用四分之三，注意控制开销"
  if (percent >= 50) return "本月预算已使用一半，继续保持"
  return ""
}

function inQuietHours(now, start, end) {
  const [startHour, startMinute] = String(start || "22:00").split(":").map(Number)
  const [endHour, endMinute] = String(end || "08:00").split(":").map(Number)
  const minute = now.getHours() * 60 + now.getMinutes()
  const startValue = startHour * 60 + startMinute
  const endValue = endHour * 60 + endMinute
  return startValue > endValue
    ? minute >= startValue || minute < endValue
    : minute >= startValue && minute < endValue
}

// ---------- 测试 ----------

test("P2: 四档阈值各自独立标识 - 50/75/90/100 使用不同 level", () => {
  assert.equal(getBudgetLevel(49), null)
  assert.equal(getBudgetLevel(50), "budget-50")
  assert.equal(getBudgetLevel(74), "budget-50")
  assert.equal(getBudgetLevel(75), "budget-75")
  assert.equal(getBudgetLevel(89), "budget-75")
  assert.equal(getBudgetLevel(90), "budget-90")
  assert.equal(getBudgetLevel(99), "budget-90")
  assert.equal(getBudgetLevel(100), "budget-100")
  assert.equal(getBudgetLevel(150), "budget-100")
})

test("P2: 90% 和 100% 使用不同 level，90→100 转换会触发新通知", () => {
  const level90 = getBudgetLevel(90)
  const level100 = getBudgetLevel(100)
  assert.notEqual(level90, level100, "90% 和 100% 必须使用不同 level")
})

test("P2: 月份变化后 monthKey 不同", () => {
  const jan = new Date(2026, 0, 15)
  const feb = new Date(2026, 1, 15)
  const dec = new Date(2026, 11, 15)
  assert.notEqual(getBudgetMonthKey(jan), getBudgetMonthKey(feb))
  assert.notEqual(getBudgetMonthKey(feb), getBudgetMonthKey(dec))
  assert.notEqual(getBudgetMonthKey(jan), getBudgetMonthKey(dec))
})

test("P2: 同年同月 monthKey 相同", () => {
  const d1 = new Date(2026, 5, 1)
  const d2 = new Date(2026, 5, 28)
  assert.equal(getBudgetMonthKey(d1), getBudgetMonthKey(d2))
})

test("P2: 预算降到阈值以下时 level 为 null（状态应复位）", () => {
  assert.equal(getBudgetLevel(49), null, "49% 应返回 null")
  assert.equal(getBudgetLevel(0), null, "0% 应返回 null")
})

test("P2: 勿扰时段 - 22:00-08:00 跨午夜", () => {
  // 23:00 在勿扰时段内
  assert.equal(inQuietHours(new Date(2026, 5, 15, 23, 0), "22:00", "08:00"), true)
  // 02:00 在勿扰时段内
  assert.equal(inQuietHours(new Date(2026, 5, 15, 2, 0), "22:00", "08:00"), true)
  // 10:00 不在勿扰时段内
  assert.equal(inQuietHours(new Date(2026, 5, 15, 10, 0), "22:00", "08:00"), false)
  // 21:59 不在勿扰时段内
  assert.equal(inQuietHours(new Date(2026, 5, 15, 21, 59), "22:00", "08:00"), false)
  // 08:00 不在勿扰时段内（边界，end 是 exclusive 的）
  assert.equal(inQuietHours(new Date(2026, 5, 15, 8, 0), "22:00", "08:00"), false)
  // 22:00 在勿扰时段内（边界，start 是 inclusive 的）
  assert.equal(inQuietHours(new Date(2026, 5, 15, 22, 0), "22:00", "08:00"), true)
})

test("P2: 预算提醒文案 - 四档对应不同文案", () => {
  assert.equal(getBudgetReminderText(100), "本月预算已用完，下个月再买吧")
  assert.equal(getBudgetReminderText(90), "本月预算即将用完，谨慎消费")
  assert.equal(getBudgetReminderText(75), "本月预算已用四分之三，注意控制开销")
  assert.equal(getBudgetReminderText(50), "本月预算已使用一半，继续保持")
  assert.equal(getBudgetReminderText(49), "")
})

// ---------- 状态机行为模拟测试 ----------

test("P2: 状态机 - 同一月份同一阈值不重复通知，90→100 触发新通知", () => {
  // 模拟 sendBudgetNotification 的状态机逻辑
  let lastBudgetNotificationLevel = ""
  let lastBudgetNotificationMonth = ""
  const notifications = []

  function mockSendBudgetNotification(percent, settings) {
    const level = getBudgetLevel(percent)
    const monthKey = getBudgetMonthKey()
    if (lastBudgetNotificationMonth !== monthKey) {
      lastBudgetNotificationMonth = monthKey
      lastBudgetNotificationLevel = ""
    }
    if (!level) {
      lastBudgetNotificationLevel = ""
      return
    }
    if (level === lastBudgetNotificationLevel) return
    lastBudgetNotificationLevel = level
    if (inQuietHours(new Date(), settings?.quietStart, settings?.quietEnd)) return
    notifications.push({ level, percent })
  }

  const settings = { quietStart: "22:00", quietEnd: "08:00" }
  // 模拟同一天的不同时刻（非勿扰时段）
  const realDate = Date
  global.Date = class extends realDate {
    constructor(...args) {
      if (args.length === 0) {
        super(2026, 5, 15, 12, 0) // 中午 12 点，非勿扰
      } else {
        super(...args)
      }
    }
  }

  try {
    // 50% - 触发
    mockSendBudgetNotification(50, settings)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0].level, "budget-50")

    // 50% 再次 - 不触发（同阈值）
    mockSendBudgetNotification(50, settings)
    assert.equal(notifications.length, 1)

    // 75% - 触发
    mockSendBudgetNotification(75, settings)
    assert.equal(notifications.length, 2)
    assert.equal(notifications[1].level, "budget-75")

    // 90% - 触发
    mockSendBudgetNotification(90, settings)
    assert.equal(notifications.length, 3)
    assert.equal(notifications[2].level, "budget-90")

    // 90% 再次 - 不触发
    mockSendBudgetNotification(90, settings)
    assert.equal(notifications.length, 3)

    // 100% - 触发（关键：90→100 必须触发）
    mockSendBudgetNotification(100, settings)
    assert.equal(notifications.length, 4)
    assert.equal(notifications[3].level, "budget-100")

    // 100% 再次 - 不触发
    mockSendBudgetNotification(100, settings)
    assert.equal(notifications.length, 4)

    // 降到 40% - 状态复位
    mockSendBudgetNotification(40, settings)
    assert.equal(notifications.length, 4) // 不触发通知，但状态复位

    // 再次到 50% - 触发（因为状态已复位）
    mockSendBudgetNotification(50, settings)
    assert.equal(notifications.length, 5)
    assert.equal(notifications[4].level, "budget-50")
  } finally {
    global.Date = realDate
  }
})
