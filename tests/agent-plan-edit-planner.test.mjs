// 任务 P6: AgentPlan 第二期 planner 句式解析测试
// 运行方式：node --test tests/agent-plan-edit-planner.test.mjs
//
// 覆盖：
//   - 「把宠物用品改成猫咪用品」→ renameCategory
//   - 「把猫砂移到猫咪用品」→ moveItem
//   - 「猫砂单位改成袋」→ updateItemUnit
//   - 「猫砂提前 5 天提醒」→ updateItemReminder
//   - 「pidan 豆腐猫砂价格改成 58」→ updatePurchaseOption
//   - 「把猫砂默认商品设成 pidan 豆腐猫砂」→ setDefaultPurchaseOption
//   - 目标不明确时不乱改
//   - pendingPlan 修订（价格/平台/数量）

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
    purchaseOptions: [], history: [], createdAt: 1, updatedAt: 1, unit: "袋"
  }
}

function makeOpt(id, productName) {
  return { id, productName, unit: "袋", pricingMode: "spec" }
}

const dateContext = buildChatDateContext(Date.UTC(2026, 6, 7))

// ---------- renameCategory ----------

test("planner: 「把宠物用品改成猫咪用品」→ renameCategory", () => {
  const state = makeState()
  const result = buildAgentPlan({ text: "把宠物用品改成猫咪用品", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions.length, 1)
  assert.equal(result.plan.actions[0].type, "renameCategory")
  assert.equal(result.plan.actions[0].oldName, "宠物用品")
  assert.equal(result.plan.actions[0].newName, "猫咪用品")
})

test("planner: 「宠物用品分类改名为猫咪用品」→ renameCategory", () => {
  const state = makeState()
  const result = buildAgentPlan({ text: "宠物用品分类改名为猫咪用品", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "renameCategory")
})

test("planner: 原分类不存在时不生成 renameCategory", () => {
  const state = makeState()
  const result = buildAgentPlan({ text: "把不存在的分类改成新名字", state, dateContext })
  // 不应该匹配 renameCategory（oldName 不在 categories 里）
  if (result.kind === "plan") {
    assert.notEqual(result.plan.actions[0].type, "renameCategory")
  }
})

// ---------- moveItem ----------

test("planner: 「把猫砂移到猫咪用品」→ moveItem", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = buildAgentPlan({ text: "把猫砂移到猫咪用品", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions.length, 1)
  assert.equal(result.plan.actions[0].type, "moveItem")
  assert.equal(result.plan.actions[0].itemId, "i1")
  assert.equal(result.plan.actions[0].targetCategory, "猫咪用品")
})

test("planner: 「猫砂归到猫咪用品分类」→ moveItem", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = buildAgentPlan({ text: "猫砂归到猫咪用品分类", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "moveItem")
  assert.equal(result.plan.actions[0].targetCategory, "猫咪用品")
})

test("planner: 目标物品不存在时不生成 moveItem", () => {
  const state = makeState()
  const result = buildAgentPlan({ text: "把不存在的猫砂移到猫咪用品", state, dateContext })
  if (result.kind === "plan") {
    assert.notEqual(result.plan.actions[0].type, "moveItem")
  }
})

// ---------- updateItemUnit ----------

test("planner: 「猫砂单位改成袋」→ updateItemUnit", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = buildAgentPlan({ text: "猫砂单位改成袋", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions.length, 1)
  assert.equal(result.plan.actions[0].type, "updateItemUnit")
  assert.equal(result.plan.actions[0].itemId, "i1")
  assert.equal(result.plan.actions[0].unit, "袋")
})

test("planner: 「洗衣液单位改成瓶」→ updateItemUnit", () => {
  const state = makeState({ items: [makeItem("i1", "洗衣液", "日常护理")] })
  const result = buildAgentPlan({ text: "洗衣液单位改成瓶", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "updateItemUnit")
  assert.equal(result.plan.actions[0].unit, "瓶")
})

// ---------- updateItemReminder ----------

test("planner: 「猫砂提前 5 天提醒」→ updateItemReminder", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = buildAgentPlan({ text: "猫砂提前 5 天提醒", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions.length, 1)
  assert.equal(result.plan.actions[0].type, "updateItemReminder")
  assert.equal(result.plan.actions[0].itemId, "i1")
  assert.equal(result.plan.actions[0].bufferDays, 5)
})

test("planner: 「洗衣液快用完前 7 天提醒」→ updateItemReminder", () => {
  const state = makeState({ items: [makeItem("i1", "洗衣液", "日常护理")] })
  const result = buildAgentPlan({ text: "洗衣液快用完前 7 天提醒", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "updateItemReminder")
  assert.equal(result.plan.actions[0].bufferDays, 7)
})

test("planner: 「牙膏提前 3 天提示我」→ updateItemReminder", () => {
  const state = makeState({ items: [makeItem("i1", "牙膏", "日常护理")] })
  const result = buildAgentPlan({ text: "牙膏提前 3 天提示我", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "updateItemReminder")
  assert.equal(result.plan.actions[0].bufferDays, 3)
})

// ---------- updatePurchaseOption ----------

test("planner: 「猫砂常购商品平台改成京东」→ updatePurchaseOption", () => {
  const item = { ...makeItem("i1", "猫砂"), purchaseOptions: [makeOpt("o1", "pidan")] }
  const state = makeState({ items: [item] })
  const result = buildAgentPlan({ text: "猫砂常购商品平台改成京东", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions.length, 1)
  assert.equal(result.plan.actions[0].type, "updatePurchaseOption")
  assert.equal(result.plan.actions[0].patch.platform, "京东")
})

test("planner: 「pidan 豆腐猫砂价格改成 58」→ updatePurchaseOption", () => {
  const item = { ...makeItem("i1", "猫砂"), purchaseOptions: [makeOpt("o1", "pidan 豆腐猫砂")] }
  const state = makeState({ items: [item] })
  const result = buildAgentPlan({ text: "pidan 豆腐猫砂价格改成58", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "updatePurchaseOption")
  assert.equal(result.plan.actions[0].patch.price, 58)
})

test("planner: 常购商品不存在时不生成 updatePurchaseOption", () => {
  const item = { ...makeItem("i1", "猫砂"), purchaseOptions: [makeOpt("o1", "其他品牌")] }
  const state = makeState({ items: [item] })
  const result = buildAgentPlan({ text: "不存在的商品价格改成58", state, dateContext })
  if (result.kind === "plan") {
    assert.notEqual(result.plan.actions[0].type, "updatePurchaseOption")
  }
})

// ---------- setDefaultPurchaseOption ----------

test("planner: 「把猫砂默认商品设成 pidan 豆腐猫砂」→ setDefaultPurchaseOption", () => {
  const item = { ...makeItem("i1", "猫砂"), purchaseOptions: [makeOpt("o1", "pidan 豆腐猫砂")] }
  const state = makeState({ items: [item] })
  const result = buildAgentPlan({ text: "把猫砂默认商品设成pidan豆腐猫砂", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions.length, 1)
  assert.equal(result.plan.actions[0].type, "setDefaultPurchaseOption")
  assert.equal(result.plan.actions[0].itemId, "i1")
  assert.ok(result.plan.actions[0].productName.includes("pidan"))
})

test("planner: 「把 pidan 豆腐猫砂设为猫砂的默认常购商品」→ setDefaultPurchaseOption", () => {
  const item = { ...makeItem("i1", "猫砂"), purchaseOptions: [makeOpt("o1", "pidan 豆腐猫砂")] }
  const state = makeState({ items: [item] })
  const result = buildAgentPlan({ text: "把pidan豆腐猫砂设为猫砂的默认常购商品", state, dateContext })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "setDefaultPurchaseOption")
})

// ---------- pendingPlan 修订 ----------

test("planner: pendingPlan 上下文下「价格改成 68」修订 updatePurchaseOption", () => {
  const item = { ...makeItem("i1", "猫砂"), purchaseOptions: [makeOpt("o1", "pidan")] }
  const state = makeState({ items: [item] })
  const pendingPlan = buildAgentPlan({ text: "猫砂常购商品平台改成京东", state, dateContext })
  assert.equal(pendingPlan.kind, "plan")
  const result = buildAgentPlan({ text: "价格改成68", state, dateContext, pendingPlan: pendingPlan.plan })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].type, "updatePurchaseOption")
  assert.equal(result.plan.actions[0].patch.price, 68)
})

test("planner: pendingPlan 上下文下「周期改成 30 天」修订 updateItem", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const pendingPlan = buildAgentPlan({ text: "猫砂周期改成20天", state, dateContext })
  assert.equal(pendingPlan.kind, "plan")
  const result = buildAgentPlan({ text: "周期改成30天", state, dateContext, pendingPlan: pendingPlan.plan })
  assert.equal(result.kind, "plan")
  assert.equal(result.plan.actions[0].cycleDays, 30)
})

// ---------- 不乱改 ----------

test("planner: 查询句式不生成编辑类 plan", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = buildAgentPlan({ text: "猫砂还剩多少", state, dateContext })
  // 查询不应生成 plan（即使生成了也不应是编辑类）
  if (result.kind === "plan") {
    const editTypes = ["renameCategory", "moveItem", "updateItemUnit", "updateItemReminder", "updatePurchaseOption", "setDefaultPurchaseOption"]
    assert.ok(!editTypes.includes(result.plan.actions[0].type), "查询句式不应生成编辑类 action")
  }
})
