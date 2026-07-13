// 任务 P6: AgentPlan 第二期 actionRegistry 校验测试
// 运行方式：node --test tests/agent-plan-edit-registry.test.mjs
//
// 覆盖：
//   - renameCategory 校验成功 / 同名冲突失败
//   - moveItem 目标 item 不存在失败（warning） / 目标分类不存在 warning
//   - updateItemReminder 提前天数为负失败 / 非整数失败
//   - updatePurchaseOption 目标商品不存在 warning / 必填字段缺失
//   - setDefaultPurchaseOption 目标商品不存在 warning
//   - updateItemUnit 单位为空失败
//   - summarize 产出非空文案

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

const { validateAction, summarizeAction } = await import("../src/agent/actionRegistry.ts")

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
    purchaseOptions: [], history: [], createdAt: 1, updatedAt: 1, unit: "袋"
  }
}

function makeOpt(id, productName) {
  return { id, productName, unit: "袋", pricingMode: "spec" }
}

// ---------- renameCategory ----------

test("renameCategory: 校验成功", () => {
  const state = makeState()
  const result = validateAction({ type: "renameCategory", oldName: "宠物用品", newName: "猫咪用品" }, state)
  assert.equal(result.ok, true)
  assert.equal(result.errors.length, 0)
})

test("renameCategory: 同名冲突失败", () => {
  const state = makeState()
  // newName 与已有分类「日常护理」同名 → error
  const result = validateAction({ type: "renameCategory", oldName: "宠物用品", newName: "日常护理" }, state)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes("重名")), `应含"重名", 实际：${result.errors}`)
})

test("renameCategory: 原分类不存在失败", () => {
  const state = makeState()
  const result = validateAction({ type: "renameCategory", oldName: "不存在的分类", newName: "新分类" }, state)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes("不存在")))
})

test("renameCategory: 新旧同名失败", () => {
  const state = makeState()
  const result = validateAction({ type: "renameCategory", oldName: "宠物用品", newName: "宠物用品" }, state)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes("相同")))
})

// ---------- moveItem ----------

test("moveItem: 目标物品不存在 → warning（不阻断）", () => {
  const state = makeState()
  const result = validateAction({ type: "moveItem", itemName: "不存在的猫砂", targetCategory: "宠物用品" }, state)
  assert.equal(result.ok, true, "warning 不阻断")
  assert.ok(result.warnings.some((w) => w.includes("找不到")))
})

test("moveItem: 目标分类不存在 → warning（本期不自动创建）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = validateAction({ type: "moveItem", itemName: "猫砂", targetCategory: "不存在的分类" }, state)
  assert.equal(result.ok, true, "warning 不阻断")
  assert.ok(result.warnings.some((w) => w.includes("不存在")))
})

test("moveItem: 缺少 itemId/itemName → error", () => {
  const state = makeState()
  const result = validateAction({ type: "moveItem", targetCategory: "宠物用品" }, state)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes("itemId") || e.includes("itemName")))
})

// ---------- updateItemReminder ----------

test("updateItemReminder: 提前天数为负失败", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = validateAction({ type: "updateItemReminder", itemName: "猫砂", bufferDays: -1 }, state)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes("非负整数") || e.includes("负")))
})

test("updateItemReminder: 提前天数为非整数失败", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = validateAction({ type: "updateItemReminder", itemName: "猫砂", bufferDays: 2.5 }, state)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes("整数")))
})

test("updateItemReminder: 校验成功", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = validateAction({ type: "updateItemReminder", itemName: "猫砂", bufferDays: 5 }, state)
  assert.equal(result.ok, true)
  assert.equal(result.errors.length, 0)
})

test("updateItemReminder: 0 是合法值（到期当天提醒）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = validateAction({ type: "updateItemReminder", itemName: "猫砂", bufferDays: 0 }, state)
  assert.equal(result.ok, true)
})

// ---------- updatePurchaseOption ----------

test("updatePurchaseOption: 目标商品不存在 → warning（不阻断）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = validateAction({
    type: "updatePurchaseOption", itemName: "猫砂", productName: "不存在的猫砂品牌", patch: { price: 50 }
  }, state)
  assert.equal(result.ok, true, "warning 不阻断")
  assert.ok(result.warnings.some((w) => w.includes("找不到")))
})

test("updatePurchaseOption: 缺少 optionId 和 productName → error", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = validateAction({
    type: "updatePurchaseOption", itemName: "猫砂", patch: { price: 50 }
  }, state)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes("optionId") || e.includes("productName")))
})

test("updatePurchaseOption: 价格为负失败", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = validateAction({
    type: "updatePurchaseOption", itemName: "猫砂", productName: "pidan", patch: { price: -10 }
  }, state)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes("负")))
})

test("updatePurchaseOption: 无任何 patch 字段 → warning", () => {
  const state = makeState({ items: [{ ...makeItem("i1", "猫砂"), purchaseOptions: [makeOpt("o1", "pidan")] }] })
  const result = validateAction({
    type: "updatePurchaseOption", itemName: "猫砂", productName: "pidan", patch: {}
  }, state)
  assert.equal(result.ok, true, "warning 不阻断")
  assert.ok(result.warnings.some((w) => w.includes("没有指定")))
})

// ---------- setDefaultPurchaseOption ----------

test("setDefaultPurchaseOption: 目标商品不存在 → warning（不阻断）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = validateAction({
    type: "setDefaultPurchaseOption", itemName: "猫砂", productName: "不存在的猫砂品牌"
  }, state)
  assert.equal(result.ok, true, "warning 不阻断")
  assert.ok(result.warnings.some((w) => w.includes("找不到")))
})

test("setDefaultPurchaseOption: 缺少 optionId 和 productName → error", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = validateAction({
    type: "setDefaultPurchaseOption", itemName: "猫砂"
  }, state)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes("optionId") || e.includes("productName")))
})

// ---------- updateItemUnit ----------

test("updateItemUnit: 单位为空失败", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = validateAction({ type: "updateItemUnit", itemName: "猫砂", unit: "" }, state)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes("单位")))
})

test("updateItemUnit: 校验成功", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = validateAction({ type: "updateItemUnit", itemName: "猫砂", unit: "包" }, state)
  assert.equal(result.ok, true)
})

// ---------- summarize 产出非空文案 ----------

test("summarizeAction: renameCategory 含旧名新名", () => {
  const summary = summarizeAction({ type: "renameCategory", oldName: "宠物用品", newName: "猫咪用品" }, makeState())
  assert.ok(summary.includes("宠物用品"))
  assert.ok(summary.includes("猫咪用品"))
})

test("summarizeAction: moveItem 含物品名和目标分类", () => {
  const summary = summarizeAction({ type: "moveItem", itemName: "猫砂", targetCategory: "猫咪用品" }, makeState())
  assert.ok(summary.includes("猫砂"))
  assert.ok(summary.includes("猫咪用品"))
})

test("summarizeAction: updateItemUnit 含单位", () => {
  const summary = summarizeAction({ type: "updateItemUnit", itemName: "猫砂", unit: "包" }, makeState())
  assert.ok(summary.includes("猫砂"))
  assert.ok(summary.includes("包"))
})

test("summarizeAction: updateItemReminder 含提前天数", () => {
  const summary = summarizeAction({ type: "updateItemReminder", itemName: "猫砂", bufferDays: 5 }, makeState())
  assert.ok(summary.includes("猫砂"))
  assert.ok(summary.includes("5"))
  assert.ok(summary.includes("提前"))
})

test("summarizeAction: updatePurchaseOption 含物品名和常购商品名", () => {
  const summary = summarizeAction({
    type: "updatePurchaseOption", itemName: "猫砂", productName: "pidan", patch: { price: 58 }
  }, makeState())
  assert.ok(summary.includes("猫砂"))
  assert.ok(summary.includes("pidan"))
  assert.ok(summary.includes("58"))
})

test("summarizeAction: setDefaultPurchaseOption 含物品名和常购商品名", () => {
  const summary = summarizeAction({
    type: "setDefaultPurchaseOption", itemName: "猫砂", productName: "pidan"
  }, makeState())
  assert.ok(summary.includes("猫砂"))
  assert.ok(summary.includes("pidan"))
  assert.ok(summary.includes("默认"))
})
