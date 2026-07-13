// 任务：基于历史/常识给参考，不再机械追问字段
// 运行方式：node --test tests/record-inference.test.mjs
//
// 覆盖：
// 1. 猫砂有历史单价约 30 元/袋，draft qty=5 → price suggestion value≈150, source=itemHistory, reason 含「30」
// 2. 猫砂历史价格波动大（15/30/45 元/袋）→ 返回 range, confidence=medium/low
// 3. 没有猫砂历史，但有 purchaseOption.price → 使用 purchaseOption, source=purchaseOption
// 4. 没有任何历史 → 返回 llmPrior/template, confidence=low, 文案不说「之前」

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

const { buildRecordSuggestions, findSuggestionByField } = await import("../src/agent/recordInference.ts")

function makeState(overrides = {}) {
  return {
    version: 3,
    categories: ["宠物用品", "日常护理", "其他"],
    items: [],
    settings: {},
    householdProfile: null,
    updatedAt: 1,
    ...overrides
  }
}

function catItem(id, name, extra = {}) {
  return {
    id, name, category: "宠物用品", type: "learning", cycleDays: 14, bufferDays: 2,
    lastRestockedAt: 1, anchorEstimated: false,
    purchaseOptions: [], history: [], createdAt: 1, updatedAt: 1, unit: "袋",
    ...extra
  }
}

function restockEvent(price, qty, platform, daysAgo = 0) {
  const at = Date.now() - daysAgo * 24 * 60 * 60 * 1000
  return { id: `evt_${price}_${qty}_${platform}`, at, price, qty, platform }
}

// ---------- 1. 历史单价 30 元/袋，draft qty=5 ----------

test("场景1: 猫砂历史约 30 元/袋，draft qty=5 → price suggestion value≈150, source=itemHistory", () => {
  const item = catItem("i1", "猫砂", {
    history: [
      restockEvent(29.9, 1, "京东", 30),
      restockEvent(31, 1, "京东", 20),
      restockEvent(60, 2, "京东", 10)
    ]
  })
  const state = makeState({ items: [item] })
  const itemViews = [{ item }]
  const draft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 5,
    unit: "袋",
    restockDate: 1000
    // price 缺失
  }
  const suggestions = buildRecordSuggestions(draft, state, itemViews)
  const price = findSuggestionByField(suggestions, "price")
  assert.ok(price, "应返回 price suggestion")
  assert.equal(price.source, "itemHistory")
  assert.ok(price.confidence === "high" || price.confidence === "medium", `confidence 应为 high/medium, 实际 ${price.confidence}`)
  // value 应接近 150（历史单价约 30，5 袋约 150）
  assert.ok(price.value !== undefined, "波动小应给 value")
  const diff = Math.abs(price.value - 150)
  assert.ok(diff <= 5, `value 应接近 150, 实际 ${price.value}`)
  // reason 应包含「30」
  assert.match(price.reason, /30/, "reason 应包含 30 元/袋的提示")
})

// ---------- 2. 历史价格波动大 ----------

test("场景2: 猫砂历史价格波动大（15/30/45 元/袋）→ 返回 range, confidence=medium/low", () => {
  const item = catItem("i1", "猫砂", {
    history: [
      restockEvent(15, 1, "淘宝", 30),
      restockEvent(30, 1, "京东", 20),
      restockEvent(45, 1, "天猫", 10)
    ]
  })
  const state = makeState({ items: [item] })
  const itemViews = [{ item }]
  const draft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 2,
    unit: "袋",
    restockDate: 1000
  }
  const suggestions = buildRecordSuggestions(draft, state, itemViews)
  const price = findSuggestionByField(suggestions, "price")
  assert.ok(price)
  assert.equal(price.source, "itemHistory")
  assert.ok(price.range, "波动大应返回 range 而不是 value")
  assert.equal(price.value, undefined, "波动大不应给单一 value")
  assert.ok(price.confidence === "medium" || price.confidence === "low", `confidence 应为 medium/low, 实际 ${price.confidence}`)
  // range 应该体现波动：min ≈ 30 (15*2), max ≈ 90 (45*2)
  assert.ok(price.range.min <= 35, `range.min 应接近 30, 实际 ${price.range.min}`)
  assert.ok(price.range.max >= 85, `range.max 应接近 90, 实际 ${price.range.max}`)
})

// ---------- 3. 没有历史，但有 purchaseOption 价格 ----------

test("场景3: 没有猫砂历史，但有 purchaseOption.price → 使用 purchaseOption, source=purchaseOption", () => {
  const item = catItem("i1", "猫砂", {
    history: [],
    purchaseOptions: [
      { id: "po1", productName: "某品牌猫砂 10L", unit: "袋", price: 28, isDefault: true }
    ]
  })
  const state = makeState({ items: [item] })
  const itemViews = [{ item }]
  const draft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 3,
    unit: "袋",
    restockDate: 1000
  }
  const suggestions = buildRecordSuggestions(draft, state, itemViews)
  const price = findSuggestionByField(suggestions, "price")
  assert.ok(price)
  assert.equal(price.source, "purchaseOption")
  // 28 * 3 = 84
  assert.ok(price.value !== undefined)
  assert.equal(price.value, 84, `3 袋 * 28 元应 = 84, 实际 ${price.value}`)
})

// ---------- 4. 没有任何历史 ----------

test("场景4: 没有任何历史 → 返回 llmPrior, confidence=low, 文案不说「之前」", () => {
  const state = makeState()  // 没有 items
  const itemViews = []
  const draft = {
    kind: "createItemWithRestock",
    item: { kind: "createItem", itemName: "猫砂", category: "宠物用品", cycleDays: 14, bufferDays: 3, unit: "袋" },
    restock: { qty: 5, unit: "袋", restockDate: 1000 }
  }
  const suggestions = buildRecordSuggestions(draft, state, itemViews)
  const price = findSuggestionByField(suggestions, "price")
  assert.ok(price, "无历史也应返回 llmPrior 兜底参考")
  assert.equal(price.source, "llmPrior")
  assert.equal(price.confidence, "low")
  // 文案不能伪装成历史事实，不应说「之前」
  assert.ok(!price.reason.includes("之前"), `llmPrior reason 不应说「之前」, 实际：${price.reason}`)
  // 文案应说「常见」或「粗估」
  assert.ok(price.reason.includes("常见") || price.reason.includes("粗估"), `llmPrior reason 应说明是常见范围/粗估, 实际：${price.reason}`)
  // 应给 range（5 袋猫砂 20-50 一袋，约 100-250）
  assert.ok(price.range, "无历史应给区间")
  assert.ok(price.range.min >= 80 && price.range.min <= 120, `range.min 应在 80-120, 实际 ${price.range.min}`)
  assert.ok(price.range.max >= 220 && price.range.max <= 280, `range.max 应在 220-280, 实际 ${price.range.max}`)
})

// ---------- 额外：字段已齐全时不给建议 ----------

test("辅助: price 已填 → 不给价格建议", () => {
  const item = catItem("i1", "猫砂", {
    history: [restockEvent(30, 1, "京东", 10)]
  })
  const state = makeState({ items: [item] })
  const itemViews = [{ item }]
  const draft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 2,
    unit: "袋",
    price: 60,  // 已填
    platform: "京东",
    restockDate: 1000
  }
  const suggestions = buildRecordSuggestions(draft, state, itemViews)
  const price = findSuggestionByField(suggestions, "price")
  assert.equal(price, undefined, "price 已填时不应给价格建议")
})

// ---------- 额外：平台建议 ----------

test("辅助: 缺平台且有历史平台 → 给平台建议", () => {
  const item = catItem("i1", "猫砂", {
    history: [
      restockEvent(30, 1, "京东", 30),
      restockEvent(30, 1, "京东", 20)
    ]
  })
  const state = makeState({ items: [item] })
  const itemViews = [{ item }]
  const draft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 1,
    unit: "袋",
    price: 30,
    restockDate: 1000
    // platform 缺失
  }
  const suggestions = buildRecordSuggestions(draft, state, itemViews)
  const platform = findSuggestionByField(suggestions, "platform")
  assert.ok(platform, "应给平台建议")
  assert.equal(platform.source, "itemHistory")
  assert.equal(platform.value, "京东")
  assert.match(platform.reason, /京东/)
})

// ---------- 额外：用户已说平台时不给平台建议 ----------

test("辅助: 用户已说平台 → 不给平台建议", () => {
  const item = catItem("i1", "猫砂", {
    history: [restockEvent(30, 1, "京东", 30)]
  })
  const state = makeState({ items: [item] })
  const itemViews = [{ item }]
  const draft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 1,
    unit: "袋",
    price: 30,
    platform: "拼多多",  // 用户已说
    restockDate: 1000
  }
  const suggestions = buildRecordSuggestions(draft, state, itemViews)
  const platform = findSuggestionByField(suggestions, "platform")
  assert.equal(platform, undefined, "用户已说平台时不应给平台建议")
})

// ---------- 额外：createItem 草稿不涉及价格/平台 ----------

test("辅助: createItem 草稿不返回价格/平台建议", () => {
  const state = makeState()
  const draft = {
    kind: "createItem",
    itemName: "猫砂",
    category: "宠物用品",
    cycleDays: 14,
    bufferDays: 3,
    unit: "袋"
  }
  const suggestions = buildRecordSuggestions(draft, state, [])
  const price = findSuggestionByField(suggestions, "price")
  const platform = findSuggestionByField(suggestions, "platform")
  assert.equal(price, undefined)
  assert.equal(platform, undefined)
})

// ---------- 价格先验（pricePrior）测试 ----------

test("pricePrior: 宠物擦脚巾湿巾 5 包 → 25–75 区间，confidence=low", () => {
  const state = makeState()  // 无 items
  const draft = {
    kind: "createItemWithRestock",
    item: { kind: "createItem", itemName: "宠物擦脚巾湿巾", category: "宠物用品", cycleDays: 14, bufferDays: 3, unit: "包" },
    restock: { qty: 5, unit: "包", restockDate: 1000 }
  }
  const suggestions = buildRecordSuggestions(draft, state, [])
  const price = findSuggestionByField(suggestions, "price")
  assert.ok(price, "宠物擦脚巾应命中 pricePrior")
  assert.equal(price.source, "llmPrior")
  assert.equal(price.confidence, "low")
  assert.ok(price.range, "应返回区间")
  // 5-15 元/包 × 5 包 = 25-75
  assert.ok(price.range.min >= 20 && price.range.min <= 30, `range.min 应接近 25, 实际 ${price.range.min}`)
  assert.ok(price.range.max >= 65 && price.range.max <= 85, `range.max 应接近 75, 实际 ${price.range.max}`)
  // 不应出现 75-200 这种过宽区间
  assert.ok(price.range.max <= 100, `range.max 不应超过 100, 实际 ${price.range.max}`)
})

test("pricePrior: 未知物品「临时用品」→ 不返回价格建议", () => {
  const state = makeState()
  const draft = {
    kind: "createItemWithRestock",
    item: { kind: "createItem", itemName: "临时用品", category: "其他", cycleDays: 30, bufferDays: 3, unit: "包" },
    restock: { qty: 5, unit: "包", restockDate: 1000 }
  }
  const suggestions = buildRecordSuggestions(draft, state, [])
  const price = findSuggestionByField(suggestions, "price")
  assert.equal(price, undefined, "未知物品不应返回价格建议")
})

test("pricePrior: 猫砂 5 袋无历史 → 100–250 区间，confidence=low", () => {
  const state = makeState()
  const draft = {
    kind: "createItemWithRestock",
    item: { kind: "createItem", itemName: "猫砂", category: "宠物用品", cycleDays: 14, bufferDays: 3, unit: "袋" },
    restock: { qty: 5, unit: "袋", restockDate: 1000 }
  }
  const suggestions = buildRecordSuggestions(draft, state, [])
  const price = findSuggestionByField(suggestions, "price")
  assert.ok(price, "猫砂应命中 pricePrior")
  assert.equal(price.source, "llmPrior")
  assert.equal(price.confidence, "low")
  assert.ok(price.range)
  // 20-50 元/袋 × 5 袋 = 100-250
  assert.ok(price.range.min >= 90 && price.range.min <= 110, `range.min 应接近 100, 实际 ${price.range.min}`)
  assert.ok(price.range.max >= 240 && price.range.max <= 260, `range.max 应接近 250, 实际 ${price.range.max}`)
})

test("pricePrior: 有历史时优先用历史，不使用 pricePrior", () => {
  const item = catItem("i1", "猫砂", {
    history: [restockEvent(90, 3, "京东", 30)]  // 30 元/袋
  })
  const state = makeState({ items: [item] })
  const itemViews = [{ item }]
  const draft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 5,
    unit: "袋",
    restockDate: 1000
  }
  const suggestions = buildRecordSuggestions(draft, state, itemViews)
  const price = findSuggestionByField(suggestions, "price")
  assert.ok(price)
  assert.equal(price.source, "itemHistory", "有历史时应优先用 itemHistory")
  assert.notEqual(price.source, "llmPrior", "不应使用 pricePrior")
  // 估算 150（30 × 5）
  if (price.value) {
    assert.ok(Math.abs(price.value - 150) <= 5, `value 应接近 150, 实际：${price.value}`)
  }
})
