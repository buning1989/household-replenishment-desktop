// 403：Agent 能力收缩与 P0 录入闭环改造测试
// 运行方式：node --test tests/agent-403-capability-shrinkage.test.mjs
//
// 覆盖：
//   1. 能力收缩：删除/历史编辑/预算请求 → 定位或导航，不写 state，不产生 pendingPlan
//   2. 最近记录纠错：刚提交记录后修正字段/撤销，只改最近一条
//   3. 库存状态报告：「快没了/还剩两包/用完了」→ 进入校准流程，不创建补货记录
//   4. 周期洞察：自然语言「改吧」不得触发周期修改
//
// 验收标准对应任务文档第十节。

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
const { buildAgentPlan } = await import("../src/agent/planner.ts")
const { commitAgentDraft, undoLastAgentMutation, correctLastAgentMutation } = await import("../src/agent/executor.ts")
const { buildChatDateContext } = await import("../src/llm/householdChat.ts")
const { createTrace } = await import("../src/agent/agentDecisionTrace.ts")

const NOW = Date.UTC(2026, 6, 11) // 2026-07-11
const DATE_CONTEXT = buildChatDateContext(NOW)

function makeState(overrides = {}) {
  return {
    version: 3,
    categories: ["宠物用品", "卫生间", "日常护理", "其他"],
    items: [],
    settings: {},
    householdProfile: null,
    updatedAt: 1,
    ...overrides
  }
}

function makeItem(id, name, category = "宠物用品", extra = {}) {
  return {
    id, name, category, type: "learning", cycleDays: 30, bufferDays: 2,
    lastRestockedAt: 1, anchorEstimated: false,
    purchaseOptions: [], history: [], createdAt: 1, updatedAt: 1, unit: "袋",
    learningEnabled: true, source: "manual", confidence: "high", feedbackCount: 0,
    ...extra
  }
}

function makeOpt(id, productName, extra = {}) {
  return { id, productName, unit: "袋", pricingMode: "spec", ...extra }
}

function makeEvent(id, at, extra = {}) {
  return { id, at, qty: 1, price: 30, platform: "京东", review: undefined, purchaseProductName: "pidan", purchaseUnit: "袋", purchaseMeasureAmount: undefined, purchaseMeasureUnit: undefined, ...extra }
}

function viewsOf(items) {
  return items.map((item) => ({ item }))
}

function decide(orch, input) {
  return orch.decide({ dateContext: DATE_CONTEXT, itemViews: [], ...input })
}

function makeTrace(text) {
  return createTrace(text, { collectionItemName: undefined })
}

// =====================================================================
// 1. 能力收缩：删除/历史编辑/预算请求 → 导航，不写 state，不产生 pendingPlan
// =====================================================================

test("1a. 「删除猫砂补货记录」→ navigate turn，不写 state，不产生 pendingPlan", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, { text: "删除猫砂补货记录", state, itemViews: viewsOf(state.items) })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "navigate", "应路由到 navigate（导航），不是 answer 或 planProposal")
  assert.ok(d.turn.message.includes("猫砂"), "回答应定位到猫砂")
  assert.ok(!d.turn.message.includes("已删除"), "不应执行删除")
  assert.ok(d.turn.target, "应携带导航 target")
  assert.equal(d.turn.target.kind, "item", "target 应为 item")
  assert.equal(d.turn.target.itemId, "i1", "target.itemId 应为 i1")
  assert.equal(d.turn.target.section, "history", "target.section 应为 history")
  // 不产生 pendingPlan
  assert.ok(!("plan" in d.turn), "不应产生 pendingPlan")
})

test("1b. 「把上个月的猫粮价格改成268」→ navigate turn，不直接修改", () => {
  const state = makeState({ items: [makeItem("i1", "猫粮", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, { text: "把上个月的猫粮价格改成268", state, itemViews: viewsOf(state.items) })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "navigate", "应路由到 navigate（导航），不是 answer 或 planProposal")
  assert.ok(d.turn.target, "应携带导航 target")
  assert.equal(d.turn.target.kind, "item", "target 应为 item")
  assert.equal(d.turn.target.section, "history", "target.section 应为 history")
  assert.ok(!("plan" in d.turn), "不应产生 pendingPlan")
  // state 不变
  assert.equal(state.items[0].history.length, 0, "state 不应被修改")
})

test("1c. 「设置月预算1000」→ navigate turn，不创建 Plan", () => {
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, { text: "设置月预算1000", state, itemViews: [] })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "navigate", "应路由到 navigate（导航到设置）")
  assert.ok(d.turn.target, "应携带导航 target")
  assert.equal(d.turn.target.kind, "settings", "target 应为 settings")
  assert.equal(d.turn.target.section, "budget", "target.section 应为 budget")
  assert.ok(!("plan" in d.turn), "不应产生 pendingPlan")
})

test("1d. planner 不再为删除请求生成 plan", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const result = buildAgentPlan({ text: "删除猫砂", state, dateContext: DATE_CONTEXT })
  assert.equal(result.kind, "noPlan", "planner 不再为删除请求生成 plan")
})

test("1e. planner 不再为历史编辑请求生成 plan", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const result = buildAgentPlan({ text: "把猫砂周期改成20天", state, dateContext: DATE_CONTEXT })
  assert.equal(result.kind, "noPlan", "planner 不再为历史编辑请求生成 plan")
})

// =====================================================================
// 2. 最近记录纠错：刚提交记录后修正字段/撤销
// =====================================================================

test("2a. 「今天买了2袋猫砂，68元」确认后，「刚才金额是78元」→ 只修改最近一条", () => {
  // 先模拟 commit 一条补货记录
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const draft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 2,
    unit: "袋",
    price: 68,
    platform: "京东",
    purchaseProductName: "猫砂",
    purchaseUnit: "袋"
  }
  const dateContext = buildChatDateContext(NOW)
  const commitResult = commitAgentDraft(state, draft, NOW, dateContext, new Set())
  const stateAfterCommit = commitResult.state

  // 验证 commit 记录了 lastAgentMutation
  assert.ok(stateAfterCommit.lastAgentMutation, "commit 后应记录 lastAgentMutation")
  assert.equal(stateAfterCommit.lastAgentMutation.mutationType, "createRestockRecord")
  assert.equal(stateAfterCommit.lastAgentMutation.itemName, "猫砂")
  assert.equal(stateAfterCommit.lastAgentMutation.consumed, false)

  // 现在模拟「刚才金额是78元」→ orchestrator 应返回 correctLastMutation planCommand
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, {
    text: "刚才金额是78元",
    state: stateAfterCommit,
    itemViews: viewsOf(stateAfterCommit.items)
  })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "planCommand")
  assert.equal(d.turn.command.command, "correctLastMutation")
  assert.equal(d.turn.command.field, "price")
  assert.equal(d.turn.command.value, 78)

  // 模拟 App.tsx 执行 correctLastAgentMutation
  const correctResult = correctLastAgentMutation(stateAfterCommit, "price", 78, NOW)
  assert.equal(correctResult.state.items[0].history.length, 1, "不新增第二条记录")
  assert.equal(correctResult.state.items[0].history[0].price, 78, "金额改为 78")
})

test("2b. 「撤销刚才那条」→ 删除最近一次 Agent 写入，再次撤销不重复执行", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const draft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 2,
    unit: "袋",
    price: 68,
    platform: "京东",
    purchaseProductName: "猫砂",
    purchaseUnit: "袋"
  }
  const dateContext = buildChatDateContext(NOW)
  const commitResult = commitAgentDraft(state, draft, NOW, dateContext, new Set())
  const stateAfterCommit = commitResult.state

  // 验证 commit 后有 1 条 history
  assert.equal(stateAfterCommit.items[0].history.length, 1)

  // 撤销
  const undoResult1 = undoLastAgentMutation(stateAfterCommit, NOW)
  assert.equal(undoResult1.state.items[0].history.length, 0, "撤销后 history 应为空")
  assert.equal(undoResult1.state.lastAgentMutation.consumed, true, "标记 consumed=true")

  // 再次撤销
  const undoResult2 = undoLastAgentMutation(undoResult1.state, NOW)
  assert.equal(undoResult2.state, undoResult1.state, "再次撤销不产生新 state")
  assert.match(undoResult2.message, /已经撤销过了/)
})

test("2c. 「撤销刚才那条」orchestrator 返回 undoLastMutation planCommand", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const draft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 2,
    unit: "袋",
    price: 68,
    platform: "京东",
    purchaseProductName: "猫砂",
    purchaseUnit: "袋"
  }
  const dateContext = buildChatDateContext(NOW)
  const commitResult = commitAgentDraft(state, draft, NOW, dateContext, new Set())
  const stateAfterCommit = commitResult.state

  const orch = createHouseholdOrchestrator()
  const d = decide(orch, {
    text: "撤销刚才那条",
    state: stateAfterCommit,
    itemViews: viewsOf(stateAfterCommit.items)
  })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "planCommand")
  assert.equal(d.turn.command.command, "undoLastMutation")
})

test("2d. 无 lastAgentMutation 时「撤销刚才那条」→ 友好提示，不报错", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  // state 无 lastAgentMutation

  const result = undoLastAgentMutation(state, NOW)
  assert.equal(result.state, state, "state 不变")
  assert.match(result.message, /没有可以撤销/)
})

test("2e. 「刚才平台改成拼多多」→ correctLastMutation(platform=拼多多)", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const draft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 2,
    unit: "袋",
    price: 68,
    platform: "京东",
    purchaseProductName: "猫砂",
    purchaseUnit: "袋"
  }
  const dateContext = buildChatDateContext(NOW)
  const commitResult = commitAgentDraft(state, draft, NOW, dateContext, new Set())
  const stateAfterCommit = commitResult.state

  const orch = createHouseholdOrchestrator()
  const d = decide(orch, {
    text: "刚才平台改成拼多多",
    state: stateAfterCommit,
    itemViews: viewsOf(stateAfterCommit.items)
  })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "planCommand")
  assert.equal(d.turn.command.command, "correctLastMutation")
  assert.equal(d.turn.command.field, "platform")
  assert.equal(d.turn.command.value, "拼多多")

  // 执行修正
  const correctResult = correctLastAgentMutation(stateAfterCommit, "platform", "拼多多", NOW)
  assert.equal(correctResult.state.items[0].history[0].platform, "拼多多")
  assert.equal(correctResult.state.items[0].history.length, 1, "不新增记录")
})

// =====================================================================
// 3. 库存状态报告：「快没了/还剩两包/用完了」→ 进入校准流程
// =====================================================================

test("3a. 「猫砂快没了」→ planProposal 含 calibrateInventory action", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品", { bufferDays: 3 })] })
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, { text: "猫砂快没了", state, itemViews: viewsOf(state.items) })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "planProposal", "应生成 planProposal 让用户确认校准")
  assert.equal(d.turn.plan.actions[0].type, "calibrateInventory")
  assert.equal(d.turn.plan.actions[0].itemName, "猫砂")
  assert.ok(d.turn.plan.actions[0].remainingDays > 0, "快没了 → remainingDays > 0")
})

test("3b. 「洗衣液已经用完了」→ planProposal 含 calibrateInventory，remainingDays=0", () => {
  const state = makeState({ items: [makeItem("i1", "洗衣液", "卫生间")] })
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, { text: "洗衣液已经用完了", state, itemViews: viewsOf(state.items) })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "planProposal")
  assert.equal(d.turn.plan.actions[0].type, "calibrateInventory")
  assert.equal(d.turn.plan.actions[0].remainingDays, 0, "用完了 → remainingDays=0")
})

test("3c. 「纸巾还剩两包」→ planProposal 含 calibrateInventory，有结构化数量", () => {
  const state = makeState({ items: [makeItem("i1", "纸巾", "卫生间", { cycleDays: 30 })] })
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, { text: "纸巾还剩两包", state, itemViews: viewsOf(state.items) })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "planProposal")
  assert.equal(d.turn.plan.actions[0].type, "calibrateInventory")
  assert.equal(d.turn.plan.actions[0].itemName, "纸巾")
})

test("3d. 库存状态报告不创建补货记录", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, { text: "猫砂快没了", state, itemViews: viewsOf(state.items) })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "planProposal")
  // plan 中只有 calibrateInventory，没有 recordRestock
  const hasRestock = d.turn.plan.actions.some((a) => a.type === "recordRestock")
  assert.equal(hasRestock, false, "不应创建补货记录")
  const hasCreateItem = d.turn.plan.actions.some((a) => a.type === "createItem")
  assert.equal(hasCreateItem, false, "不应创建新消耗品")
})

test("3e. 未管理的物品库存状态报告 → 引导先添加物品", () => {
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, { text: "猫砂快没了", state, itemViews: [] })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "answer", "未管理物品 → answer 引导用户先添加")
  assert.ok(!("plan" in d.turn), "不应创建 planProposal")
})

// =====================================================================
// 4. 周期洞察：自然语言「改吧」不得触发周期修改
// =====================================================================

test("4a. 「改吧」不触发周期修改 → 路由到 LLM 或 answer，不产生 updateItem plan", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品", { suggestedCycleDays: 25 })] })
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, { text: "改吧", state, itemViews: viewsOf(state.items) })

  // 「改吧」无 pending 上下文时，needLlm（交 LLM 兜底）或 sync/answer 都是可接受的。
  // 关键断言：不应产生 updateItem plan，且 suggestedCycleDays 不被修改。
  if (d.kind === "sync" && d.turn.kind === "planProposal") {
    const hasUpdateItem = d.turn.plan.actions.some((a) => a.type === "updateItem")
    assert.equal(hasUpdateItem, false, "不应通过自然语言触发 updateItem")
  }
  // suggestedCycleDays 不变
  assert.equal(state.items[0].suggestedCycleDays, 25, "建议值不应被自然语言修改")
})

test("4b. planner 不为「猫砂周期改成20天」生成 updateItem plan", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const result = buildAgentPlan({ text: "猫砂周期改成20天", state, dateContext: DATE_CONTEXT })
  assert.equal(result.kind, "noPlan", "planner 不应为周期修改生成 plan")
})

// =====================================================================
// 5. 回归测试：原有能力不退化
// =====================================================================

test("5a. 「今天买了2袋猫砂」仍走补货流程（collection 或 proposal）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, { text: "今天买了2袋猫砂", state, itemViews: viewsOf(state.items) })

  assert.equal(d.kind, "sync")
  assert.ok(
    d.turn.kind === "collection" || d.turn.kind === "proposal",
    `应走补货流程，实际: ${d.turn.kind}`
  )
})

test("5b. 「帮我加个消耗品叫洗衣液」仍走创建流程", () => {
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()
  const d = decide(orch, { text: "帮我加个消耗品叫洗衣液", state, itemViews: [] })

  assert.equal(d.kind, "sync")
  // 应生成 proposal 或 planProposal（createItem）
  assert.ok(
    d.turn.kind === "proposal" || d.turn.kind === "planProposal",
    `应走创建流程，实际: ${d.turn.kind}`
  )
})
