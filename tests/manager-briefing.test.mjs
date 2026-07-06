// 任务三（开场简报）单元测试
// 运行方式：node --test tests/manager-briefing.test.mjs

import { test } from "node:test"
import assert from "node:assert/strict"
import { registerHooks } from "node:module"

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if ((specifier.startsWith(".") || specifier.startsWith("..")) && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context)
      }
      throw error
    }
  }
})

const { buildManagerBriefing, buildManagerObservations } = await import("../src/agent/observations.ts")
const { computeItem } = await import("../src/domain.ts")

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

function makeState(overrides = {}) {
  return {
    version: 3,
    categories: ["日常护理", "洗衣清洁", "宠物用品", "其他"],
    items: [],
    settings: {
      reminderIntervalHours: 1,
      quietStart: "22:00",
      quietEnd: "08:00",
      notificationEnabled: true,
      monthlyBudget: undefined
    },
    householdProfile: null,
    onboarding: { completed: true, rerun: false, currentStep: 1, skippedProfile: false, skipped: false, managedTemplateIds: [], notUsedTemplateIds: [], deferredTemplateIds: [], createdTemplateIds: [], inventoryStatuses: {} },
    updatedAt: Date.now(),
    ...overrides
  }
}

function makeItem(overrides = {}) {
  return {
    id: "item-1",
    name: "测试物品",
    category: "日常护理",
    type: "learning",
    cycleDays: 30,
    bufferDays: 3,
    lastRestockedAt: Date.now() - 30 * DAY,
    anchorEstimated: false,
    purchaseOptions: [],
    history: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  }
}

function makeItemView(item, now) {
  return { item, computed: computeItem(item, now) }
}

// ---------- 触发条件 ----------

test("buildManagerBriefing: 距上次会话 >8 小时时触发", () => {
  const now = new Date(2026, 6, 6, 10, 0, 0).getTime() // 10:00
  const lastSessionAt = now - 9 * HOUR
  const dateContext = { now }
  const state = makeState()
  const observations = buildManagerObservations(state, [], dateContext)
  
  const result = buildManagerBriefing(observations, lastSessionAt, dateContext)
  assert.ok(result !== null, "应该触发简报")
  assert.ok(result.includes("早上好"))
  assert.ok(result.includes("要处理的话跟我说一声就行"))
})

test("buildManagerBriefing: 距上次会话 ≤8 小时且无 attention 时不触发", () => {
  const now = new Date(2026, 6, 6, 10, 0, 0).getTime()
  const lastSessionAt = now - 7 * HOUR
  const dateContext = { now }
  const state = makeState()
  const observations = buildManagerObservations(state, [], dateContext)
  
  const result = buildManagerBriefing(observations, lastSessionAt, dateContext)
  assert.equal(result, null, "不应该触发简报")
})

test("buildManagerBriefing: 存在 attention 级观察时触发（即使 <8 小时）", () => {
  const now = new Date(2026, 6, 6, 10, 0, 0).getTime()
  const lastSessionAt = now - 2 * HOUR
  const item = makeItem({
    id: "i-urgent",
    name: "急需物品",
    lastRestockedAt: now - 35 * DAY,
    cycleDays: 30,
    bufferDays: 3
  })
  const itemViews = [makeItemView(item, now)]
  const dateContext = { now }
  const state = makeState({ items: [item] })
  const observations = buildManagerObservations(state, itemViews, dateContext)
  
  assert.ok(observations.some((obs) => obs.severity === "attention"), "应该有 attention 级观察")
  const result = buildManagerBriefing(observations, lastSessionAt, dateContext)
  assert.ok(result !== null, "应该触发简报")
})

test("buildManagerBriefing: lastSessionAt 为 undefined 时触发", () => {
  const now = new Date(2026, 6, 6, 10, 0, 0).getTime()
  const dateContext = { now }
  const state = makeState()
  const observations = buildManagerObservations(state, [], dateContext)
  
  const result = buildManagerBriefing(observations, undefined, dateContext)
  assert.ok(result !== null, "首次打开应该触发简报")
})

// ---------- 内容结构 ----------

test("buildManagerBriefing: 问候语按时段（早上/下午/晚上）", () => {
  const morning = new Date(2026, 6, 6, 8, 0, 0).getTime()
  const afternoon = new Date(2026, 6, 6, 14, 0, 0).getTime()
  const evening = new Date(2026, 6, 6, 20, 0, 0).getTime()
  
  const state = makeState()
  const observations = buildManagerObservations(state, [], { now: morning })
  
  const morningResult = buildManagerBriefing(observations, undefined, { now: morning })
  assert.ok(morningResult.includes("早上好"))
  
  const afternoonResult = buildManagerBriefing(observations, undefined, { now: afternoon })
  assert.ok(afternoonResult.includes("下午好"))
  
  const eveningResult = buildManagerBriefing(observations, undefined, { now: evening })
  assert.ok(eveningResult.includes("晚上好"))
})

test("buildManagerBriefing: 至多 3 条观察", () => {
  const now = new Date(2026, 6, 6, 10, 0, 0).getTime()
  const items = [
    makeItem({ id: "i1", name: "物品1", lastRestockedAt: now - 35 * DAY }),
    makeItem({ id: "i2", name: "物品2", lastRestockedAt: now - 36 * DAY }),
    makeItem({ id: "i3", name: "物品3", lastRestockedAt: now - 37 * DAY }),
    makeItem({ id: "i4", name: "物品4", lastRestockedAt: now - 38 * DAY })
  ]
  const itemViews = items.map((item) => makeItemView(item, now))
  const dateContext = { now }
  const state = makeState({ items })
  const observations = buildManagerObservations(state, itemViews, dateContext)
  
  const result = buildManagerBriefing(observations, undefined, dateContext)
  // 检查分号分隔的观察数量不超过 3
  const observationPart = result.split("，")[1] || ""
  const observationCount = observationPart.split("；").length
  assert.ok(observationCount <= 3, `观察数量应 ≤3，实际 ${observationCount}`)
})

test("buildManagerBriefing: 无观察时只有问候和收尾", () => {
  const now = new Date(2026, 6, 6, 10, 0, 0).getTime()
  const dateContext = { now }
  const state = makeState()
  const observations = buildManagerObservations(state, [], dateContext)
  
  const result = buildManagerBriefing(observations, undefined, dateContext)
  assert.ok(result.includes("早上好"))
  assert.ok(result.includes("要处理的话跟我说一声就行"))
  // 无观察时不应有分号
  assert.ok(!result.includes("；"))
})
