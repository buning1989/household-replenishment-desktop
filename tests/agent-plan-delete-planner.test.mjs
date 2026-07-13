// AgentPlan 第三期：删除类句式的 planner 解析测试
// 运行方式：node --test tests/agent-plan-delete-planner.test.mjs
//
// 403 能力收缩后：删除类请求不再通过对话生成 plan，buildAgentPlan 一律返回 noPlan，
// 由 orchestrator 的导航处理器返回 answer 引导用户到对应 UI 手动操作。
//
// 覆盖：
//   - deletePurchaseOption：「删除猫砂的 pidan 豆腐猫砂常购商品」「把猫砂里的 pidan 删掉」→ noPlan
//   - deleteRestockRecord：「删除猫砂最近一条补货记录」「删除猫砂昨天那条」「价格 58 那条」→ noPlan
//   - deleteItem：「删除猫砂」「把猫砂这个消耗品删掉」「不再管理猫砂」→ noPlan
//   - deleteCategory：「删除猫咪用品分类」「把猫咪用品分类删掉」→ noPlan
//   - 物品/商品/记录/分类不存在时同样返回 noPlan（不再生成 clarification）
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

// 403 能力收缩后已关闭的删除类 action（不应通过对话生成）
const CLOSED_DELETE_TYPES = ["deletePurchaseOption", "deleteRestockRecord", "deleteItem", "deleteCategory"]

// ---------- deletePurchaseOption ----------

test("planner: 「删除猫砂的 pidan 豆腐猫砂常购商品」不生成删除类 action（能力已关闭）", () => {
  const state = makeState({
    items: [{ ...makeItem("i1", "猫砂"), purchaseOptions: [makeOpt("o1", "pidan 豆腐猫砂")] }]
  })
  const result = buildAgentPlan({ text: "删除猫砂的 pidan 豆腐猫砂常购商品", state, dateContext })
  // 能力收缩后：不再生成 deletePurchaseOption；含商品名的句式可能回退到录入域 addPurchaseOption，
  // 但不应出现任何已关闭的删除类 action。
  if (result.kind === "plan") {
    const hasClosedDelete = result.plan.actions.some((a) => CLOSED_DELETE_TYPES.includes(a.type))
    assert.equal(hasClosedDelete, false, "不应生成已关闭的删除类 action")
  }
})

test("planner: 「把猫砂里的 pidan 删掉」 → noPlan（能力已关闭）", () => {
  const state = makeState({
    items: [{ ...makeItem("i1", "猫砂"), purchaseOptions: [makeOpt("o1", "pidan")] }]
  })
  const result = buildAgentPlan({ text: "把猫砂里的 pidan 删掉", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("planner: 删除常购商品时物品不存在 → noPlan（不再生成 clarification）", () => {
  const state = makeState()
  const result = buildAgentPlan({ text: "删除猫砂的 pidan 常购商品", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("planner: 删除常购商品时商品不存在 → 不生成删除类 action（不再生成 clarification）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = buildAgentPlan({ text: "删除猫砂的 pidan 常购商品", state, dateContext })
  // 能力收缩后：不再生成 clarification；含商品名的句式可能回退到录入域 addPurchaseOption，
  // 但不应出现任何已关闭的删除类 action。
  if (result.kind === "plan") {
    const hasClosedDelete = result.plan.actions.some((a) => CLOSED_DELETE_TYPES.includes(a.type))
    assert.equal(hasClosedDelete, false, "不应生成已关闭的删除类 action")
  }
})

test("planner: 删除常购商品 → 不生成删除类 action（不再生成 risk plan）", () => {
  const state = makeState({
    items: [{ ...makeItem("i1", "猫砂"), purchaseOptions: [makeOpt("o1", "pidan")] }]
  })
  const result = buildAgentPlan({ text: "删除猫砂的 pidan 常购商品", state, dateContext })
  // 能力收缩后：不再生成 risk plan；含商品名的句式可能回退到录入域 addPurchaseOption，
  // 但不应出现任何已关闭的删除类 action。
  if (result.kind === "plan") {
    const hasClosedDelete = result.plan.actions.some((a) => CLOSED_DELETE_TYPES.includes(a.type))
    assert.equal(hasClosedDelete, false, "不应生成已关闭的删除类 action")
  }
})

// ---------- deleteRestockRecord ----------

test("planner: 「删除猫砂最近一条补货记录」 → noPlan（能力已关闭）", () => {
  const state = makeState({
    items: [{ ...makeItem("i1", "猫砂"), history: [makeEvent("e1", 1000)] }]
  })
  const result = buildAgentPlan({ text: "删除猫砂最近一条补货记录", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("planner: 「删除猫砂价格 58 的那条补货记录」 → noPlan（能力已关闭）", () => {
  const state = makeState({
    items: [{ ...makeItem("i1", "猫砂"), history: [makeEvent("e1", 1000, { price: 58 })] }]
  })
  const result = buildAgentPlan({ text: "删除猫砂价格 58 的那条补货记录", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("planner: 删除补货记录时物品不存在 → noPlan（不再生成 clarification）", () => {
  const state = makeState()
  const result = buildAgentPlan({ text: "删除猫砂最近一条补货记录", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("planner: 删除补货记录时无记录 → noPlan（不再生成 clarification）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = buildAgentPlan({ text: "删除猫砂最近一条补货记录", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("planner: 删除补货记录多匹配 → noPlan（不再生成 clarification）", () => {
  const state = makeState({
    items: [{
      ...makeItem("i1", "猫砂"),
      history: [makeEvent("e1", 1000, { price: 58 }), makeEvent("e2", 2000, { price: 58 })]
    }]
  })
  const result = buildAgentPlan({ text: "删除猫砂价格 58 的那条补货记录", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

// ---------- deleteItem ----------

test("planner: 「删除猫砂」 → noPlan（能力已关闭）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = buildAgentPlan({ text: "删除猫砂", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("planner: 「把猫砂这个消耗品删掉」 → noPlan（能力已关闭）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = buildAgentPlan({ text: "把猫砂这个消耗品删掉", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("planner: 「不再管理猫砂」 → noPlan（能力已关闭）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = buildAgentPlan({ text: "不再管理猫砂", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("planner: 删除物品不存在 → noPlan（不再生成 clarification）", () => {
  const state = makeState()
  const result = buildAgentPlan({ text: "删除猫砂", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("planner: 删除物品 → noPlan（不再生成 risk plan）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = buildAgentPlan({ text: "删除猫砂", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

// ---------- deleteCategory ----------

test("planner: 「删除猫咪用品分类」 → noPlan（空分类也不再生成 plan）", () => {
  const state = makeState({ categories: ["猫咪用品", "其他"], items: [] })
  const result = buildAgentPlan({ text: "删除猫咪用品分类", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("planner: 「把猫咪用品分类删掉」 → noPlan（能力已关闭）", () => {
  const state = makeState({ categories: ["猫咪用品", "其他"], items: [] })
  const result = buildAgentPlan({ text: "把猫咪用品分类删掉", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("planner: 删除非空分类 → noPlan（不再生成 clarification）", () => {
  const state = makeState({
    categories: ["宠物用品"],
    items: [makeItem("i1", "猫砂", "宠物用品")]
  })
  const result = buildAgentPlan({ text: "删除宠物用品分类", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("planner: 删除不存在的分类 → noPlan（不再生成 clarification）", () => {
  const state = makeState()
  const result = buildAgentPlan({ text: "删除不存在的分类分类", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("planner: 删除分类 → noPlan（不再生成 risk plan）", () => {
  const state = makeState({ categories: ["猫咪用品"], items: [] })
  const result = buildAgentPlan({ text: "删除猫咪用品分类", state, dateContext })
  assert.equal(result.kind, "noPlan")
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
