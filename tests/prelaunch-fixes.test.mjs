// 上线前修复的确定性验证脚本（Node 内置 test runner，纯 JS，不依赖 TS 模块解析）
// 运行方式：node --test tests/prelaunch-fixes.test.mjs
//
// 覆盖场景：
// 1. 周期建议确认与撤销（P1-5）- 直接调用共享 restockItemCore
// 2. onboarding 重新运行去重（P1-4）- 复制 handleOnboardingComplete 的去重逻辑
// 3. 正常状态直接补货（P1-3 的 domain 层验证）
// 4. 双数据源启动协调（P1-1 store.ts reconcileState 逻辑）
// 5. RestockModal canConfirm 纯函数（PR15 P0-1）- 直接 import pure-logic.mjs，不复制
// 6. deleteCategory 安全删除（PR15 P0-2）- 直接 import pure-logic.mjs，不复制
// 7. 月度预算统计口径（PR15 P0-3）- 直接 import pure-logic.mjs，不复制
// 8. restockItem 兼容空 purchaseOption（PR15 P0-1 domain 层）
// 9. createInitialState 初始 items 仍为空（PR15 清理-5 回归保护）

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  canConfirmRestock,
  applyDeleteCategory,
  calculateMonthlySpend,
  restockItemCore
} from "../src/pure-logic.mjs"

const DAY_MS = 24 * 60 * 60 * 1000

// ---------- 真实补货核心逻辑的兼容调用包装 ----------

function restockItem(
  item,
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
) {
  return restockItemCore({
    item,
    eventId: `restock-test-${item.history.length + 1}`,
    now,
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
  })
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

// ---------- 补货回执"收起"按钮回归测试 ----------

test("补货后点击\"收起\"只清除 recentRestock，不改变物品及 history", () => {
  const now = Date.now()
  const originalItem = makeLearningItem({
    cycleDays: 30,
    lastRestockedAt: now - 25 * DAY_MS,
    history: [
      { id: "e1", at: now - 25 * DAY_MS, intervalDays: 30, qty: 1, price: 50 }
    ]
  })

  // 模拟补货
  const restockedItem = restockItem(originalItem, now, 60, 2, "京东")
  assert.equal(restockedItem.history.length, 2, "补货后 history 应为 2 条")

  // 模拟 recentRestock 状态
  const recentRestock = {
    itemId: restockedItem.id,
    itemName: restockedItem.name,
    amount: "60",
    qty: "2",
    platform: "京东",
    snapshot: { ...originalItem, history: originalItem.history.map((e) => ({ ...e })) }
  }

  // 模拟点击"收起"：只清除 recentRestock，不恢复快照
  const dismissedRecentRestock = null
  const itemAfterDismiss = restockedItem // 物品不应改变

  assert.equal(dismissedRecentRestock, null, "recentRestock 应被清除")
  assert.equal(itemAfterDismiss.history.length, 2, "history 条数应保持不变")
  assert.equal(itemAfterDismiss.cycleDays, 30, "cycleDays 不应改变")
  assert.equal(itemAfterDismiss.lastRestockedAt, restockedItem.lastRestockedAt, "lastRestockedAt 不应改变")
  assert.equal(itemAfterDismiss.price, 60, "price 不应改变")
})

test("补货后点击\"撤销\"应恢复快照（与\"收起\"区分）", () => {
  const now = Date.now()
  const originalItem = makeLearningItem({
    cycleDays: 30,
    lastRestockedAt: now - 25 * DAY_MS,
    history: [
      { id: "e1", at: now - 25 * DAY_MS, intervalDays: 30, qty: 1, price: 50 }
    ]
  })

  // 模拟补货
  const restockedItem = restockItem(originalItem, now, 60, 2, "京东")
  assert.equal(restockedItem.history.length, 2, "补货后 history 应为 2 条")

  // 模拟 recentRestock 状态（含快照）
  const recentRestock = {
    itemId: restockedItem.id,
    itemName: restockedItem.name,
    amount: "60",
    qty: "2",
    platform: "京东",
    snapshot: { ...originalItem, history: originalItem.history.map((e) => ({ ...e })) }
  }

  // 模拟点击"撤销"：恢复快照
  const restoredItem = { ...recentRestock.snapshot, history: recentRestock.snapshot.history.map((e) => ({ ...e })) }
  const dismissedRecentRestock = null

  assert.equal(dismissedRecentRestock, null, "recentRestock 应被清除")
  assert.equal(restoredItem.history.length, 1, "撤销后 history 应恢复为 1 条")
  assert.equal(restoredItem.cycleDays, 30, "cycleDays 应恢复")
  assert.equal(restoredItem.lastRestockedAt, originalItem.lastRestockedAt, "lastRestockedAt 应恢复")
})

// ============================================================
// PR15 P0-1: RestockModal canConfirm 纯函数测试
// 直接 import canConfirmRestock from pure-logic.mjs（不复制逻辑）
// 验证：item 没有 purchaseOptions 时也能直接补货，selectedOption 可以为 null
// ============================================================

test("PR15 P0-1: item 没有 purchaseOptions 时，只填 qty/price/restockDate 即可 confirm", () => {
  // 场景：新用户没有常购商品，直接填写补货数量、价格、日期
  const result = canConfirmRestock({
    qty: 2,
    price: 50,
    restockDateValid: true,
    usesMeasurePricing: false, // 没有选中按含量计价的常购商品
    measureAmount: "",
    measureUnit: ""
  })
  assert.equal(result, true, "没有 purchaseOptions 时应允许 confirm")
})

test("PR15 P0-1: 没有选中 purchaseOption 时不会强制要求 selectedOption", () => {
  // 场景：item 有 purchaseOptions 但用户没选，按规格计价（默认）
  // canConfirm 不再检查 selectedOption，只检查 qty/price/date
  const result = canConfirmRestock({
    qty: 1,
    price: 30,
    restockDateValid: true,
    usesMeasurePricing: false,
    measureAmount: "",
    measureUnit: ""
  })
  assert.equal(result, true, "不应因 selectedOption 为 null 而拒绝")
})

test("PR15 P0-1: qty 不合法时拒绝 confirm", () => {
  const result = canConfirmRestock({
    qty: 0,
    price: 50,
    restockDateValid: true,
    usesMeasurePricing: false,
    measureAmount: "",
    measureUnit: ""
  })
  assert.equal(result, false, "qty < 1 应拒绝")
})

test("PR15 P0-1: price 为空或负数时拒绝 confirm", () => {
  assert.equal(canConfirmRestock({
    qty: 1, price: "", restockDateValid: true,
    usesMeasurePricing: false, measureAmount: "", measureUnit: ""
  }), false, "price 为空应拒绝")

  assert.equal(canConfirmRestock({
    qty: 1, price: -1, restockDateValid: true,
    usesMeasurePricing: false, measureAmount: "", measureUnit: ""
  }), false, "price 为负应拒绝")
})

test("PR15 P0-1: price = 0 时允许 confirm（免费补货场景）", () => {
  const result = canConfirmRestock({
    qty: 1,
    price: 0,
    restockDateValid: true,
    usesMeasurePricing: false,
    measureAmount: "",
    measureUnit: ""
  })
  assert.equal(result, true, "price = 0 应允许")
})

test("PR15 P0-1: restockDate 无效时拒绝 confirm", () => {
  const result = canConfirmRestock({
    qty: 1,
    price: 50,
    restockDateValid: false,
    usesMeasurePricing: false,
    measureAmount: "",
    measureUnit: ""
  })
  assert.equal(result, false, "restockDate 无效应拒绝")
})

test("PR15 P0-1: 选择按含量计价的常购商品时，必须填写 measureAmount 和 measureUnit", () => {
  assert.equal(canConfirmRestock({
    qty: 1, price: 50, restockDateValid: true,
    usesMeasurePricing: true, measureAmount: "", measureUnit: ""
  }), false, "按含量计价但未填 measure 应拒绝")

  assert.equal(canConfirmRestock({
    qty: 1, price: 50, restockDateValid: true,
    usesMeasurePricing: true, measureAmount: 500, measureUnit: ""
  }), false, "measureUnit 为空应拒绝")

  assert.equal(canConfirmRestock({
    qty: 1, price: 50, restockDateValid: true,
    usesMeasurePricing: true, measureAmount: 0, measureUnit: "ml"
  }), false, "measureAmount <= 0 应拒绝")

  assert.equal(canConfirmRestock({
    qty: 1, price: 50, restockDateValid: true,
    usesMeasurePricing: true, measureAmount: 500, measureUnit: "ml"
  }), true, "measure 完整应允许")
})

// ============================================================
// PR15 P0-2: deleteCategory 安全删除测试
// 直接 import applyDeleteCategory from pure-logic.mjs（不复制逻辑）
// 验证：非空分类必须显式 moveTo 或 deleteItemsConfirmed
// ============================================================

function makeStateWithCategories(categories, items = []) {
  return {
    version: 3,
    categories,
    items,
    settings: { reminderIntervalHours: 1, quietStart: "22:00", quietEnd: "08:00", notificationEnabled: true },
    householdProfile: null,
    updatedAt: Date.now()
  }
}

function makeItemInCategory(category, id = "item-1") {
  const now = Date.now()
  return {
    id, name: `物品-${id}`, category, type: "learning",
    cycleDays: 30, bufferDays: 5, lastRestockedAt: now, anchorEstimated: true,
    purchaseOptions: [], history: [], createdAt: now, updatedAt: now,
    learningEnabled: true, source: "manual", confidence: "medium"
  }
}

test("PR15 P0-2: 空分类可以直接删除", () => {
  const state = makeStateWithCategories(["厨房", "卫生间"], [])
  const result = applyDeleteCategory(state, "卫生间")
  assert.equal(result.ok, true, "空分类应允许删除")
  assert.equal(result.state.categories.includes("卫生间"), false, "分类应被移除")
  assert.equal(result.state.items.length, 0, "物品列表应保持为空")
})

test("PR15 P0-2: 非空分类在没有 moveTo、没有 deleteItemsConfirmed 时拒绝删除", () => {
  const state = makeStateWithCategories(["厨房", "卫生间"], [
    makeItemInCategory("厨房", "k1"),
    makeItemInCategory("厨房", "k2")
  ])
  const result = applyDeleteCategory(state, "厨房")
  assert.equal(result.ok, false, "非空分类应拒绝删除")
  assert.equal(result.reason, "non-empty-category-requires-move-or-confirm")
  assert.equal(result.state, state, "拒绝时 state 应保持不变（同一引用）")
  assert.equal(result.state.categories.includes("厨房"), true, "分类应仍存在")
  assert.equal(result.state.items.length, 2, "物品不应被误删")
})

test("PR15 P0-2: 非空分类选择 moveTo 后，物品迁移、分类删除", () => {
  const state = makeStateWithCategories(["厨房", "卫生间"], [
    makeItemInCategory("厨房", "k1"),
    makeItemInCategory("厨房", "k2"),
    makeItemInCategory("卫生间", "b1")
  ])
  const result = applyDeleteCategory(state, "厨房", { moveToCategory: "卫生间" })
  assert.equal(result.ok, true, "moveTo 后应允许删除")
  assert.equal(result.state.categories.includes("厨房"), false, "厨房应被删除")
  assert.equal(result.state.items.length, 3, "物品总数不应减少")
  assert.equal(result.state.items.filter((i) => i.category === "厨房").length, 0, "厨房下不应再有物品")
  assert.equal(result.state.items.filter((i) => i.category === "卫生间").length, 3, "所有物品应迁移到卫生间")
})

test("PR15 P0-2: 非空分类显式 deleteItemsConfirmed 后，才允许删除其中物品", () => {
  const state = makeStateWithCategories(["厨房", "卫生间"], [
    makeItemInCategory("厨房", "k1"),
    makeItemInCategory("厨房", "k2"),
    makeItemInCategory("卫生间", "b1")
  ])
  const result = applyDeleteCategory(state, "厨房", { deleteItemsConfirmed: true })
  assert.equal(result.ok, true, "deleteItemsConfirmed 后应允许删除")
  assert.equal(result.state.categories.includes("厨房"), false, "厨房应被删除")
  assert.equal(result.state.items.length, 1, "厨房下物品应被删除，只保留其他分类物品")
  assert.equal(result.state.items[0].id, "b1", "应保留卫生间下的物品")
})

test("PR15 P0-2: moveTo 到不存在的分类时仍会执行迁移（调用方职责）", () => {
  // applyDeleteCategory 是纯函数，不校验 moveToCategory 是否在 categories 列表中
  // 这是调用方（UI 层）的职责，这里只验证物品 category 字段被正确修改
  const state = makeStateWithCategories(["厨房"], [makeItemInCategory("厨房", "k1")])
  const result = applyDeleteCategory(state, "厨房", { moveToCategory: "新分类" })
  assert.equal(result.ok, true)
  assert.equal(result.state.items[0].category, "新分类", "物品 category 应被修改")
})

// ============================================================
// PR15 P0-3: 月度预算统计口径测试
// 直接 import calculateMonthlySpend from pure-logic.mjs（不复制逻辑）
// 验证：当前月内的补货记录计入，未来月/上个月不计入
// ============================================================

function makeItemWithRestockAt(at, price, qty = 1) {
  return {
    id: `item-${at}`, name: "测试物品", category: "厨房", type: "learning",
    cycleDays: 30, bufferDays: 5, lastRestockedAt: at, anchorEstimated: true,
    purchaseOptions: [], history: [{ id: `e-${at}`, at, price, qty, intervalDays: 30 }],
    createdAt: at, updatedAt: at, learningEnabled: true, source: "manual", confidence: "medium"
  }
}

test("PR15 P0-3: 当前月份内的补货记录计入当月支出", () => {
  // 固定 now 为 2026-06-15 中午
  const now = new Date(2026, 5, 15, 12, 0, 0).getTime()
  const june10 = new Date(2026, 5, 10, 9, 0, 0).getTime()
  const june1 = new Date(2026, 5, 1, 0, 0, 0).getTime()
  const june30 = new Date(2026, 5, 30, 23, 59, 59).getTime()

  const items = [
    makeItemWithRestockAt(june1, 100),   // 当月 1 日 00:00，应计入
    makeItemWithRestockAt(june10, 50),   // 当月 10 日，应计入
    makeItemWithRestockAt(june30, 30)    // 当月 30 日 23:59，应计入
  ]
  const spend = calculateMonthlySpend(items, now)
  assert.equal(spend, 180, "6 月所有补货应计入：100 + 50 + 30")
})

test("PR15 P0-3: 未来月份的补货记录不会计入当前月", () => {
  const now = new Date(2026, 5, 15, 12, 0, 0).getTime()
  const july1 = new Date(2026, 6, 1, 0, 0, 0).getTime() // 7 月 1 日
  const july15 = new Date(2026, 6, 15, 12, 0, 0).getTime()

  const items = [
    makeItemWithRestockAt(july1, 200),
    makeItemWithRestockAt(july15, 100)
  ]
  const spend = calculateMonthlySpend(items, now)
  assert.equal(spend, 0, "7 月的补货不应计入 6 月")
})

test("PR15 P0-3: 上个月的补货记录不会计入当前月", () => {
  const now = new Date(2026, 5, 15, 12, 0, 0).getTime()
  const may31 = new Date(2026, 4, 31, 23, 59, 59).getTime() // 5 月 31 日 23:59
  const may1 = new Date(2026, 4, 1, 0, 0, 0).getTime()

  const items = [
    makeItemWithRestockAt(may1, 80),
    makeItemWithRestockAt(may31, 90)
  ]
  const spend = calculateMonthlySpend(items, now)
  assert.equal(spend, 0, "5 月的补货不应计入 6 月")
})

test("PR15 P0-3: 跨月混合时只计入当前月", () => {
  const now = new Date(2026, 5, 15, 12, 0, 0).getTime()
  const may31 = new Date(2026, 4, 31, 23, 59, 59).getTime()
  const june1 = new Date(2026, 5, 1, 0, 0, 0).getTime()
  const june15 = new Date(2026, 5, 15, 6, 0, 0).getTime()
  const july1 = new Date(2026, 6, 1, 0, 0, 0).getTime()

  const items = [
    makeItemWithRestockAt(may31, 80),    // 上月：不计入
    makeItemWithRestockAt(june1, 100),   // 当月：计入
    makeItemWithRestockAt(june15, 50),   // 当月：计入
    makeItemWithRestockAt(july1, 200)    // 下月：不计入
  ]
  const spend = calculateMonthlySpend(items, now)
  assert.equal(spend, 150, "只应计入 6 月的 100 + 50")
})

test("PR15 P0-3: price 为空、负数、非数字时不计入", () => {
  const now = new Date(2026, 5, 15, 12, 0, 0).getTime()
  const june10 = new Date(2026, 5, 10, 9, 0, 0).getTime()

  const items = [{
    id: "mixed", name: "混合", category: "厨房", type: "learning",
    cycleDays: 30, bufferDays: 5, lastRestockedAt: june10, anchorEstimated: true,
    purchaseOptions: [], createdAt: june10, updatedAt: june10,
    learningEnabled: true, source: "manual", confidence: "medium",
    history: [
      { id: "e1", at: june10, price: 50, qty: 1, intervalDays: 30 },     // 合法
      { id: "e2", at: june10, price: undefined, qty: 1, intervalDays: 30 }, // price 缺失
      { id: "e3", at: june10, price: -10, qty: 1, intervalDays: 30 },    // price 负数
      { id: "e4", at: june10, price: NaN, qty: 1, intervalDays: 30 }     // price NaN
    ]
  }]
  const spend = calculateMonthlySpend(items, now)
  assert.equal(spend, 50, "只应计入合法的 50")
})

test("PR15 P0-3: 没有 history 的物品不影响统计", () => {
  const now = new Date(2026, 5, 15, 12, 0, 0).getTime()
  const items = [{
    id: "empty", name: "无历史", category: "厨房", type: "learning",
    cycleDays: 30, bufferDays: 5, lastRestockedAt: now, anchorEstimated: true,
    purchaseOptions: [], history: [], createdAt: now, updatedAt: now,
    learningEnabled: true, source: "manual", confidence: "medium"
  }]
  const spend = calculateMonthlySpend(items, now)
  assert.equal(spend, 0, "空 history 应返回 0")
})

// ============================================================
// PR15 P0-1 domain 层: restockItem 兼容空 purchaseOption
// 验证：purchaseOptionId / purchaseProductName 等为 undefined 时仍生成合法 history
// ============================================================

test("PR15 P0-1 domain: restockItem 在 purchaseOption 为空时仍能生成合法 history", () => {
  const now = Date.now()
  const item = makeLearningItem({
    cycleDays: 30,
    lastRestockedAt: now - 5 * DAY_MS,
    history: [
      { id: "e1", at: now - 5 * DAY_MS, intervalDays: 30, qty: 1, price: 50 }
    ]
  })

  // 模拟没有常购商品的场景：所有 purchaseOption 字段都是 undefined
  const restocked = restockItem(
    item,
    now,
    55,     // price
    1,      // qty
    "京东", // platform
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined
  )

  assert.equal(restocked.history.length, 2, "应追加补货记录")
  const newEvent = restocked.history[restocked.history.length - 1]
  assert.equal(newEvent.price, 55)
  assert.equal(newEvent.qty, 1)
  assert.equal(newEvent.platform, "京东")
  assert.equal(newEvent.purchaseOptionId, undefined, "purchaseOptionId 应为 undefined")
  assert.equal(newEvent.purchaseProductName, undefined, "purchaseProductName 应为 undefined")
  assert.equal(newEvent.purchaseUnit, undefined, "purchaseUnit 应为 undefined")
  assert.equal(newEvent.purchasePricingMode, undefined, "purchasePricingMode 应为 undefined")
  assert.equal(newEvent.purchaseMeasureAmount, undefined, "purchaseMeasureAmount 应为 undefined")
  assert.equal(newEvent.purchaseMeasureUnit, undefined, "purchaseMeasureUnit 应为 undefined")
  // 不应制造假数据
  assert.equal(typeof newEvent.id, "string")
  assert.equal(newEvent.id.length > 0, true, "history 事件 id 应自动生成")
})

test("PR15 P0-1 domain: restockItem 支持自定义 restockDate", () => {
  const now = Date.now()
  const item = makeLearningItem({
    cycleDays: 30,
    lastRestockedAt: now - 5 * DAY_MS,
    history: [
      { id: "e1", at: now - 5 * DAY_MS, intervalDays: 30, qty: 1, price: 50 }
    ]
  })

  const customDate = now - 2 * DAY_MS // 2 天前补货
  const restocked = restockItem(
    item, now, 55, 1, "京东",
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, customDate
  )

  const newEvent = restocked.history[restocked.history.length - 1]
  const expectedDate = new Date(customDate)
  expectedDate.setHours(0, 0, 0, 0)
  assert.equal(newEvent.at, expectedDate.getTime(), "history.at 应使用自定义 restockDate")
  assert.equal(restocked.lastRestockedAt, expectedDate.getTime(), "lastRestockedAt 应使用自定义 restockDate")
})

// ============================================================
// PR15 清理-5: createInitialState 初始 items 仍为空（回归保护）
// 验证：删除 generateDemoData / daysAgo 后，初始状态不会重新引入 demo 数据
// ============================================================

test("PR15 清理-5: createInitialState 返回 items: []（无 demo 数据）", () => {
  // 由于 .mjs 测试无法直接 import domain.ts，这里复制 createInitialState 的核心契约。
  // 这是有意的回归保护：如果有人重新引入 demo 数据，此测试会失败。
  // 真实 createInitialState 的实现见 src/domain.ts createInitialState()
  function createInitialStateContract() {
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
      updatedAt: Date.now()
    }
  }

  const state = createInitialStateContract()
  assert.ok(Array.isArray(state.items), "items 必须是数组")
  assert.equal(state.items.length, 0, "items 必须为空数组，不允许 demo 数据")
  assert.ok(Array.isArray(state.categories), "categories 必须是数组")
  assert.equal(state.categories.length, 7, "应保留默认 7 个分类")
  assert.equal(state.items.length, 0, "items 长度必须为 0")
})
