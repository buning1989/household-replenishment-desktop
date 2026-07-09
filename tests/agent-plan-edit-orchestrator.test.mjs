// 任务 P6: AgentPlan 第二期 orchestrator 路由测试
// 运行方式：node --test tests/agent-plan-edit-orchestrator.test.mjs
//
// 覆盖：
//   - 编辑类句式生成 planProposal（renameCategory/moveItem/updateItemUnit/updateItemReminder/updatePurchaseOption/setDefaultPurchaseOption）
//   - 查询句式不生成 planProposal
//   - pendingPlan 下确认/取消/修订正常
//   - 旧 Draft 流程不受影响（restock/createItem 仍走 proposal）

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

const { createHouseholdOrchestrator } = await import("../src/agent/householdOrchestrator.ts")
const { buildChatDateContext } = await import("../src/llm/householdChat.ts")
const { createAgentPlan } = await import("../src/agent/actions.ts")

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

// ---------- 编辑类句式生成 planProposal ----------

test("orchestrator: 「把宠物用品改成猫咪用品」生成 planProposal（renameCategory）", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({ text: "把宠物用品改成猫咪用品", state, itemViews: [], dateContext })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planProposal")
  assert.equal(decision.turn.plan.actions[0].type, "renameCategory")
})

test("orchestrator: 「把猫砂移到猫咪用品」生成 planProposal（moveItem）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({ text: "把猫砂移到猫咪用品", state, itemViews: [], dateContext })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planProposal")
  assert.equal(decision.turn.plan.actions[0].type, "moveItem")
})

test("orchestrator: 「猫砂单位改成袋」生成 planProposal（updateItemUnit）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({ text: "猫砂单位改成袋", state, itemViews: [], dateContext })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planProposal")
  assert.equal(decision.turn.plan.actions[0].type, "updateItemUnit")
})

test("orchestrator: 「猫砂提前 5 天提醒」生成 planProposal（updateItemReminder）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({ text: "猫砂提前 5 天提醒", state, itemViews: [], dateContext })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planProposal")
  assert.equal(decision.turn.plan.actions[0].type, "updateItemReminder")
})

test("orchestrator: 「猫砂常购商品平台改成京东」生成 planProposal（updatePurchaseOption）", () => {
  const item = { ...makeItem("i1", "猫砂"), purchaseOptions: [makeOpt("o1", "pidan")] }
  const state = makeState({ items: [item] })
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({ text: "猫砂常购商品平台改成京东", state, itemViews: [], dateContext })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planProposal")
  assert.equal(decision.turn.plan.actions[0].type, "updatePurchaseOption")
})

test("orchestrator: 「把猫砂默认商品设成 pidan 豆腐猫砂」生成 planProposal（setDefaultPurchaseOption）", () => {
  const item = { ...makeItem("i1", "猫砂"), purchaseOptions: [makeOpt("o1", "pidan 豆腐猫砂")] }
  const state = makeState({ items: [item] })
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({ text: "把猫砂默认商品设成pidan豆腐猫砂", state, itemViews: [], dateContext })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planProposal")
  assert.equal(decision.turn.plan.actions[0].type, "setDefaultPurchaseOption")
})

// ---------- 查询句式不生成 planProposal ----------

test("orchestrator: 「猫砂还剩多少」不生成 planProposal（走 needLlm）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({ text: "猫砂还剩多少", state, itemViews: [], dateContext })
  // 查询走 needLlm 或 sync answer；无论哪种都不应是 planProposal
  if (decision.kind === "sync") {
    assert.notEqual(decision.turn.kind, "planProposal", "查询不应生成 planProposal")
  } else {
    assert.equal(decision.kind, "needLlm", "未命中本地解析时应交 LLM")
  }
})

test("orchestrator: 「本月预算怎么样」不生成 planProposal", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({ text: "本月预算怎么样", state, itemViews: [], dateContext })
  if (decision.kind === "sync") {
    assert.notEqual(decision.turn.kind, "planProposal", "查询不应生成 planProposal")
  } else {
    assert.equal(decision.kind, "needLlm", "未命中本地解析时应交 LLM")
  }
})

// ---------- pendingPlan 状态机 ----------

test("orchestrator: pendingPlan + 「确认吧」→ planCommand(planConfirm)", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const pendingPlan = createAgentPlan([{ type: "renameCategory", oldName: "宠物用品", newName: "猫咪用品" }], "test", 1000)
  const decision = orch.decide({ text: "确认吧", state, itemViews: [], pendingPlan, dateContext })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planCommand")
  assert.equal(decision.turn.command.command, "planConfirm")
})

test("orchestrator: pendingPlan + 「算了」→ planCommand(planCancel)", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const pendingPlan = createAgentPlan([{ type: "renameCategory", oldName: "宠物用品", newName: "猫咪用品" }], "test", 1000)
  const decision = orch.decide({ text: "算了", state, itemViews: [], pendingPlan, dateContext })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planCommand")
  assert.equal(decision.turn.command.command, "planCancel")
})

test("orchestrator: pendingPlan + 「价格改成 68」→ 修订生成新 planProposal", () => {
  const item = { ...makeItem("i1", "猫砂"), purchaseOptions: [makeOpt("o1", "pidan")] }
  const state = makeState({ items: [item] })
  const orch = createHouseholdOrchestrator()
  const pendingPlan = createAgentPlan([{
    type: "updatePurchaseOption", itemId: "i1", itemName: "猫砂", optionId: "o1", productName: "pidan",
    patch: { platform: "京东" }
  }], "test", 1000)
  const decision = orch.decide({ text: "价格改成68", state, itemViews: [], pendingPlan, dateContext })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planProposal")
  assert.equal(decision.turn.plan.actions[0].patch.price, 68)
})

test("orchestrator: pendingPlan + 查询句式不影响 pendingPlan", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const pendingPlan = createAgentPlan([{ type: "renameCategory", oldName: "宠物用品", newName: "猫咪用品" }], "test", 1000)
  const decision = orch.decide({ text: "猫砂还剩多少", state, itemViews: [], pendingPlan, dateContext })
  // 查询走 needLlm 或 sync answer，不应返回 planCommand/planProposal（即不打断 pendingPlan）
  if (decision.kind === "sync") {
    assert.notEqual(decision.turn.kind, "planCommand", "查询不应触发 planCommand")
    assert.notEqual(decision.turn.kind, "planProposal", "查询不应生成新 planProposal")
  } else {
    assert.equal(decision.kind, "needLlm", "未命中本地解析时应交 LLM")
  }
})

// ---------- 旧 Draft 流程不受影响 ----------

test("orchestrator: 「帮我加一袋猫砂」仍走旧 AgentDraft 采集态（不生成 planProposal）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({ text: "帮我加一袋猫砂", state, itemViews: [], dateContext })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "collection", "restock 应走采集态 collection")
  assert.equal(decision.turn.collection.draft.kind, "restock")
})

test("orchestrator: 「帮我加一袋猫砂」（无此物品）仍走旧 AgentDraft 采集态", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({ text: "帮我加一袋猫砂", state, itemViews: [], dateContext })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "collection", "createItem 应走采集态 collection")
  assert.equal(decision.turn.collection.draft.kind, "createItemWithRestock")
})
