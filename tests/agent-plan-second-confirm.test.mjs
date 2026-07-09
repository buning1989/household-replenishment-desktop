// AgentPlan 第三期：二次确认状态机测试
// 运行方式：node --test tests/agent-plan-second-confirm.test.mjs
//
// 覆盖：
//   - 删除类句式生成 high risk planProposal
//   - high risk plan 下普通「确认」不执行，返回 planAwaitingSecondConfirm command
//   - high risk plan 下「确认删除」才执行，返回 planSecondConfirm command
//   - 「取消」取消，返回 planCancel command
//   - 查询不打断 pending delete plan
//   - 旧 Draft 流程不受影响
//   - isSecondConfirmMatch 函数测试

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
const { isSecondConfirmMatch } = await import("../src/agent/intent.ts")

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

const dateContext = buildChatDateContext(Date.UTC(2026, 6, 7))

// ---------- isSecondConfirmMatch 测试 ----------

test("isSecondConfirmMatch: 「确认删除」返回 true", () => {
  assert.equal(isSecondConfirmMatch("确认删除"), true)
  assert.equal(isSecondConfirmMatch("确定删除"), true)
  assert.equal(isSecondConfirmMatch("我确认删除"), true)
  assert.equal(isSecondConfirmMatch("确认删掉"), true)
  assert.equal(isSecondConfirmMatch("删除吧"), true)
})

test("isSecondConfirmMatch: 普通确认返回 false", () => {
  assert.equal(isSecondConfirmMatch("确认"), false)
  assert.equal(isSecondConfirmMatch("好的"), false)
  assert.equal(isSecondConfirmMatch("可以"), false)
  assert.equal(isSecondConfirmMatch("嗯"), false)
})

test("isSecondConfirmMatch: 空字符串返回 false", () => {
  assert.equal(isSecondConfirmMatch(""), false)
  assert.equal(isSecondConfirmMatch("   "), false)
})

// ---------- 删除类句式生成 high risk planProposal ----------

test("orchestrator: 「删除猫砂」生成 high risk planProposal", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({ text: "删除猫砂", state, itemViews: [], dateContext })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planProposal")
  assert.equal(decision.turn.plan.risk, "high")
  assert.equal(decision.turn.plan.requiresSecondConfirm, true)
})

// ---------- high risk plan 下普通「确认」不执行 ----------

test("orchestrator: high risk plan 下「确认」返回 planAwaitingSecondConfirm command", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const pendingPlan = createAgentPlan([{ type: "deleteItem", itemName: "猫砂" }], "删除猫砂")
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({ text: "确认", state, itemViews: [], dateContext, pendingPlan })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planCommand")
  assert.equal(decision.turn.command.command, "planAwaitingSecondConfirm")
})

test("orchestrator: high risk plan 下「好的」返回 planAwaitingSecondConfirm command", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const pendingPlan = createAgentPlan([{ type: "deleteItem", itemName: "猫砂" }], "删除猫砂")
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({ text: "好的", state, itemViews: [], dateContext, pendingPlan })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planCommand")
  assert.equal(decision.turn.command.command, "planAwaitingSecondConfirm")
})

// ---------- high risk plan 下「确认删除」才执行 ----------

test("orchestrator: high risk plan 下「确认删除」返回 planSecondConfirm command", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const pendingPlan = createAgentPlan([{ type: "deleteItem", itemName: "猫砂" }], "删除猫砂")
  pendingPlan.status = "awaitingSecondConfirm"
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({ text: "确认删除", state, itemViews: [], dateContext, pendingPlan })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planCommand")
  assert.equal(decision.turn.command.command, "planSecondConfirm")
})

test("orchestrator: high risk plan 下「确定删除」返回 planSecondConfirm command", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const pendingPlan = createAgentPlan([{ type: "deleteItem", itemName: "猫砂" }], "删除猫砂")
  pendingPlan.status = "awaitingSecondConfirm"
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({ text: "确定删除", state, itemViews: [], dateContext, pendingPlan })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planCommand")
  assert.equal(decision.turn.command.command, "planSecondConfirm")
})

// ---------- 「取消」取消 ----------

test("orchestrator: high risk plan 下「取消」返回 planCancel command", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const pendingPlan = createAgentPlan([{ type: "deleteItem", itemName: "猫砂" }], "删除猫砂")
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({ text: "取消", state, itemViews: [], dateContext, pendingPlan })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planCommand")
  assert.equal(decision.turn.command.command, "planCancel")
})

test("orchestrator: high risk plan awaitingSecondConfirm 下「取消」返回 planCancel command", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const pendingPlan = createAgentPlan([{ type: "deleteItem", itemName: "猫砂" }], "删除猫砂")
  pendingPlan.status = "awaitingSecondConfirm"
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({ text: "取消", state, itemViews: [], dateContext, pendingPlan })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planCommand")
  assert.equal(decision.turn.command.command, "planCancel")
})

// ---------- 查询不打断 pending delete plan ----------

test("orchestrator: high risk plan 下查询不打断，pendingPlan 状态不变", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const pendingPlan = createAgentPlan([{ type: "deleteItem", itemName: "猫砂" }], "删除猫砂")
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({ text: "猫砂还剩多少", state, itemViews: [], dateContext, pendingPlan })
  // 查询走 needLlm（需要 LLM 回答），但不应返回 planCommand 改变 pendingPlan 状态
  assert.equal(decision.kind, "needLlm")
})

test("orchestrator: high risk plan awaitingSecondConfirm 下查询不打断，pendingPlan 状态不变", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const pendingPlan = createAgentPlan([{ type: "deleteItem", itemName: "猫砂" }], "删除猫砂")
  pendingPlan.status = "awaitingSecondConfirm"
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({ text: "预算还剩多少", state, itemViews: [], dateContext, pendingPlan })
  // 查询走 needLlm，但不应返回 planCommand 改变 pendingPlan 状态
  assert.equal(decision.kind, "needLlm")
})

// ---------- 旧 Draft 流程不受影响 ----------

test("orchestrator: 「买了两袋猫砂」仍走旧 Draft 流程（collection 采集态）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({ text: "买了两袋猫砂", state, itemViews: [], dateContext })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "collection")
})

// ---------- pending 状态下直接输入「确认删除」可直接执行（跳过 awaitingSecondConfirm）----------
// 这是上一轮修复的核心语义：二次确认句式包含明确删除语义，不需要再走 awaitingSecondConfirm

test("orchestrator: high risk plan pending 状态下「确认删除」直接返回 planSecondConfirm command", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const pendingPlan = createAgentPlan([{ type: "deleteItem", itemName: "猫砂" }], "删除猫砂")
  // pendingPlan.status 保持默认 "pending"，不先进入 awaitingSecondConfirm
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({ text: "确认删除", state, itemViews: [], dateContext, pendingPlan })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planCommand")
  assert.equal(decision.turn.command.command, "planSecondConfirm")
})

test("orchestrator: high risk plan pending 状态下「删除吧」直接返回 planSecondConfirm command", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const pendingPlan = createAgentPlan([{ type: "deleteItem", itemName: "猫砂" }], "删除猫砂")
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({ text: "删除吧", state, itemViews: [], dateContext, pendingPlan })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planCommand")
  assert.equal(decision.turn.command.command, "planSecondConfirm")
})

// ---------- awaitingSecondConfirm 状态下普通「确认」提示需要明确说「确认删除」 ----------

test("orchestrator: awaitingSecondConfirm 下普通「确认」返回 answer（不执行，不取消）", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const pendingPlan = createAgentPlan([{ type: "deleteItem", itemName: "猫砂" }], "删除猫砂")
  pendingPlan.status = "awaitingSecondConfirm"
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({ text: "确认", state, itemViews: [], dateContext, pendingPlan })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "answer")
  // 不应返回 planCommand，避免改变 pendingPlan 状态
  assert.ok(!decision.turn.command, "不应有 command 字段")
})

// ---------- awaitingSecondConfirm 状态下新操作不走修订，返回 null 让外层处理 ----------
// 修复 3：避免「帮我加一袋猫砂」因「袋」在 REVISE_KEYWORDS 中被误判为修订

test("orchestrator: awaitingSecondConfirm 下「帮我加一袋猫砂」不走修订，走新操作", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const pendingPlan = createAgentPlan([{ type: "deleteItem", itemName: "猫砂" }], "删除猫砂")
  pendingPlan.status = "awaitingSecondConfirm"
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({ text: "帮我加一袋猫砂", state, itemViews: [], dateContext, pendingPlan })
  // 不应返回 planCommand（不改变 pendingPlan 状态），也不应返回 answer（pending reminder）
  // 应该走新操作流程：collection（restock 采集态）或 needLlm
  assert.ok(
    decision.turn.kind === "collection" || decision.turn.kind === "proposal" || decision.kind === "needLlm",
    `期望 collection/proposal 或 needLlm，实际 ${decision.turn?.kind} / ${decision.kind}`
  )
  assert.ok(!decision.turn.command, "不应有 command 字段")
})

// ---------- 普通 plan 不受二次确认影响 ----------

test("orchestrator: 普通 plan（非 high risk）下「确认」直接执行，返回 planConfirm command", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂")] })
  const pendingPlan = createAgentPlan([{ type: "recordRestock", itemName: "猫砂", qty: 1, unit: "袋" }], "买了猫砂")
  // 手动设置 risk 为 low（模拟普通 plan）
  pendingPlan.risk = "low"
  pendingPlan.requiresSecondConfirm = false
  const orch = createHouseholdOrchestrator()
  const decision = orch.decide({ text: "确认", state, itemViews: [], dateContext, pendingPlan })
  assert.equal(decision.kind, "sync")
  assert.equal(decision.turn.kind, "planCommand")
  assert.equal(decision.turn.command.command, "planConfirm")
})
