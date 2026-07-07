// AgentPlan 第三期：删除类 action 的 actionRegistry 校验测试
// 运行方式：node --test tests/agent-plan-delete-registry.test.mjs
//
// 覆盖：
//   - deletePurchaseOption 物品不存在失败 / 多匹配失败 / 校验成功 / risk=high
//   - deleteRestockRecord 物品不存在失败 / 无补货记录失败 / recordId 不存在失败 / 校验成功 / risk=high
//   - deleteItem 物品不存在失败 / 校验成功 / summarize 展示影响范围 / risk=high
//   - deleteCategory 分类不存在失败 / 非空分类失败 / 空分类可删 / risk=high

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

const { validateAction, summarizeAction, getActionDefinition } = await import("../src/agent/actionRegistry.ts")
const { actionRisk } = await import("../src/agent/actions.ts")

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

// ---------- deletePurchaseOption ----------

test("deletePurchaseOption: risk = high", () => {
  assert.equal(actionRisk({ type: "deletePurchaseOption", itemName: "猫砂", productName: "pidan" }), "high")
  assert.equal(getActionDefinition("deletePurchaseOption").risk, "high")
})

test("deletePurchaseOption: 物品不存在 → error", () => {
  const state = makeState()
  const result = validateAction({ type: "deletePurchaseOption", itemName: "不存在的猫砂", productName: "pidan" }, state)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes("找不到")))
})

test("deletePurchaseOption: 常购商品不存在 → error", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = validateAction({ type: "deletePurchaseOption", itemName: "猫砂", productName: "不存在的商品" }, state)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes("没有")))
})

test("deletePurchaseOption: 多个匹配 → error", () => {
  const state = makeState({
    items: [{
      ...makeItem("i1", "猫砂"),
      purchaseOptions: [makeOpt("o1", "pidan"), makeOpt("o2", "pidan")]
    }]
  })
  const result = validateAction({ type: "deletePurchaseOption", itemName: "猫砂", productName: "pidan" }, state)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes("多个")))
})

test("deletePurchaseOption: 校验成功", () => {
  const state = makeState({
    items: [{ ...makeItem("i1", "猫砂"), purchaseOptions: [makeOpt("o1", "pidan 豆腐猫砂")] }]
  })
  const result = validateAction({ type: "deletePurchaseOption", itemName: "猫砂", productName: "pidan 豆腐猫砂" }, state)
  assert.equal(result.ok, true)
  assert.equal(result.errors.length, 0)
})

test("deletePurchaseOption: 缺少 productName 和 optionId → error", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = validateAction({ type: "deletePurchaseOption", itemName: "猫砂" }, state)
  assert.equal(result.ok, false)
})

test("summarizeAction: deletePurchaseOption 含物品名和商品名", () => {
  const summary = summarizeAction({ type: "deletePurchaseOption", itemName: "猫砂", productName: "pidan" }, makeState())
  assert.ok(summary.includes("猫砂"))
  assert.ok(summary.includes("pidan"))
  assert.ok(summary.includes("删除"))
})

// ---------- deleteRestockRecord ----------

test("deleteRestockRecord: risk = high", () => {
  assert.equal(actionRisk({ type: "deleteRestockRecord", itemName: "猫砂" }), "high")
  assert.equal(getActionDefinition("deleteRestockRecord").risk, "high")
})

test("deleteRestockRecord: 物品不存在 → error", () => {
  const state = makeState()
  const result = validateAction({ type: "deleteRestockRecord", itemName: "不存在的猫砂" }, state)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes("找不到")))
})

test("deleteRestockRecord: 无补货记录 → error", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = validateAction({ type: "deleteRestockRecord", itemName: "猫砂" }, state)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes("没有")))
})

test("deleteRestockRecord: recordId 不存在 → error", () => {
  const state = makeState({
    items: [{ ...makeItem("i1", "猫砂"), history: [makeEvent("e1", 1000)] }]
  })
  const result = validateAction({ type: "deleteRestockRecord", itemName: "猫砂", recordId: "不存在的记录" }, state)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes("找不到")))
})

test("deleteRestockRecord: 校验成功", () => {
  const state = makeState({
    items: [{ ...makeItem("i1", "猫砂"), history: [makeEvent("e1", 1000)] }]
  })
  const result = validateAction({ type: "deleteRestockRecord", itemName: "猫砂", recordId: "e1" }, state)
  assert.equal(result.ok, true)
})

test("summarizeAction: deleteRestockRecord 含物品名", () => {
  const summary = summarizeAction({ type: "deleteRestockRecord", itemName: "猫砂", dateHint: "最近一条" }, makeState())
  assert.ok(summary.includes("猫砂"))
  assert.ok(summary.includes("删除"))
})

// ---------- deleteItem ----------

test("deleteItem: risk = high", () => {
  assert.equal(actionRisk({ type: "deleteItem", itemName: "猫砂" }), "high")
  assert.equal(getActionDefinition("deleteItem").risk, "high")
})

test("deleteItem: 物品不存在 → error", () => {
  const state = makeState()
  const result = validateAction({ type: "deleteItem", itemName: "不存在的猫砂" }, state)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes("找不到")))
})

test("deleteItem: 校验成功", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = validateAction({ type: "deleteItem", itemName: "猫砂" }, state)
  assert.equal(result.ok, true)
})

test("summarizeAction: deleteItem 展示影响范围（含补货记录数和常购商品数）", () => {
  const state = makeState({
    items: [{
      ...makeItem("i1", "猫砂"),
      purchaseOptions: [makeOpt("o1", "pidan")],
      history: [makeEvent("e1", 1000), makeEvent("e2", 2000)]
    }]
  })
  const summary = summarizeAction({ type: "deleteItem", itemName: "猫砂" }, state)
  assert.ok(summary.includes("猫砂"))
  assert.ok(summary.includes("2"))
  assert.ok(summary.includes("不可撤销"))
})

// ---------- deleteCategory ----------

test("deleteCategory: risk = high", () => {
  assert.equal(actionRisk({ type: "deleteCategory", categoryName: "宠物用品" }), "high")
  assert.equal(getActionDefinition("deleteCategory").risk, "high")
})

test("deleteCategory: 分类不存在 → error", () => {
  const state = makeState()
  const result = validateAction({ type: "deleteCategory", categoryName: "不存在的分类" }, state)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes("不存在")))
})

test("deleteCategory: 非空分类 → error", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const result = validateAction({ type: "deleteCategory", categoryName: "宠物用品" }, state)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes("1") && e.includes("消耗品")))
})

test("deleteCategory: 空分类可删", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "日常护理")] })
  const result = validateAction({ type: "deleteCategory", categoryName: "宠物用品" }, state)
  assert.equal(result.ok, true)
  assert.equal(result.errors.length, 0)
})

test("summarizeAction: deleteCategory 含分类名", () => {
  const summary = summarizeAction({ type: "deleteCategory", categoryName: "宠物用品" }, makeState())
  assert.ok(summary.includes("宠物用品"))
  assert.ok(summary.includes("删除"))
})
