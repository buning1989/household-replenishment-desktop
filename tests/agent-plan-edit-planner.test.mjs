// 任务 P6: AgentPlan 第二期 planner 句式解析测试
// 运行方式：node --test tests/agent-plan-edit-planner.test.mjs
//
// 403 能力收缩后：编辑类请求不再通过对话生成 plan，buildAgentPlan 一律返回 noPlan，
// 由 orchestrator 的导航处理器返回 answer 引导用户到对应 UI 手动操作。
//
// 覆盖（均应返回 noPlan）：
//   - 「把宠物用品改成猫咪用品」→ renameCategory（已关闭）
//   - 「把猫砂移到猫咪用品」→ moveItem（已关闭）
//   - 「猫砂单位改成袋」→ updateItemUnit（已关闭）
//   - 「猫砂提前 5 天提醒」→ updateItemReminder（已关闭）
//   - 「pidan 豆腐猫砂价格改成 58」→ updatePurchaseOption（已关闭）
//   - 「把猫砂默认商品设成 pidan 豆腐猫砂」→ setDefaultPurchaseOption（已关闭）
//   - 目标不明确时不乱改
//   - pendingPlan 修订（价格/平台/数量）——管理类 plan 不再生成，修订同样返回 noPlan

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

// 403 能力收缩后已关闭的编辑类 action（不应通过对话生成）
const CLOSED_EDIT_TYPES = ["renameCategory", "moveItem", "updateItemUnit", "updateItemReminder", "updatePurchaseOption", "setDefaultPurchaseOption"]

// ---------- renameCategory ----------

test("planner: 「把宠物用品改成猫咪用品」→ noPlan（renameCategory 能力已关闭）", () => {
  const state = makeState()
  const result = buildAgentPlan({ text: "把宠物用品改成猫咪用品", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("planner: 「宠物用品分类改名为猫咪用品」→ noPlan（renameCategory 能力已关闭）", () => {
  const state = makeState()
  const result = buildAgentPlan({ text: "宠物用品分类改名为猫咪用品", state, dateContext })
  assert.equal(result.kind, "noPlan")
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

test("planner: 「把猫砂移到猫咪用品」→ noPlan（moveItem 能力已关闭）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = buildAgentPlan({ text: "把猫砂移到猫咪用品", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("planner: 「猫砂归到猫咪用品分类」→ noPlan（moveItem 能力已关闭）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = buildAgentPlan({ text: "猫砂归到猫咪用品分类", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("planner: 目标物品不存在时不生成 moveItem", () => {
  const state = makeState()
  const result = buildAgentPlan({ text: "把不存在的猫砂移到猫咪用品", state, dateContext })
  if (result.kind === "plan") {
    assert.notEqual(result.plan.actions[0].type, "moveItem")
  }
})

// ---------- updateItemUnit ----------

test("planner: 「猫砂单位改成袋」→ noPlan（updateItemUnit 能力已关闭）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = buildAgentPlan({ text: "猫砂单位改成袋", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("planner: 「洗衣液单位改成瓶」→ noPlan（updateItemUnit 能力已关闭）", () => {
  const state = makeState({ items: [makeItem("i1", "洗衣液", "日常护理")] })
  const result = buildAgentPlan({ text: "洗衣液单位改成瓶", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

// ---------- updateItemReminder ----------

test("planner: 「猫砂提前 5 天提醒」→ noPlan（updateItemReminder 能力已关闭）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const result = buildAgentPlan({ text: "猫砂提前 5 天提醒", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("planner: 「洗衣液快用完前 7 天提醒」→ noPlan（updateItemReminder 能力已关闭）", () => {
  const state = makeState({ items: [makeItem("i1", "洗衣液", "日常护理")] })
  const result = buildAgentPlan({ text: "洗衣液快用完前 7 天提醒", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("planner: 「牙膏提前 3 天提示我」→ noPlan（updateItemReminder 能力已关闭）", () => {
  const state = makeState({ items: [makeItem("i1", "牙膏", "日常护理")] })
  const result = buildAgentPlan({ text: "牙膏提前 3 天提示我", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

// ---------- updatePurchaseOption ----------

test("planner: 「猫砂常购商品平台改成京东」→ 不生成编辑类 action（updatePurchaseOption 能力已关闭）", () => {
  const item = { ...makeItem("i1", "猫砂"), purchaseOptions: [makeOpt("o1", "pidan")] }
  const state = makeState({ items: [item] })
  const result = buildAgentPlan({ text: "猫砂常购商品平台改成京东", state, dateContext })
  // 能力收缩后：不再生成 updatePurchaseOption；含商品名的句式可能回退到录入域 addPurchaseOption，
  // 但不应出现任何已关闭的编辑类 action。
  if (result.kind === "plan") {
    const hasClosedEdit = result.plan.actions.some((a) => CLOSED_EDIT_TYPES.includes(a.type))
    assert.equal(hasClosedEdit, false, "不应生成已关闭的编辑类 action")
  }
})

test("planner: 「pidan 豆腐猫砂价格改成 58」→ noPlan（updatePurchaseOption 能力已关闭）", () => {
  const item = { ...makeItem("i1", "猫砂"), purchaseOptions: [makeOpt("o1", "pidan 豆腐猫砂")] }
  const state = makeState({ items: [item] })
  const result = buildAgentPlan({ text: "pidan 豆腐猫砂价格改成58", state, dateContext })
  assert.equal(result.kind, "noPlan")
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

test("planner: 「把猫砂默认商品设成 pidan 豆腐猫砂」→ noPlan（setDefaultPurchaseOption 能力已关闭）", () => {
  const item = { ...makeItem("i1", "猫砂"), purchaseOptions: [makeOpt("o1", "pidan 豆腐猫砂")] }
  const state = makeState({ items: [item] })
  const result = buildAgentPlan({ text: "把猫砂默认商品设成pidan豆腐猫砂", state, dateContext })
  assert.equal(result.kind, "noPlan")
})

test("planner: 「把 pidan 豆腐猫砂设为猫砂的默认常购商品」→ 不生成编辑类 action（setDefaultPurchaseOption 能力已关闭）", () => {
  const item = { ...makeItem("i1", "猫砂"), purchaseOptions: [makeOpt("o1", "pidan 豆腐猫砂")] }
  const state = makeState({ items: [item] })
  const result = buildAgentPlan({ text: "把pidan豆腐猫砂设为猫砂的默认常购商品", state, dateContext })
  // 能力收缩后：不再生成 setDefaultPurchaseOption；含商品名的句式可能回退到录入域 addPurchaseOption，
  // 但不应出现任何已关闭的编辑类 action。
  if (result.kind === "plan") {
    const hasClosedEdit = result.plan.actions.some((a) => CLOSED_EDIT_TYPES.includes(a.type))
    assert.equal(hasClosedEdit, false, "不应生成已关闭的编辑类 action")
  }
})

// ---------- pendingPlan 修订（管理类 plan 不再生成；含商品名的修订同样不生成编辑类 action） ----------

test("planner: pendingPlan 上下文下「价格改成 68」不生成编辑类 action（管理类修订能力已关闭）", () => {
  const item = { ...makeItem("i1", "猫砂"), purchaseOptions: [makeOpt("o1", "pidan")] }
  const state = makeState({ items: [item] })
  // 管理类 plan 不再生成；含商品名的句式可能回退到录入域 addPurchaseOption
  const pendingPlan = buildAgentPlan({ text: "猫砂常购商品平台改成京东", state, dateContext })
  if (pendingPlan.kind === "plan") {
    const hasClosedEdit = pendingPlan.plan.actions.some((a) => CLOSED_EDIT_TYPES.includes(a.type))
    assert.equal(hasClosedEdit, false, "不应生成已关闭的编辑类 action")
  }
  // 传入上一步的 pendingPlan（可能为 addPurchaseOption 录入域 plan），修订同样不应生成编辑类 action
  const result = buildAgentPlan({ text: "价格改成68", state, dateContext, pendingPlan: pendingPlan.plan })
  if (result.kind === "plan") {
    const hasClosedEdit = result.plan.actions.some((a) => CLOSED_EDIT_TYPES.includes(a.type))
    assert.equal(hasClosedEdit, false, "修订不应生成已关闭的编辑类 action")
  }
})

test("planner: pendingPlan 上下文下「周期改成 30 天」→ noPlan（管理类修订能力已关闭）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  // 管理类 plan 不再生成，第一次调用即返回 noPlan
  const pendingPlan = buildAgentPlan({ text: "猫砂周期改成20天", state, dateContext })
  assert.equal(pendingPlan.kind, "noPlan")
  const result = buildAgentPlan({ text: "周期改成30天", state, dateContext, pendingPlan: pendingPlan.plan })
  assert.equal(result.kind, "noPlan")
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
