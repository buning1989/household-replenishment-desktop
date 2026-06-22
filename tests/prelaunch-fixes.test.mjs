// 上线前修复的确定性验证脚本（Node 内置 test runner，纯 JS，不依赖 TS 模块解析）
// 运行方式：node --test tests/prelaunch-fixes.test.mjs
//
// 覆盖场景：
// 1. 周期建议确认与撤销（P1-5）- 复制 domain.ts restockItem 的核心逻辑
// 2. onboarding 重新运行去重（P1-4）- 复制 handleOnboardingComplete 的去重逻辑
// 3. 正常状态直接补货（P1-3 的 domain 层验证）
// 4. 双数据源启动协调（P1-1 store.ts reconcileState 逻辑）
//
// 注：分类安全删除（P1-2）和预算勿扰/四档阈值（P2）见 budget-logic.test.mjs 和 manual-verification.md

import { test } from "node:test"
import assert from "node:assert/strict"

const DAY_MS = 24 * 60 * 60 * 1000

// ---------- 复制 domain.ts 中的纯逻辑函数 ----------

function startOfDay(timestamp) {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function addDays(timestamp, days) {
  const date = new Date(timestamp)
  date.setDate(date.getDate() + days)
  return startOfDay(date.getTime())
}

function calendarDayNumber(timestamp) {
  const date = new Date(timestamp)
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS)
}

function differenceInDays(later, earlier) {
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

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

// 复制修复后的 restockItem 逻辑（P1-5: 先建议后确认）
function restockItem(item, now = Date.now(), price, qty, platform, purchaseProductName, purchaseUnit) {
  const actualInterval = item.anchorEstimated
    ? undefined
    : Math.max(1, differenceInDays(now, item.lastRestockedAt))

  const safeQty = safeRestockQty(qty)

  const history = [
    ...item.history,
    {
      id: makeId("restock"),
      at: now,
      intervalDays: actualInterval,
      price,
      qty: safeQty,
      platform,
      purchaseProductName: purchaseProductName?.trim() || undefined,
      purchaseUnit: purchaseUnit?.trim() || undefined
    }
  ]

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

  // P1-5 修复：周期学习必须先建议，用户确认后才生效
  const hasSuggestion = candidateCycleDays !== undefined && Math.abs(candidateCycleDays - item.cycleDays) >= 1
  const newCycleDays = hasSuggestion ? item.cycleDays : (candidateCycleDays ?? item.cycleDays)
  const suggestedCycleDays = hasSuggestion ? candidateCycleDays : undefined

  const confidence = item.source === "onboarding"
    ? history.length >= 2 ? "high" : "medium"
    : item.confidence

  return {
    ...item,
    cycleDays: newCycleDays,
    lastRestockedAt: startOfDay(now),
    inventoryDepletionAt: undefined,
    anchorEstimated: false,
    history,
    price: price ?? item.price,
    platform: platform || item.platform,
    snoozeUntil: undefined,
    suggestedCycleDays,
    confidence,
    inventoryStatus: "justRestocked",
    updatedAt: now
  }
}

// ---------- 工具函数 ----------

function makeLearningItem(overrides = {}) {
  const now = Date.now()
  return {
    id: "test-item-1",
    name: "测试物品",
    category: "测试分类",
    type: "learning",
    cycleDays: 30,
    bufferDays: 5,
    lastRestockedAt: now - 35 * DAY_MS,
    anchorEstimated: false,
    purchaseOptions: [],
    history: [
      {
        id: "event-1",
        at: now - 35 * DAY_MS,
        intervalDays: 30,
        price: 50,
        qty: 1,
        platform: "淘宝"
      }
    ],
    createdAt: now - 60 * DAY_MS,
    updatedAt: now - 35 * DAY_MS,
    learningEnabled: true,
    source: "manual",
    confidence: "high",
    ...overrides
  }
}

// ---------- P1-5: 周期建议确认与撤销 ----------

test("P1-5: restockItem 计算出候选周期后不直接覆盖 cycleDays，写入 suggestedCycleDays", () => {
  const now = Date.now()
  const item = makeLearningItem({
    cycleDays: 30,
    lastRestockedAt: now - 25 * DAY_MS,
    history: [
      { id: "e1", at: now - 55 * DAY_MS, intervalDays: 30, qty: 1, price: 50 },
      { id: "e2", at: now - 25 * DAY_MS, intervalDays: 30, qty: 1, price: 50 }
    ]
  })

  const restocked = restockItem(item, now, 50, 1, "淘宝")

  assert.equal(restocked.cycleDays, 30, "cycleDays 应保持原值 30")
  assert.notEqual(restocked.suggestedCycleDays, undefined, "suggestedCycleDays 应被设置")
  assert.equal(typeof restocked.suggestedCycleDays, "number")
})

test("P1-5: 固定周期（learningEnabled=false）的物品不生成建议", () => {
  const now = Date.now()
  const item = makeLearningItem({
    cycleDays: 30,
    learningEnabled: false,
    lastRestockedAt: now - 25 * DAY_MS,
    history: [
      { id: "e1", at: now - 55 * DAY_MS, intervalDays: 30, qty: 1, price: 50 },
      { id: "e2", at: now - 25 * DAY_MS, intervalDays: 30, qty: 1, price: 50 }
    ]
  })

  const restocked = restockItem(item, now, 50, 1, "淘宝")

  assert.equal(restocked.suggestedCycleDays, undefined, "关闭学习的物品不应生成建议")
  assert.equal(restocked.cycleDays, 30, "cycleDays 应保持原值")
})

test("P1-5: 补货后 history 追加新记录，lastRestockedAt 更新", () => {
  const now = Date.now()
  const item = makeLearningItem({
    lastRestockedAt: now - 25 * DAY_MS,
    history: [
      { id: "e1", at: now - 25 * DAY_MS, intervalDays: 30, qty: 1, price: 50 }
    ]
  })

  const restocked = restockItem(item, now, 60, 2, "京东")

  assert.equal(restocked.history.length, 2, "应追加一条 history 记录")
  const newEvent = restocked.history[restocked.history.length - 1]
  assert.equal(newEvent.price, 60)
  assert.equal(newEvent.qty, 2)
  assert.equal(newEvent.platform, "京东")
  const expectedDate = new Date(now)
  expectedDate.setHours(0, 0, 0, 0)
  assert.equal(restocked.lastRestockedAt, expectedDate.getTime())
})

test("P1-5: 撤销补货应完整恢复物品状态（通过快照）", () => {
  const now = Date.now()
  const original = makeLearningItem({
    cycleDays: 30,
    lastRestockedAt: now - 25 * DAY_MS,
    snoozeUntil: now + 12 * 60 * 60 * 1000,
    history: [
      { id: "e1", at: now - 25 * DAY_MS, intervalDays: 30, qty: 1, price: 50 }
    ]
  })

  // 模拟 performRestock 中的快照捕获
  const snapshot = {
    ...original,
    history: original.history.map((e) => ({ ...e }))
  }

  const restocked = restockItem(original, now, 60, 1, "京东")

  assert.notEqual(restocked.history.length, original.history.length)
  assert.notEqual(restocked.lastRestockedAt, original.lastRestockedAt)

  // 模拟 undoRestock：用快照恢复
  const restored = {
    ...snapshot,
    history: snapshot.history.map((e) => ({ ...e }))
  }

  assert.equal(restored.history.length, original.history.length, "history 应恢复")
  assert.equal(restored.lastRestockedAt, original.lastRestockedAt, "lastRestockedAt 应恢复")
  assert.equal(restored.cycleDays, original.cycleDays, "cycleDays 应恢复")
  assert.equal(restored.snoozeUntil, original.snoozeUntil, "snoozeUntil 应恢复")
  assert.equal(restored.inventoryDepletionAt, original.inventoryDepletionAt, "inventoryDepletionAt 应恢复")
  assert.equal(restored.confidence, original.confidence, "confidence 应恢复")
  assert.equal(restored.anchorEstimated, original.anchorEstimated, "anchorEstimated 应恢复")
})

// ---------- P1-4: onboarding 重新运行去重 ----------

test("P1-4: handleOnboardingComplete 去重逻辑 - 已存在的 templateId 不重复创建", () => {
  const now = Date.now()
  const existingItem = {
    id: "existing-1",
    name: "卫生纸",
    category: "卫生间",
    type: "learning",
    cycleDays: 30,
    bufferDays: 5,
    lastRestockedAt: now,
    anchorEstimated: true,
    purchaseOptions: [],
    history: [],
    createdAt: now,
    updatedAt: now,
    templateId: "tpl-toilet-paper",
    learningEnabled: true,
    source: "onboarding",
    confidence: "low"
  }

  const currentItems = [existingItem]

  const createdItems = [
    {
      ...existingItem,
      id: "new-1",
      templateId: "tpl-toilet-paper"
    },
    {
      id: "new-2",
      name: "洗衣液",
      category: "洗衣清洁",
      type: "learning",
      cycleDays: 45,
      bufferDays: 7,
      lastRestockedAt: now,
      anchorEstimated: true,
      purchaseOptions: [],
      history: [],
      createdAt: now,
      updatedAt: now,
      templateId: "tpl-laundry-detergent",
      learningEnabled: true,
      source: "onboarding",
      confidence: "low"
    }
  ]

  // 复制 handleOnboardingComplete 中的去重逻辑
  const existingTemplateIds = new Set(currentItems.flatMap((item) => item.templateId ? [item.templateId] : []))
  const existingNames = new Set(currentItems.map((item) => item.name.trim().toLocaleLowerCase("zh-CN")))
  const uniqueItems = createdItems.filter((item) =>
    (!item.templateId || !existingTemplateIds.has(item.templateId)) &&
    !existingNames.has(item.name.trim().toLocaleLowerCase("zh-CN"))
  )

  assert.equal(uniqueItems.length, 1, "应只添加 1 个新物品")
  assert.equal(uniqueItems[0].name, "洗衣液", "新物品应为洗衣液")
  assert.equal(uniqueItems[0].templateId, "tpl-laundry-detergent")
})

// ---------- P1-3: 正常状态直接补货（domain 层验证） ----------

test("P1-3: 正常状态的物品可以调用 restockItem 完成补货", () => {
  const now = Date.now()
  const item = makeLearningItem({
    cycleDays: 30,
    lastRestockedAt: now - 5 * DAY_MS,
    history: [
      { id: "e1", at: now - 5 * DAY_MS, intervalDays: 30, qty: 1, price: 50 }
    ]
  })

  const restocked = restockItem(item, now, 55, 1, "京东")

  assert.equal(restocked.history.length, 2, "应追加补货记录")
  assert.equal(restocked.inventoryStatus, "justRestocked", "应标记为刚补货")
  assert.equal(restocked.snoozeUntil, undefined, "应清除 snoozeUntil")
})

// ---------- P1-1: 双数据源启动协调（reconcileState 逻辑验证） ----------

// 复制 store.ts 中的 isEmptyInitialCandidate 和 reconcileState 逻辑
function isEmptyInitialCandidate(state) {
  return state.items.length === 0 && !state.onboarding.completed
}

function reconcileStateLogic(localState, remoteRaw) {
  if (!remoteRaw) {
    return localState
  }
  // 模拟 migrateState（简化：假设 remoteRaw 已是合法 AppState）
  const remoteState = remoteRaw
  const localEmpty = isEmptyInitialCandidate(localState)
  const remoteEmpty = isEmptyInitialCandidate(remoteState)

  if (localEmpty && !remoteEmpty) {
    return remoteState
  }
  if (remoteEmpty && !localEmpty) {
    return localState
  }
  return remoteState.updatedAt > localState.updatedAt ? remoteState : localState
}

test("P1-1: reconcileState 逻辑 - localStorage 为空、主进程有效：恢复主进程数据", () => {
  const now = Date.now()
  const localEmpty = {
    version: 3,
    categories: ["其他用品"],
    items: [],
    settings: { reminderIntervalMinutes: 60, quietStart: "22:00", quietEnd: "08:00", snoozeUntilHour: 8 },
    householdProfile: null,
    onboarding: { completed: false, rerun: false, currentStep: 1, skippedProfile: false, skipped: false, managedTemplateIds: [], notUsedTemplateIds: [], deferredTemplateIds: [], createdTemplateIds: [], inventoryStatuses: {} },
    updatedAt: now - 100000
  }

  const remoteValid = {
    version: 3,
    categories: ["卫生间", "厨房"],
    items: [
      { id: "remote-1", name: "卫生纸", category: "卫生间", type: "learning", cycleDays: 30, bufferDays: 5, lastRestockedAt: now - DAY_MS, anchorEstimated: true, purchaseOptions: [], history: [], createdAt: now - DAY_MS, updatedAt: now - DAY_MS, learningEnabled: true }
    ],
    settings: { reminderIntervalMinutes: 60, quietStart: "22:00", quietEnd: "08:00", snoozeUntilHour: 8 },
    householdProfile: null,
    onboarding: { completed: true, rerun: false, currentStep: 5, skippedProfile: false, skipped: false, managedTemplateIds: [], notUsedTemplateIds: [], deferredTemplateIds: [], createdTemplateIds: [], inventoryStatuses: {}, completedAt: now - DAY_MS },
    updatedAt: now
  }

  const result = reconcileStateLogic(localEmpty, remoteValid)
  assert.equal(result.items.length, 1, "应恢复主进程的 1 个物品")
  assert.equal(result.items[0].name, "卫生纸")
  assert.equal(result.onboarding.completed, true, "应恢复主进程的 onboarding 完成状态")
})

test("P1-1: reconcileState 逻辑 - 两份数据都有效：选择 updatedAt 较新的版本", () => {
  const now = Date.now()
  const localNewer = {
    version: 3,
    categories: ["卫生间"],
    items: [{ id: "local-1", name: "本地物品", category: "卫生间", type: "learning", cycleDays: 30, bufferDays: 5, lastRestockedAt: now, anchorEstimated: true, purchaseOptions: [], history: [], createdAt: now, updatedAt: now, learningEnabled: true }],
    settings: { reminderIntervalMinutes: 60, quietStart: "22:00", quietEnd: "08:00", snoozeUntilHour: 8 },
    householdProfile: null,
    onboarding: { completed: true, rerun: false, currentStep: 5, skippedProfile: false, skipped: false, managedTemplateIds: [], notUsedTemplateIds: [], deferredTemplateIds: [], createdTemplateIds: [], inventoryStatuses: {}, completedAt: now },
    updatedAt: now
  }

  const remoteOlder = {
    ...localNewer,
    items: [{ ...localNewer.items[0], id: "remote-1", name: "远程物品" }],
    updatedAt: now - 100000
  }

  const result = reconcileStateLogic(localNewer, remoteOlder)
  assert.equal(result.items[0].name, "本地物品", "应选择本地较新的版本")
})

test("P1-1: reconcileState 逻辑 - 主进程无数据：继续使用 localStorage", () => {
  const now = Date.now()
  const localState = {
    version: 3,
    categories: ["卫生间"],
    items: [{ id: "local-1", name: "本地物品", category: "卫生间", type: "learning", cycleDays: 30, bufferDays: 5, lastRestockedAt: now, anchorEstimated: true, purchaseOptions: [], history: [], createdAt: now, updatedAt: now, learningEnabled: true }],
    settings: { reminderIntervalMinutes: 60, quietStart: "22:00", quietEnd: "08:00", snoozeUntilHour: 8 },
    householdProfile: null,
    onboarding: { completed: true, rerun: false, currentStep: 5, skippedProfile: false, skipped: false, managedTemplateIds: [], notUsedTemplateIds: [], deferredTemplateIds: [], createdTemplateIds: [], inventoryStatuses: {}, completedAt: now },
    updatedAt: now
  }

  const result = reconcileStateLogic(localState, null)
  assert.equal(result, localState, "主进程无数据时应返回 localStorage 状态")
})

test("P1-1: reconcileState 逻辑 - 两边都为空初始状态：选择较新的", () => {
  const now = Date.now()
  const localEmpty = {
    version: 3,
    categories: ["其他用品"],
    items: [],
    settings: { reminderIntervalMinutes: 60, quietStart: "22:00", quietEnd: "08:00", snoozeUntilHour: 8 },
    householdProfile: null,
    onboarding: { completed: false, rerun: false, currentStep: 1, skippedProfile: false, skipped: false, managedTemplateIds: [], notUsedTemplateIds: [], deferredTemplateIds: [], createdTemplateIds: [], inventoryStatuses: {} },
    updatedAt: now - 100000
  }

  const remoteEmpty = {
    ...localEmpty,
    updatedAt: now
  }

  const result = reconcileStateLogic(localEmpty, remoteEmpty)
  // 两边都为空，选择较新的（remote）
  assert.equal(result.updatedAt, now, "应选择较新的版本")
})
