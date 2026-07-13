// 任务：Agent 主动判断与反馈质量优化 - recordInsight 洞察引擎测试
// 运行方式：node --test tests/record-insight.test.mjs
//
// 覆盖：
// 1. 价格低于历史 → priceLowerThanUsual, 文案含「比之前低」或「划算」
// 2. 价格高于历史 → priceHigherThanUsual, level=warning, 文案含「比之前高」
// 3. 价格正常 → priceNormal, 不提示异常
// 4. 无历史不强判 → 不返回 priceHigherThanUsual / priceLowerThanUsual
// 5. 补货量明显偏多 → quantityHigherThanUsual, 文案含「比之前多」或「可用时间可能拉长」
// 6. 周期建议不自动修改 → cycleMayNeedAdjust, 不修改 state
// 7. 常购商品候选 → favoriteCandidate, 文案含「设为常购商品」
// 8. 预算反馈 → budgetImpact, 文案含「预算还剩」

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

const { buildRecordInsights, buildPostCommitInsights, pickTopInsights } = await import("../src/agent/recordInsight.ts")
const { buildChatDateContext } = await import("../src/llm/householdChat.ts")

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
  return { id: `evt_${price}_${qty}_${platform}_${daysAgo}`, at, price, qty, platform }
}

const dateContext = buildChatDateContext(Date.UTC(2026, 6, 9))

function findInsightByType(insights, type) {
  return insights.find((i) => i.type === type)
}

// ---------- 1. 价格低于历史 ----------

test("场景1: 猫砂历史约 30 元/袋，当前 5 袋 128 元（25.6/袋）→ priceLowerThanUsual", () => {
  const item = catItem("i1", "猫砂", {
    history: [
      restockEvent(90, 3, "京东", 30),   // 30/袋
      restockEvent(120, 4, "京东", 20),  // 30/袋
      restockEvent(60, 2, "京东", 10)    // 30/袋
    ]
  })
  const state = makeState({ items: [item] })
  const draft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 5,
    unit: "袋",
    price: 128,
    platform: "拼多多",
    restockDate: dateContext.now
  }
  const { insights } = buildRecordInsights({ draft, state, itemViews: [], dateContext })
  const priceInsight = findInsightByType(insights, "priceLowerThanUsual")
  assert.ok(priceInsight, "应返回 priceLowerThanUsual")
  assert.equal(priceInsight.level, "positive")
  // 文案应包含「比之前低」或「划算」
  assert.ok(
    priceInsight.message.includes("比之前") || priceInsight.message.includes("划算"),
    `文案应含「比之前低」或「划算」, 实际：${priceInsight.message}`
  )
  // 应包含单价 25.6
  assert.ok(priceInsight.message.includes("25.6"), `文案应含单价 25.6, 实际：${priceInsight.message}`)
})

// ---------- 2. 价格高于历史 ----------

test("场景2: 猫砂历史约 30 元/袋，当前 5 袋 190 元（38/袋）→ priceHigherThanUsual, level=warning", () => {
  const item = catItem("i1", "猫砂", {
    history: [
      restockEvent(90, 3, "京东", 30),
      restockEvent(120, 4, "京东", 20),
      restockEvent(60, 2, "京东", 10)
    ]
  })
  const state = makeState({ items: [item] })
  const draft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 5,
    unit: "袋",
    price: 190,
    platform: "京东",
    restockDate: dateContext.now
  }
  const { insights } = buildRecordInsights({ draft, state, itemViews: [], dateContext })
  const priceInsight = findInsightByType(insights, "priceHigherThanUsual")
  assert.ok(priceInsight, "应返回 priceHigherThanUsual")
  assert.equal(priceInsight.level, "warning")
  // 文案应包含「比之前高」或「价格高一些」
  assert.ok(
    priceInsight.message.includes("比之前") || priceInsight.message.includes("高一些"),
    `文案应含「比之前高」或「高一些」, 实际：${priceInsight.message}`
  )
})

// ---------- 3. 价格正常 ----------

test("场景3: 猫砂历史约 30 元/袋，当前 5 袋 150 元（30/袋）→ priceNormal, 不提示异常", () => {
  const item = catItem("i1", "猫砂", {
    history: [
      restockEvent(90, 3, "京东", 30),
      restockEvent(120, 4, "京东", 20),
      restockEvent(60, 2, "京东", 10)
    ]
  })
  const state = makeState({ items: [item] })
  const draft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 5,
    unit: "袋",
    price: 150,
    platform: "京东",
    restockDate: dateContext.now
  }
  const { insights } = buildRecordInsights({ draft, state, itemViews: [], dateContext })
  const priceInsight = findInsightByType(insights, "priceNormal")
  assert.ok(priceInsight, "应返回 priceNormal")
  // 不应同时返回 priceLowerThanUsual 或 priceHigherThanUsual
  assert.ok(!findInsightByType(insights, "priceLowerThanUsual"), "不应返回 priceLowerThanUsual")
  assert.ok(!findInsightByType(insights, "priceHigherThanUsual"), "不应返回 priceHigherThanUsual")
  // 文案应说明价格正常
  assert.ok(
    priceInsight.message.includes("差不多") || priceInsight.message.includes("没有明显异常"),
    `文案应说明价格正常, 实际：${priceInsight.message}`
  )
})

// ---------- 4. 无历史不强判 ----------

test("场景4: 无历史价格 → 不返回 priceHigherThanUsual / priceLowerThanUsual", () => {
  const state = makeState()  // 没有 items
  const draft = {
    kind: "createItemWithRestock",
    item: { kind: "createItem", itemName: "猫砂", category: "宠物用品", cycleDays: 14, bufferDays: 3, unit: "袋" },
    restock: { qty: 5, unit: "袋", price: 150, platform: "京东", restockDate: dateContext.now }
  }
  const { insights } = buildRecordInsights({ draft, state, itemViews: [], dateContext })
  // 无历史不应做强判断
  assert.ok(!findInsightByType(insights, "priceHigherThanUsual"), "无历史不应返回 priceHigherThanUsual")
  assert.ok(!findInsightByType(insights, "priceLowerThanUsual"), "无历史不应返回 priceLowerThanUsual")
  // 可以返回低置信参考（priceNormal）
  const priceNormal = findInsightByType(insights, "priceNormal")
  if (priceNormal) {
    assert.equal(priceNormal.confidence, "low", "无历史时 priceNormal 应为低置信")
    // 文案应说明之后多记几次才能判断
    assert.ok(
      priceNormal.message.includes("之后") || priceNormal.message.includes("多记"),
      `无历史文案应说明之后多记几次才能判断, 实际：${priceNormal.message}`
    )
  }
})

// ---------- 5. 补货量明显偏多 ----------

test("场景5: 历史常见 2 袋，这次 5 袋 → quantityHigherThanUsual", () => {
  const item = catItem("i1", "猫砂", {
    history: [
      restockEvent(60, 2, "京东", 30),
      restockEvent(60, 2, "京东", 20),
      restockEvent(60, 2, "京东", 10)
    ]
  })
  const state = makeState({ items: [item] })
  const draft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 5,
    unit: "袋",
    price: 150,
    platform: "京东",
    restockDate: dateContext.now
  }
  const { insights } = buildRecordInsights({ draft, state, itemViews: [], dateContext })
  const qtyInsight = findInsightByType(insights, "quantityHigherThanUsual")
  assert.ok(qtyInsight, "应返回 quantityHigherThanUsual")
  // 文案应包含「比之前多」或「可用时间可能拉长」
  assert.ok(
    qtyInsight.message.includes("比之前") || qtyInsight.message.includes("可用时间"),
    `文案应含「比之前多」或「可用时间可能拉长」, 实际：${qtyInsight.message}`
  )
})

// ---------- 6. 周期建议不自动修改 ----------

test("场景6: 补货量明显偏多时 → cycleMayNeedAdjust, 不修改 state", () => {
  const item = catItem("i1", "猫砂", {
    cycleDays: 14,
    history: [
      restockEvent(60, 2, "京东", 30),
      restockEvent(60, 2, "京东", 20),
      restockEvent(60, 2, "京东", 10)
    ]
  })
  const state = makeState({ items: [item] })
  const originalCycleDays = item.cycleDays
  const draft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 5,
    unit: "袋",
    price: 150,
    platform: "京东",
    restockDate: dateContext.now
  }
  const { insights } = buildRecordInsights({ draft, state, itemViews: [], dateContext })
  const cycleInsight = findInsightByType(insights, "cycleMayNeedAdjust")
  assert.ok(cycleInsight, "应返回 cycleMayNeedAdjust")
  // 文案应说明「先不自动改」或「再观察」
  assert.ok(
    cycleInsight.message.includes("先不自动改") || cycleInsight.message.includes("再观察") || cycleInsight.message.includes("可以适当拉长"),
    `文案应含「先不自动改」或「再观察」, 实际：${cycleInsight.message}`
  )
  // 不修改 state（buildRecordInsights 是纯函数，不传引用也不会改）
  assert.equal(item.cycleDays, originalCycleDays, "不应修改 item.cycleDays")
  assert.equal(state.items[0].cycleDays, originalCycleDays, "不应修改 state 中的 cycleDays")
})

// ---------- 7. 常购商品候选 ----------

test("场景7: 最近 3 次同平台购买猫砂，系统无常购商品 → favoriteCandidate", () => {
  const item = catItem("i1", "猫砂", {
    purchaseOptions: [],  // 尚无常购商品
    history: [
      restockEvent(30, 1, "拼多多", 40),
      restockEvent(30, 1, "拼多多", 30),
      restockEvent(30, 1, "拼多多", 20)
    ]
  })
  const state = makeState({ items: [item] })
  const draft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 1,
    unit: "袋",
    price: 30,
    platform: "拼多多",
    restockDate: dateContext.now
  }
  const { insights } = buildRecordInsights({ draft, state, itemViews: [], dateContext })
  const favoriteInsight = findInsightByType(insights, "favoriteCandidate")
  assert.ok(favoriteInsight, "应返回 favoriteCandidate")
  // 文案应包含「设为常购商品」
  assert.ok(
    favoriteInsight.message.includes("设为常购商品") || favoriteInsight.message.includes("常购商品"),
    `文案应含「设为常购商品」, 实际：${favoriteInsight.message}`
  )
  // 不应自动创建常购商品
  assert.equal(item.purchaseOptions.length, 0, "不应自动创建常购商品")
})

// ---------- 8. 预算反馈 ----------

test("场景8: 设置月预算 500，当前已用 300，本次 128 → budgetImpact, 文案含「预算还剩」", () => {
  // 构造已用 300 的历史记录
  const item = catItem("i1", "猫砂", {
    history: [
      { id: "evt_this_month_1", at: dateContext.now - 5 * 24 * 60 * 60 * 1000, price: 200, qty: 5, platform: "京东" },
      { id: "evt_this_month_2", at: dateContext.now - 3 * 24 * 60 * 60 * 1000, price: 100, qty: 3, platform: "京东" }
    ]
  })
  const state = makeState({
    items: [item],
    settings: { monthlyBudget: 500 }
  })
  const draft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 5,
    unit: "袋",
    price: 128,
    platform: "拼多多",
    restockDate: dateContext.now
  }
  // proposal 前用 buildRecordInsights（当前已用 300 + 本次 128 = 428，还剩 72）
  const { insights } = buildRecordInsights({ draft, state, itemViews: [], dateContext })
  const budgetInsight = findInsightByType(insights, "budgetImpact")
  assert.ok(budgetInsight, "应返回 budgetImpact")
  // 文案应包含「预算还剩」和金额
  assert.ok(
    budgetInsight.message.includes("预算还剩") || budgetInsight.message.includes("还剩"),
    `文案应含「预算还剩」, 实际：${budgetInsight.message}`
  )
  // 应包含 72（500 - 300 - 128 = 72）
  assert.ok(budgetInsight.message.includes("72"), `文案应含「72」, 实际：${budgetInsight.message}`)
})

// ---------- 9. commit 后预算反馈基于新 state ----------

test("场景9: buildPostCommitInsights 预算反馈基于新 state（history 已含本次补货）", () => {
  const item = catItem("i1", "猫砂", {
    history: [
      { id: "evt_this_month_1", at: dateContext.now - 5 * 24 * 60 * 60 * 1000, price: 200, qty: 5, platform: "京东" }
    ]
  })
  const state = makeState({
    items: [item],
    settings: { monthlyBudget: 500 }
  })
  const draft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 5,
    unit: "袋",
    price: 128,
    platform: "拼多多",
    restockDate: dateContext.now
  }
  // commit 后：新 state 的 history 已包含本次 128（模拟）
  // 但 buildPostCommitInsights 接收的是已写入后的 state
  // 这里我们直接用原 state 测，因为真正的 commit 由 executor 完成
  const newState = {
    ...state,
    items: [{
      ...item,
      history: [...item.history, { id: "evt_new", at: dateContext.now, price: 128, qty: 5, platform: "拼多多" }]
    }]
  }
  const { insights } = buildPostCommitInsights(draft, newState, [], dateContext)
  const budgetInsight = findInsightByType(insights, "budgetImpact")
  assert.ok(budgetInsight, "commit 后应返回 budgetImpact")
  // commit 后已用 = 200 + 128 = 328，还剩 172
  assert.ok(
    budgetInsight.message.includes("172"),
    `commit 后预算还剩应为 172, 实际：${budgetInsight.message}`
  )
})

// ---------- 10. 优先级排序：价格异常优先于预算 ----------

test("辅助: 价格偏低 + 预算反馈同时存在时，价格判断优先", () => {
  const item = catItem("i1", "猫砂", {
    history: [
      restockEvent(90, 3, "京东", 30),
      restockEvent(120, 4, "京东", 20),
      restockEvent(60, 2, "京东", 10)
    ]
  })
  const state = makeState({
    items: [item],
    settings: { monthlyBudget: 500 }
  })
  const draft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 5,
    unit: "袋",
    price: 128,
    platform: "拼多多",
    restockDate: dateContext.now
  }
  const { insights } = buildRecordInsights({ draft, state, itemViews: [], dateContext })
  const top = pickTopInsights(insights, 1)
  assert.ok(top.length > 0)
  // 第一条应该是价格判断（priceLowerThanUsual）
  assert.ok(
    top[0].type === "priceLowerThanUsual" || top[0].type === "priceHigherThanUsual",
    `优先级最高应为价格判断, 实际：${top[0].type}`
  )
})

// ---------- 11. review 已记录 ----------

test("辅助: 草稿含 review → 返回 reviewCaptured", () => {
  const item = catItem("i1", "猫砂", {
    history: [restockEvent(30, 1, "京东", 30)]
  })
  const state = makeState({ items: [item] })
  const draft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 1,
    unit: "袋",
    price: 30,
    platform: "京东",
    review: "品质不错，不起灰",
    restockDate: dateContext.now
  }
  const { insights } = buildRecordInsights({ draft, state, itemViews: [], dateContext })
  const reviewInsight = findInsightByType(insights, "reviewCaptured")
  assert.ok(reviewInsight, "应返回 reviewCaptured")
  assert.ok(reviewInsight.message.includes("品质不错"), `文案应含评价内容, 实际：${reviewInsight.message}`)
})
