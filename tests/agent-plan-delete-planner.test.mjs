// AgentPlan 第三期：删除类句式的 planner 解析测试
// 运行方式：node --test tests/agent-plan-delete-planner.test.mjs
//
// 覆盖：
//   - deletePurchaseOption：「删除猫砂的 pidan 豆腐猫砂常购商品」「把猫砂里的 pidan 删掉」
//   - deleteRestockRecord：「删除猫砂最近一条补货记录」「删除猫砂昨天那条」「价格 58 那条」
//   - deleteItem：「删除猫砂」「把猫砂这个消耗品删掉」「不再管理猫砂」
//   - deleteCategory：「删除猫咪用品分类」「把猫咪用品分类删掉」
//   - 目标不明确时生成 clarification
//   - 查询句式不生成删除 plan

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

const { buildAgentPlan } = await import("../src/agent/planner.ts")
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

const dateContext = buildChatDateContext(1000)

// ---------- deletePurchaseOption ----------

test("planner: 「删除猫砂的 pidan 豆腐猫砂常购商品」 → deletePurchaseOption plan", () => {
  const state = makeState({
    items: [{ ...makeItem("i1", "猫砂"), purchaseOptions: [makeOpt("o1", "pidan 豆腐猫砂")] }]
  })
  const result = buildAgentPlan({ text: "删除猫砂的 pidan 豆腐猫砂常购商品", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "deletePurchaseOption")
  assert.equal(result.plan.actions[0].itemName, "猫砂")
})

test("planner: 「把猫砂里的 pidan 删掉」 → deletePurchaseOption plan", () => {
  const state = makeState({
    items: [{ ...makeItem("i1", "猫砂"), purchaseOptions: [makeOpt("o1", "pidan")] }]
  })
  const result = buildAgentPlan({ text: "把猫砂里的 pidan 删掉", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "deletePurchaseOption")
})

test("planner: 删除常购商品时物品不存在 → clarification", () => {
  const state = makeState()
  const result = buildAgentPlan({ text: "删除猫砂的 pidan 常购商品", state, dateContext })
  assert.equal(result.kind, "clarification")
  assert.match(result.message, /找不到/)
})

test("planner: 删除常购商品时商品不存在 → clarification", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = buildAgentPlan({ text: "删除猫砂的 pidan 常购商品", state, dateContext })
  assert.equal(result.kind, "clarification")
  assert.match(result.message, /没有/)
})

test("planner: 删除常购商品 risk = high", () => {
  const state = makeState({
    items: [{ ...makeItem("i1", "猫砂"), purchaseOptions: [makeOpt("o1", "pidan")] }]
  })
  const result = buildAgentPlan({ text: "删除猫砂的 pidan 常购商品", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.risk, "high")
  assert.equal(result.plan.requiresSecondConfirm, true)
})

// ---------- deleteRestockRecord ----------

test("planner: 「删除猫砂最近一条补货记录」 → deleteRestockRecord plan", () => {
  const state = makeState({
    items: [{ ...makeItem("i1", "猫砂"), history: [makeEvent("e1", 1000)] }]
  })
  const result = buildAgentPlan({ text: "删除猫砂最近一条补货记录", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "deleteRestockRecord")
})

test("planner: 「删除猫砂价格 58 的那条补货记录」 → deleteRestockRecord plan with price", () => {
  const state = makeState({
    items: [{ ...makeItem("i1", "猫砂"), history: [makeEvent("e1", 1000, { price: 58 })] }]
  })
  const result = buildAgentPlan({ text: "删除猫砂价格 58 的那条补货记录", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "deleteRestockRecord")
  assert.equal(result.plan.actions[0].price, 58)
})

test("planner: 删除补货记录时物品不存在 → clarification", () => {
  const state = makeState()
  const result = buildAgentPlan({ text: "删除猫砂最近一条补货记录", state, dateContext })
  assert.equal(result.kind, "clarification")
  assert.match(result.message, /找不到/)
})

test("planner: 删除补货记录时无记录 → clarification", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = buildAgentPlan({ text: "删除猫砂最近一条补货记录", state, dateContext })
  assert.equal(result.kind, "clarification")
  assert.match(result.message, /没有补货记录/)
})

test("planner: 删除补货记录多匹配 → clarification", () => {
  const state = makeState({
    items: [{
      ...makeItem("i1", "猫砂"),
      history: [makeEvent("e1", 1000, { price: 58 }), makeEvent("e2", 2000, { price: 58 })]
    }]
  })
  const result = buildAgentPlan({ text: "删除猫砂价格 58 的那条补货记录", state, dateContext })
  assert.equal(result.kind, "clarification")
  assert.match(result.message, /2 条/)
})

// ---------- deleteItem ----------

test("planner: 「删除猫砂」 → deleteItem plan", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = buildAgentPlan({ text: "删除猫砂", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "deleteItem")
  assert.equal(result.plan.actions[0].itemName, "猫砂")
})

test("planner: 「把猫砂这个消耗品删掉」 → deleteItem plan", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = buildAgentPlan({ text: "把猫砂这个消耗品删掉", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "deleteItem")
})

test("planner: 「不再管理猫砂」 → deleteItem plan", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = buildAgentPlan({ text: "不再管理猫砂", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "deleteItem")
})

test("planner: 删除物品不存在 → clarification", () => {
  const state = makeState()
  const result = buildAgentPlan({ text: "删除猫砂", state, dateContext })
  assert.equal(result.kind, "clarification")
  assert.match(result.message, /找不到/)
})

test("planner: 删除物品 risk = high + requiresSecondConfirm", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = buildAgentPlan({ text: "删除猫砂", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.risk, "high")
  assert.equal(result.plan.requiresSecondConfirm, true)
})

// ---------- deleteCategory ----------

test("planner: 「删除猫咪用品分类」 → deleteCategory plan（空分类）", () => {
  const state = makeState({ categories: ["猫咪用品", "其他"], items: [] })
  const result = buildAgentPlan({ text: "删除猫咪用品分类", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "deleteCategory")
  assert.equal(result.plan.actions[0].categoryName, "猫咪用品")
})

test("planner: 「把猫咪用品分类删掉」 → deleteCategory plan", () => {
  const state = makeState({ categories: ["猫咪用品", "其他"], items: [] })
  const result = buildAgentPlan({ text: "把猫咪用品分类删掉", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "deleteCategory")
})

test("planner: 删除非空分类 → clarification（不生成可确认 plan）", () => {
  const state = makeState({
    categories: ["宠物用品"],
    items: [makeItem("i1", "猫砂", "宠物用品")]
  })
  const result = buildAgentPlan({ text: "删除宠物用品分类", state, dateContext })
  assert.equal(result.kind, "clarification")
  assert.match(result.message, /还有.*消耗品/)
})

test("planner: 删除不存在的分类 → clarification", () => {
  const state = makeState()
  const result = buildAgentPlan({ text: "删除不存在的分类分类", state, dateContext })
  assert.equal(result.kind, "clarification")
  assert.match(result.message, /不存在/)
})

test("planner: 删除分类 risk = high", () => {
  const state = makeState({ categories: ["猫咪用品"], items: [] })
  const result = buildAgentPlan({ text: "删除猫咪用品分类", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.risk, "high")
})

// ---------- 查询句式不生成删除 plan ----------

test("planner: 查询句式「猫砂还剩多少」不生成删除 plan", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = buildAgentPlan({ text: "猫砂还剩多少", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("planner: 查询句式「预算还剩多少」不生成删除 plan", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = buildAgentPlan({ text: "预算还剩多少", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("planner: 写入句式「买了两袋猫砂」不生成删除 action", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = buildAgentPlan({ text: "买了两袋猫砂", state, dateContext })
  // 「买了两袋猫砂」应回退到旧 AgentDraft 流程生成 restock plan，但不应是删除 action
  if (result.kind === "plan") {
    const hasDelete = result.plan.actions.some((a) =>
      a.type === "deletePurchaseOption" || a.type === "deleteRestockRecord"
      || a.type === "deleteItem" || a.type === "deleteCategory")
    assert.equal(hasDelete, false, "不应生成删除 action")
  }
})
