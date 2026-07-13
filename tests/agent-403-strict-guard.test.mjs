// 403：管理请求不得进入录入解析器——严格断言测试
// 运行方式：node --test tests/agent-403-strict-guard.test.mjs
//
// 覆盖：
//   1. 管理请求（删除/编辑/预算/周期/提醒/常购商品管理/设默认）严格断言
//   2. pending 草稿修订范围收窄
//   3. 最近写入纠错与撤销
//   4. 周期洞察采纳

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
const { buildLocalDraftFromText } = await import("../src/agent/drafts.ts")
const { buildAgentPlan } = await import("../src/agent/planner.ts")
const { commitAgentDraft, undoLastAgentMutation, correctLastAgentMutation } = await import("../src/agent/executor.ts")
const { buildChatDateContext } = await import("../src/llm/householdChat.ts")
const { isManagementRequest, isCurrentEntryFieldRevision } = await import("../src/agent/turnInterpretation.ts")
const { createAgentPlan } = await import("../src/agent/actions.ts")

const NOW = Date.UTC(2026, 6, 11)
const DATE_CONTEXT = buildChatDateContext(NOW)

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

function makeItem(id, name, category = "宠物用品", extra = {}) {
  return {
    id, name, category, type: "learning", cycleDays: 14, bufferDays: 2,
    lastRestockedAt: 1, anchorEstimated: false,
    purchaseOptions: [], history: [],
    createdAt: 1, updatedAt: 1, unit: "袋",
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

// 严格断言：管理请求不得产生任何写入动作
// 403 修复后管理请求返回 navigate turn（携带 target），不再是 answer turn。
// navigate turn 仍然满足零写入约束：无 plan、无 executableDraft、无 collection。
function assertNoWriteSideEffects(decision, originalState, text) {
  assert.equal(decision.kind, "sync", `「${text}」应返回 sync`)
  assert.ok(
    decision.turn.kind === "answer" || decision.turn.kind === "navigate",
    `「${text}」应返回 answer 或 navigate turn，实际: ${decision.turn.kind}`
  )
  assert.ok(!("plan" in decision.turn), `「${text}」不应有 plan 字段`)
  assert.ok(!("executableDraft" in decision.turn), `「${text}」不应有 executableDraft`)
  assert.ok(!("collection" in decision.turn), `「${text}」不应有 collection`)
}

// =====================================================================
// 测试组 1：管理请求严格断言（7 个测试）
// 管理请求（删除/编辑/预算/周期/提醒/常购商品管理/设默认）不得产生任何写入动作
// =====================================================================

function makeManagementState() {
  return makeState({
    items: [{
      ...makeItem("i1", "猫砂"),
      purchaseOptions: [makeOpt("o1", "pidan 豆腐猫砂")],
      history: [makeEvent("e1", 1)]
    }]
  })
}

test("1a. 「删除猫砂的 pidan 豆腐猫砂常购商品」→ 导航回答，不写 state，不产生 plan", () => {
  const state = makeManagementState()
  const orch = createHouseholdOrchestrator()
  const text = "删除猫砂的 pidan 豆腐猫砂常购商品"
  const before = JSON.stringify(state)

  const d = decide(orch, { text, state, itemViews: viewsOf(state.items) })

  assertNoWriteSideEffects(d, state, text)
  // state 前后完全一致
  assert.equal(JSON.stringify(state), before, `「${text}」后 state 不应改变`)
  // buildLocalDraftFromText 返回 null
  assert.equal(buildLocalDraftFromText(text, state), null, `「${text}」buildLocalDraftFromText 应返回 null`)
  // buildAgentPlan 返回 noPlan
  assert.equal(buildAgentPlan({ text, state, dateContext: DATE_CONTEXT }).kind, "noPlan", `「${text}」buildAgentPlan 应返回 noPlan`)
})

test("1b. 「删除猫砂的 pidan 常购商品」→ 导航回答，不写 state，不产生 plan", () => {
  const state = makeManagementState()
  const orch = createHouseholdOrchestrator()
  const text = "删除猫砂的 pidan 常购商品"
  const before = JSON.stringify(state)

  const d = decide(orch, { text, state, itemViews: viewsOf(state.items) })

  assertNoWriteSideEffects(d, state, text)
  assert.equal(JSON.stringify(state), before, `「${text}」后 state 不应改变`)
  assert.equal(buildLocalDraftFromText(text, state), null, `「${text}」buildLocalDraftFromText 应返回 null`)
  assert.equal(buildAgentPlan({ text, state, dateContext: DATE_CONTEXT }).kind, "noPlan", `「${text}」buildAgentPlan 应返回 noPlan`)
})

test("1c. 「猫砂常购商品平台改成京东」→ 导航回答，不写 state，不产生 plan", () => {
  const state = makeManagementState()
  const orch = createHouseholdOrchestrator()
  const text = "猫砂常购商品平台改成京东"
  const before = JSON.stringify(state)

  const d = decide(orch, { text, state, itemViews: viewsOf(state.items) })

  assertNoWriteSideEffects(d, state, text)
  assert.equal(JSON.stringify(state), before, `「${text}」后 state 不应改变`)
  assert.equal(buildLocalDraftFromText(text, state), null, `「${text}」buildLocalDraftFromText 应返回 null`)
  assert.equal(buildAgentPlan({ text, state, dateContext: DATE_CONTEXT }).kind, "noPlan", `「${text}」buildAgentPlan 应返回 noPlan`)
})

test("1d. 「把 pidan 豆腐猫砂设为猫砂的默认常购商品」→ 导航回答，不写 state，不产生 plan", () => {
  const state = makeManagementState()
  const orch = createHouseholdOrchestrator()
  const text = "把 pidan 豆腐猫砂设为猫砂的默认常购商品"
  const before = JSON.stringify(state)

  const d = decide(orch, { text, state, itemViews: viewsOf(state.items) })

  assertNoWriteSideEffects(d, state, text)
  assert.equal(JSON.stringify(state), before, `「${text}」后 state 不应改变`)
  assert.equal(buildLocalDraftFromText(text, state), null, `「${text}」buildLocalDraftFromText 应返回 null`)
  assert.equal(buildAgentPlan({ text, state, dateContext: DATE_CONTEXT }).kind, "noPlan", `「${text}」buildAgentPlan 应返回 noPlan`)
})

test("1e. 「猫砂周期改成 30 天」→ 导航回答，不写 state，不产生 plan", () => {
  const state = makeManagementState()
  const orch = createHouseholdOrchestrator()
  const text = "猫砂周期改成 30 天"
  const before = JSON.stringify(state)

  const d = decide(orch, { text, state, itemViews: viewsOf(state.items) })

  assertNoWriteSideEffects(d, state, text)
  assert.equal(JSON.stringify(state), before, `「${text}」后 state 不应改变`)
  assert.equal(buildLocalDraftFromText(text, state), null, `「${text}」buildLocalDraftFromText 应返回 null`)
  assert.equal(buildAgentPlan({ text, state, dateContext: DATE_CONTEXT }).kind, "noPlan", `「${text}」buildAgentPlan 应返回 noPlan`)
})

test("1f. 「把月预算设成 800」→ 导航回答，不写 state，不产生 plan", () => {
  const state = makeManagementState()
  const orch = createHouseholdOrchestrator()
  const text = "把月预算设成 800"
  const before = JSON.stringify(state)

  const d = decide(orch, { text, state, itemViews: viewsOf(state.items) })

  assertNoWriteSideEffects(d, state, text)
  assert.equal(JSON.stringify(state), before, `「${text}」后 state 不应改变`)
  assert.equal(buildLocalDraftFromText(text, state), null, `「${text}」buildLocalDraftFromText 应返回 null`)
  assert.equal(buildAgentPlan({ text, state, dateContext: DATE_CONTEXT }).kind, "noPlan", `「${text}」buildAgentPlan 应返回 noPlan`)
})

test("1g. 「猫砂提前 5 天提醒」→ 导航回答，不写 state，不产生 plan", () => {
  const state = makeManagementState()
  const orch = createHouseholdOrchestrator()
  const text = "猫砂提前 5 天提醒"
  const before = JSON.stringify(state)

  const d = decide(orch, { text, state, itemViews: viewsOf(state.items) })

  assertNoWriteSideEffects(d, state, text)
  assert.equal(JSON.stringify(state), before, `「${text}」后 state 不应改变`)
  assert.equal(buildLocalDraftFromText(text, state), null, `「${text}」buildLocalDraftFromText 应返回 null`)
  assert.equal(buildAgentPlan({ text, state, dateContext: DATE_CONTEXT }).kind, "noPlan", `「${text}」buildAgentPlan 应返回 noPlan`)
})

// =====================================================================
// 测试组 2：pending 草稿修订范围收窄（4 个测试）
// 有 pending 草稿时，只允许录入字段修订（数量/金额/平台），
// 周期/提醒等管理类请求应导航（answer turn），不修订草稿
// =====================================================================

test("2a. pending 草稿 +「改成 3 袋」→ 修订 qty=3（proposal turn）", () => {
  const state = makeManagementState()
  const pendingDraft = buildLocalDraftFromText("今天买了 2 袋猫砂，68 元", state)
  assert.ok(pendingDraft, "应成功构造 pendingDraft")
  assert.equal(pendingDraft.qty, 2, "初始 qty 应为 2")

  const orch = createHouseholdOrchestrator()
  const d = decide(orch, {
    text: "改成 3 袋",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })

  assert.equal(d.kind, "sync", "「改成 3 袋」应返回 sync")
  assert.equal(d.turn.kind, "proposal", "「改成 3 袋」应返回 proposal turn")
  assert.ok(d.turn.executableDraft, "应有 executableDraft")
  assert.equal(d.turn.executableDraft.qty, 3, "qty 应修订为 3")
})

test("2b. pending 草稿 +「金额改成 78」→ 修订 price=78（proposal turn）", () => {
  const state = makeManagementState()
  const pendingDraft = buildLocalDraftFromText("今天买了 2 袋猫砂，68 元", state)
  assert.ok(pendingDraft)
  assert.equal(pendingDraft.price, 68, "初始 price 应为 68")

  const orch = createHouseholdOrchestrator()
  const d = decide(orch, {
    text: "金额改成 78",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })

  assert.equal(d.kind, "sync", "「金额改成 78」应返回 sync")
  assert.equal(d.turn.kind, "proposal", "「金额改成 78」应返回 proposal turn")
  assert.ok(d.turn.executableDraft, "应有 executableDraft")
  assert.equal(d.turn.executableDraft.price, 78, "price 应修订为 78")
})

test("2c. pending 草稿 +「周期改成 30 天」→ 应导航（answer turn），不修订草稿", () => {
  const state = makeManagementState()
  const pendingDraft = buildLocalDraftFromText("今天买了 2 袋猫砂，68 元", state)
  assert.ok(pendingDraft)

  const orch = createHouseholdOrchestrator()
  const d = decide(orch, {
    text: "周期改成 30 天",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })

  assert.equal(d.kind, "sync", "「周期改成 30 天」应返回 sync")
  assert.equal(d.turn.kind, "navigate", "「周期改成 30 天」应返回 navigate turn（导航），不修订草稿")
  assert.ok(!("executableDraft" in d.turn), "不应有 executableDraft（未修订草稿）")
  assert.ok(!("plan" in d.turn), "不应有 plan 字段")
})

test("2d. pending 草稿 +「提醒提前 5 天」→ 应导航（answer turn），不修订草稿", () => {
  const state = makeManagementState()
  const pendingDraft = buildLocalDraftFromText("今天买了 2 袋猫砂，68 元", state)
  assert.ok(pendingDraft)

  const orch = createHouseholdOrchestrator()
  const d = decide(orch, {
    text: "提醒提前 5 天",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft
  })

  assert.equal(d.kind, "sync", "「提醒提前 5 天」应返回 sync")
  assert.equal(d.turn.kind, "navigate", "「提醒提前 5 天」应返回 navigate turn（导航），不修订草稿")
  assert.ok(!("executableDraft" in d.turn), "不应有 executableDraft（未修订草稿）")
  assert.ok(!("plan" in d.turn), "不应有 plan 字段")
})

// =====================================================================
// 测试组 3：最近写入纠错与撤销（6 个测试）
// commitAgentDraft 创建补货记录 → correctLastAgentMutation 修改字段 → 验证不新增第二条
// =====================================================================

test("3a. 修改金额：commit 后 correctLastAgentMutation(price, 78) → price 变为 78，history 长度不变", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const draft = buildLocalDraftFromText("今天买了 2 袋猫砂，68 元", state)
  assert.ok(draft, "应成功构造 draft")

  const commitResult = commitAgentDraft(state, draft, NOW)
  const stateAfterCommit = commitResult.state

  // commit 后应有 1 条 history
  assert.equal(stateAfterCommit.items[0].history.length, 1, "commit 后应有 1 条 history")
  assert.ok(stateAfterCommit.lastAgentMutation, "commit 后应记录 lastAgentMutation")

  // 修改金额
  const correctResult = correctLastAgentMutation(stateAfterCommit, "price", 78, NOW)
  assert.equal(correctResult.state.items[0].history.length, 1, "修改金额不应新增 history 记录")
  assert.equal(correctResult.state.items[0].history[0].price, 78, "price 应改为 78")
})

test("3b. 修改数量：correctLastAgentMutation(qty, 5) → qty 变为 5", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const draft = buildLocalDraftFromText("今天买了 2 袋猫砂，68 元", state)
  assert.ok(draft)

  const commitResult = commitAgentDraft(state, draft, NOW)
  const stateAfterCommit = commitResult.state

  // 修改数量
  const correctResult = correctLastAgentMutation(stateAfterCommit, "qty", 5, NOW)
  assert.equal(correctResult.state.items[0].history.length, 1, "修改数量不应新增 history 记录")
  assert.equal(correctResult.state.items[0].history[0].qty, 5, "qty 应改为 5")
})

test("3c. 撤销：undoLastAgentMutation → history 恢复原长度", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const draft = buildLocalDraftFromText("今天买了 2 袋猫砂，68 元", state)
  assert.ok(draft)

  const commitResult = commitAgentDraft(state, draft, NOW)
  const stateAfterCommit = commitResult.state
  assert.equal(stateAfterCommit.items[0].history.length, 1, "commit 后应有 1 条 history")

  // 撤销
  const undoResult = undoLastAgentMutation(stateAfterCommit, NOW)
  assert.equal(undoResult.state.items[0].history.length, 0, "撤销后 history 应恢复为 0")
  assert.equal(undoResult.state.lastAgentMutation.consumed, true, "撤销后 consumed 应为 true")
})

test("3d. 连续撤销：第二次撤销返回「已撤销」消息，state 不变", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const draft = buildLocalDraftFromText("今天买了 2 袋猫砂，68 元", state)
  assert.ok(draft)

  const commitResult = commitAgentDraft(state, draft, NOW)
  const stateAfterCommit = commitResult.state

  // 第一次撤销
  const undoResult1 = undoLastAgentMutation(stateAfterCommit, NOW)
  assert.equal(undoResult1.state.items[0].history.length, 0, "第一次撤销后 history 应为 0")

  // 第二次撤销
  const undoResult2 = undoLastAgentMutation(undoResult1.state, NOW)
  assert.equal(undoResult2.state, undoResult1.state, "第二次撤销不产生新 state")
  assert.match(undoResult2.message, /已经撤销过了/, "第二次撤销应返回「已经撤销过了」")
})

test("3e. 不存在 mutation：state 无 lastAgentMutation 时撤销返回提示", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  // state 无 lastAgentMutation

  const result = undoLastAgentMutation(state, NOW)
  assert.equal(result.state, state, "无 lastAgentMutation 时 state 不变")
  assert.match(result.message, /没有可以撤销/, "应返回「没有可以撤销」提示")
})

test("3f. 新 mutation 替代旧：第一次 commit 后 commit 第二条，撤销只撤销第二条", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const draft = buildLocalDraftFromText("今天买了 2 袋猫砂，68 元", state)
  assert.ok(draft)

  // 第一次 commit
  const commitResult1 = commitAgentDraft(state, draft, NOW)
  const stateAfterCommit1 = commitResult1.state
  assert.equal(stateAfterCommit1.items[0].history.length, 1, "第一次 commit 后 history 应为 1")

  // 第二次 commit（在第一次 commit 的 state 上）
  const commitResult2 = commitAgentDraft(stateAfterCommit1, draft, NOW)
  const stateAfterCommit2 = commitResult2.state
  assert.equal(stateAfterCommit2.items[0].history.length, 2, "第二次 commit 后 history 应为 2")
  assert.ok(stateAfterCommit2.lastAgentMutation, "第二次 commit 后应有 lastAgentMutation")

  // 撤销：只撤销第二条
  const undoResult = undoLastAgentMutation(stateAfterCommit2, NOW)
  assert.equal(undoResult.state.items[0].history.length, 1, "撤销后 history 应恢复为 1（只撤销第二条）")
  assert.equal(undoResult.state.lastAgentMutation.consumed, true, "撤销后 consumed 应为 true")
})

// =====================================================================
// 测试组 4：周期洞察（3 个测试）
// =====================================================================

test("4a. isManagementRequest(\"改吧\") === false（不是管理请求，但也不应触发周期修改）", () => {
  assert.equal(isManagementRequest("改吧"), false, "「改吧」不应判定为管理请求")
})

test("4b. isManagementRequest(\"好的\") === false", () => {
  assert.equal(isManagementRequest("好的"), false, "「好的」不应判定为管理请求")
})

test("4c. buildAgentPlan(\"猫砂周期改成 20 天\") 返回 noPlan", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const result = buildAgentPlan({ text: "猫砂周期改成 20 天", state, dateContext: DATE_CONTEXT })
  assert.equal(result.kind, "noPlan", "「猫砂周期改成 20 天」buildAgentPlan 应返回 noPlan")
})
