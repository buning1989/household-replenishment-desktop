// AgentPlan 第三期：删除类 action 的 executor 执行测试
// 运行方式：node --test tests/agent-plan-delete-executor.test.mjs
//
// 覆盖：
//   - deletePurchaseOption 成功 / 默认商品删除后无残留默认状态 / 常购商品不存在失败
//   - deleteRestockRecord 成功（recordId / dateHint / price）/ 多匹配失败 / 无记录失败
//   - deleteItem 成功（连带 history/options 全部移除）/ 物品不存在失败
//   - deleteCategory 空分类成功 / 非空分类失败且 state 不变
//   - 删除失败时回滚 state（不产生部分错误写入）
//   - 多 action 删除失败时停止后续 action

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

const { commitAgentPlan, applyAgentAction } = await import("../src/agent/executor.ts")
const { createAgentPlan } = await import("../src/agent/actions.ts")

function makeState(overrides = {}) {
  return {
    version: 3,
    categories: ["宠物用品", "日常护理", "其他"],
    items: [],
    settings: { reminderIntervalHours: 1, quietStart: "22:00", quietEnd: "08:00", notificationEnabled: true },
    householdProfile: null,
    updatedAt: 1,
    ...overrides
  }
}

function makeItem(id, name, category = "宠物用品") {
  return {
    id, name, category, type: "learning", cycleDays: 14, bufferDays: 2,
    lastRestockedAt: 1, anchorEstimated: false,
    purchaseOptions: [], history: [], createdAt: 1, updatedAt: 1, unit: "袋",
    learningEnabled: true, source: "manual", confidence: "high", feedbackCount: 0
  }
}

function makeOpt(id, productName, extra = {}) {
  return { id, productName, unit: "袋", pricingMode: "spec", ...extra }
}

function makeEvent(id, at, extra = {}) {
  return { id, at, qty: 1, price: 30, platform: "京东", review: undefined, purchaseProductName: "pidan", purchaseUnit: "袋", purchaseMeasureAmount: undefined, purchaseMeasureUnit: undefined, ...extra }
}

function planWith(actions, sourceText = "test") {
  return createAgentPlan(actions, sourceText, 1000)
}

// ---------- deletePurchaseOption ----------

test("deletePurchaseOption: 成功删除常购商品", () => {
  const state = makeState({
    items: [{
      ...makeItem("i1", "猫砂"),
      purchaseOptions: [makeOpt("o1", "pidan"), makeOpt("o2", "怡亲")]
    }]
  })
  const plan = planWith([{ type: "deletePurchaseOption", itemName: "猫砂", productName: "pidan" }])
  const result = commitAgentPlan(state, plan, 1000)
  const item = result.state.items.find((i) => i.id === "i1")
  assert.equal(item.purchaseOptions.length, 1, "应剩 1 个常购商品")
  assert.equal(item.purchaseOptions[0].productName, "怡亲")
  assert.match(result.summary, /已删除常购商品/)
})

test("deletePurchaseOption: 删除默认常购商品后不残留错误默认状态", () => {
  const state = makeState({
    items: [{
      ...makeItem("i1", "猫砂"),
      purchaseOptions: [
        makeOpt("o1", "pidan", { isDefault: true }),
        makeOpt("o2", "怡亲", { isDefault: false })
      ]
    }]
  })
  const plan = planWith([{ type: "deletePurchaseOption", itemName: "猫砂", productName: "pidan" }])
  const result = commitAgentPlan(state, plan, 1000)
  const item = result.state.items.find((i) => i.id === "i1")
  assert.equal(item.purchaseOptions.length, 1)
  // 删除默认商品后，怡亲不应被自动设为默认（保持原 isDefault=false）
  assert.equal(item.purchaseOptions[0].productName, "怡亲")
  assert.equal(item.purchaseOptions[0].isDefault, false, "不自动设新默认")
})

test("deletePurchaseOption: 常购商品不存在 → ok=false，state 不变", () => {
  const state = makeState({
    items: [{ ...makeItem("i1", "猫砂"), purchaseOptions: [makeOpt("o1", "pidan")] }]
  })
  const plan = planWith([{ type: "deletePurchaseOption", itemName: "猫砂", productName: "不存在的商品" }])
  const result = commitAgentPlan(state, plan, 1000)
  assert.equal(result.state, state, "失败时返回原 state")
  const item = result.state.items.find((i) => i.id === "i1")
  assert.equal(item.purchaseOptions.length, 1, "原常购商品应保留")
})

test("deletePurchaseOption: 物品不存在 → ok=false，state 不变", () => {
  const state = makeState()
  const plan = planWith([{ type: "deletePurchaseOption", itemName: "不存在的猫砂", productName: "pidan" }])
  const result = commitAgentPlan(state, plan, 1000)
  assert.equal(result.state, state, "失败时返回原 state")
})

// ---------- deleteRestockRecord ----------

test("deleteRestockRecord: 按 recordId 删除成功", () => {
  const state = makeState({
    items: [{
      ...makeItem("i1", "猫砂"),
      history: [makeEvent("e1", 1000), makeEvent("e2", 2000)]
    }]
  })
  const plan = planWith([{ type: "deleteRestockRecord", itemName: "猫砂", recordId: "e1" }])
  const result = commitAgentPlan(state, plan, 1000)
  const item = result.state.items.find((i) => i.id === "i1")
  assert.equal(item.history.length, 1, "应剩 1 条记录")
  assert.equal(item.history[0].id, "e2")
  assert.match(result.summary, /已删除补货记录/)
})

test("deleteRestockRecord: 按 dateHint 删除最近一条成功", () => {
  const now = Date.now()
  const yesterday = now - 24 * 60 * 60 * 1000
  const state = makeState({
    items: [{
      ...makeItem("i1", "猫砂"),
      history: [makeEvent("e1", 1000), makeEvent("e2", yesterday)]
    }]
  })
  const plan = planWith([{ type: "deleteRestockRecord", itemName: "猫砂", dateHint: "最近一条" }])
  const result = commitAgentPlan(state, plan, 1000)
  const item = result.state.items.find((i) => i.id === "i1")
  assert.equal(item.history.length, 1, "应剩 1 条记录")
  assert.equal(item.history[0].id, "e1", "应删除最后一条（最近一条）")
})

test("deleteRestockRecord: 按 price 匹配成功", () => {
  const state = makeState({
    items: [{
      ...makeItem("i1", "猫砂"),
      history: [makeEvent("e1", 1000, { price: 30 }), makeEvent("e2", 2000, { price: 58 })]
    }]
  })
  const plan = planWith([{ type: "deleteRestockRecord", itemName: "猫砂", price: 58 }])
  const result = commitAgentPlan(state, plan, 1000)
  const item = result.state.items.find((i) => i.id === "i1")
  assert.equal(item.history.length, 1)
  assert.equal(item.history[0].id, "e1", "应删除 price=58 的记录")
})

test("deleteRestockRecord: 多匹配 → ok=false，state 不变", () => {
  const state = makeState({
    items: [{
      ...makeItem("i1", "猫砂"),
      history: [makeEvent("e1", 1000, { price: 30 }), makeEvent("e2", 2000, { price: 30 })]
    }]
  })
  const plan = planWith([{ type: "deleteRestockRecord", itemName: "猫砂", price: 30 }])
  const result = commitAgentPlan(state, plan, 1000)
  assert.equal(result.state, state, "多匹配时返回原 state")
  const item = result.state.items.find((i) => i.id === "i1")
  assert.equal(item.history.length, 2, "两条记录都应保留")
  assert.match(result.summary, /请明确指定/)
})

test("deleteRestockRecord: 无补货记录 → ok=false", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const plan = planWith([{ type: "deleteRestockRecord", itemName: "猫砂" }])
  const result = commitAgentPlan(state, plan, 1000)
  assert.equal(result.state, state)
  assert.match(result.summary, /没有补货记录/)
})

test("deleteRestockRecord: 默认删最近一条（无 hint 无 recordId）", () => {
  const state = makeState({
    items: [{
      ...makeItem("i1", "猫砂"),
      history: [makeEvent("e1", 1000), makeEvent("e2", 2000)]
    }]
  })
  const plan = planWith([{ type: "deleteRestockRecord", itemName: "猫砂" }])
  const result = commitAgentPlan(state, plan, 1000)
  const item = result.state.items.find((i) => i.id === "i1")
  assert.equal(item.history.length, 1)
  assert.equal(item.history[0].id, "e1", "默认删除最后一条")
})

// ---------- deleteItem ----------

test("deleteItem: 成功删除物品（连带 history/options）", () => {
  const state = makeState({
    items: [{
      ...makeItem("i1", "猫砂"),
      purchaseOptions: [makeOpt("o1", "pidan")],
      history: [makeEvent("e1", 1000), makeEvent("e2", 2000)]
    }, makeItem("i2", "猫粮")]
  })
  const plan = planWith([{ type: "deleteItem", itemName: "猫砂" }])
  const result = commitAgentPlan(state, plan, 1000)
  assert.equal(result.state.items.length, 1, "应剩 1 个物品")
  assert.equal(result.state.items[0].id, "i2")
  assert.match(result.summary, /已删除消耗品/)
  assert.ok(result.summary.includes("2") && result.summary.includes("1"), "应展示 history/option 数量")
})

test("deleteItem: 物品不存在 → ok=false，state 不变", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const plan = planWith([{ type: "deleteItem", itemName: "不存在的物品" }])
  const result = commitAgentPlan(state, plan, 1000)
  assert.equal(result.state, state)
  assert.match(result.summary, /找不到/)
})

// ---------- deleteCategory ----------

test("deleteCategory: 空分类删除成功", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "日常护理")] })
  const plan = planWith([{ type: "deleteCategory", categoryName: "宠物用品" }])
  const result = commitAgentPlan(state, plan, 1000)
  assert.ok(!result.state.categories.includes("宠物用品"), "分类应被删除")
  assert.match(result.summary, /已删除分类/)
})

test("deleteCategory: 非空分类 → ok=false，state 不变（不连带删除 item）", () => {
  const originalState = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const plan = planWith([{ type: "deleteCategory", categoryName: "宠物用品" }])
  const result = commitAgentPlan(originalState, plan, 1000)
  assert.equal(result.state, originalState, "失败时返回原 state")
  assert.ok(result.state.categories.includes("宠物用品"), "分类应保留")
  assert.equal(result.state.items.length, 1, "item 不应被连带删除")
  assert.match(result.summary, /还有.*消耗品/)
})

test("deleteCategory: 分类不存在 → ok=false", () => {
  const state = makeState()
  const plan = planWith([{ type: "deleteCategory", categoryName: "不存在的分类" }])
  const result = commitAgentPlan(state, plan, 1000)
  assert.equal(result.state, state)
  assert.match(result.summary, /不存在/)
})

// ---------- 回滚与多 action 失败 ----------

test("删除失败时回滚 state，不产生部分错误写入", () => {
  const originalState = makeState({
    items: [{
      ...makeItem("i1", "猫砂"),
      purchaseOptions: [makeOpt("o1", "pidan")],
      history: [makeEvent("e1", 1000)]
    }]
  })
  // deleteItem 成功 + deleteCategory 失败（因为 item 还在宠物用品下，但 item 已被删，所以非空检查应触发）
  // 注意：executor 顺序执行，deleteItem 已删 i1，此时 deleteCategory 应看到空分类可删
  // 改成：deleteCategory 失败 + deleteItem 不执行
  const plan = planWith([
    { type: "deleteCategory", categoryName: "宠物用品" }, // 非空失败
    { type: "deleteItem", itemName: "猫砂" } // 应被跳过
  ])
  const result = commitAgentPlan(originalState, plan, 1000)
  assert.equal(result.state, originalState, "失败时返回原 state")
  assert.equal(result.state.items.length, 1, "item 不应被删除")
  assert.match(result.summary, /还有.*消耗品/)
})

test("多 action 删除失败时停止后续 action", () => {
  const originalState = makeState({
    items: [{
      ...makeItem("i1", "猫砂"),
      purchaseOptions: [makeOpt("o1", "pidan")],
      history: [makeEvent("e1", 1000)]
    }]
  })
  // deletePurchaseOption 失败（商品不存在）+ deleteItem 不应执行
  const plan = planWith([
    { type: "deletePurchaseOption", itemName: "猫砂", productName: "不存在的商品" },
    { type: "deleteItem", itemName: "猫砂" }
  ])
  const result = commitAgentPlan(originalState, plan, 1000)
  assert.equal(result.state, originalState, "失败时返回原 state")
  assert.equal(result.state.items.length, 1, "deleteItem 不应执行")
  assert.equal(result.state.items[0].purchaseOptions.length, 1, "常购商品应保留")
})
