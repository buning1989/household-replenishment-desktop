// 阶段 4B.7：data-grounded item record query 测试
// 运行方式：node --test tests/agent-grounded-query-answer.test.mjs
//
// 覆盖任务规范第六节 8 个场景：
//   1. 狗粮最新补货 2026/7/9, 1袋, 淘宝, ¥300 → 问"狗粮最近一次补货记录" → 回答真实数据
//   2. 多条记录(7/5 2袋¥110, 7/9 1袋¥300) → 问"狗粮最近一次补货记录" → 取 7/9
//   3. 问"狗粮上次多少钱" → 回答 ¥300
//   4. 问"狗粮在哪买的" → 回答 淘宝
//   5. 问"狗粮买了几袋" → 回答 1袋
//   6. relevantFacts 注入测试：用户显式问狗粮时，contextPack 必须包含狗粮最新记录
//   7. answerLlm 冲突测试：mock 返回 2026-07-05/2袋 → 拒绝，返回 grounded answer
//   8. 未找到物品 → 不编造，回答没有查到

import { test } from "node:test"
import assert from "node:assert/strict"
import { registerHooks } from "node:module"

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier)
    } catch (error) {
      if ((specifier.startsWith(".") || specifier.startsWith("..")) && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context)
      }
      throw error
    }
  }
})

const { createHouseholdOrchestrator } = await import("../src/agent/householdOrchestrator.ts")
const { buildAgentContextPack } = await import("../src/agent/conversationContext.ts")
const { buildChatDateContext } = await import("../src/llm/householdChat.ts")
const { createTrace } = await import("../src/agent/agentDecisionTrace.ts")

const NOW = Date.UTC(2026, 6, 9) // 2026-07-09
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

function makeItem(id, name, category, extra = {}) {
  return {
    id,
    name,
    category,
    type: "learning",
    cycleDays: 14,
    bufferDays: 2,
    lastRestockedAt: 1,
    anchorEstimated: false,
    purchaseOptions: [],
    history: [],
    createdAt: 1,
    updatedAt: 1,
    unit: "袋",
    ...extra
  }
}

function makeHistoryEntry(id, dateStr, qty, unit, price, platform) {
  const [year, month, day] = dateStr.split("/").map(Number)
  return {
    id,
    at: Date.UTC(year, month - 1, day),
    qty,
    purchaseUnit: unit,
    price,
    platform
  }
}

function viewsOf(items) {
  return items.map((item) => ({
    item,
    computed: {
      status: "normal",
      displayStatus: "normal",
      statusLabel: "充足",
      dueAt: Date.now() + 30 * 86400000,
      depletionAt: Date.now() + 30 * 86400000,
      daysUntilDue: 30,
      remainingText: "约 30 天",
      remainingQty: null
    }
  }))
}

function decide(orch, input) {
  return orch.decide({ dateContext: DATE_CONTEXT, itemViews: [], ...input })
}

// 构造狗粮物品：最新补货 2026/7/9, 1袋, 淘宝, ¥300
function makeDogFoodState() {
  const item = makeItem("i1", "狗粮", "宠物用品", {
    unit: "袋",
    history: [
      makeHistoryEntry("h1", "2026/7/9", 1, "袋", 300, "淘宝")
    ],
    lastRestockedAt: Date.UTC(2026, 6, 9)
  })
  return makeState({ items: [item] })
}

// 构造狗粮物品：多条记录
function makeDogFoodMultiRecordState() {
  const item = makeItem("i1", "狗粮", "宠物用品", {
    unit: "袋",
    history: [
      makeHistoryEntry("h1", "2026/7/5", 2, "袋", 110, "拼多多"),
      makeHistoryEntry("h2", "2026/7/9", 1, "袋", 300, "淘宝")
    ],
    lastRestockedAt: Date.UTC(2026, 6, 9)
  })
  return makeState({ items: [item] })
}

// ---------- 1. 狗粮最新补货 2026/7/9, 1袋, 淘宝, ¥300 ----------

test("1. 狗粮最近一次补货记录 → 回答 2026/7/9、1袋、淘宝、¥300，不得出现 2026/7/5、2袋", () => {
  const state = makeDogFoodState()
  const orch = createHouseholdOrchestrator()

  const d = decide(orch, {
    text: "狗粮最近一次补货记录",
    state,
    itemViews: viewsOf(state.items)
  })

  assert.equal(d.kind, "sync", `期望 sync, 实际: ${d.kind}`)
  assert.equal(d.turn.kind, "answer", `期望 answer, 实际: ${d.turn.kind}`)

  const msg = d.turn.message
  // 必须包含真实数据
  assert.ok(msg.includes("2026/7/9"), `回答应包含 2026/7/9, 实际: ${msg}`)
  assert.ok(msg.includes("1袋") || msg.includes("1 袋"), `回答应包含 1袋, 实际: ${msg}`)
  assert.ok(msg.includes("淘宝"), `回答应包含 淘宝, 实际: ${msg}`)
  assert.ok(msg.includes("300"), `回答应包含 ¥300, 实际: ${msg}`)
  // 不得出现幻觉数据
  assert.ok(!msg.includes("2026/7/5"), `回答不得包含 2026/7/5, 实际: ${msg}`)
  assert.ok(!msg.includes("2袋") && !msg.includes("2 袋"), `回答不得包含 2袋, 实际: ${msg}`)
  assert.ok(!msg.includes("110"), `回答不得包含 ¥110, 实际: ${msg}`)
})

// ---------- 2. 多条记录 → 取最新 ----------

test("2. 多条记录(7/5 2袋¥110, 7/9 1袋¥300) → 取 2026/7/9", () => {
  const state = makeDogFoodMultiRecordState()
  const orch = createHouseholdOrchestrator()

  const d = decide(orch, {
    text: "狗粮最近一次补货记录",
    state,
    itemViews: viewsOf(state.items)
  })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "answer")

  const msg = d.turn.message
  assert.ok(msg.includes("2026/7/9"), `应取最新 2026/7/9, 实际: ${msg}`)
  assert.ok(msg.includes("1袋") || msg.includes("1 袋"), `应取 1袋, 实际: ${msg}`)
  assert.ok(msg.includes("300"), `应取 ¥300, 实际: ${msg}`)
  assert.ok(msg.includes("淘宝"), `应取 淘宝, 实际: ${msg}`)
  // 不得取旧记录
  assert.ok(!msg.includes("2026/7/5"), `不得取旧记录 2026/7/5, 实际: ${msg}`)
  assert.ok(!msg.includes("2袋") && !msg.includes("2 袋"), `不得取旧记录 2袋, 实际: ${msg}`)
})

// ---------- 3. 问"狗粮上次多少钱" → 回答 ¥300 ----------

test("3. 狗粮上次多少钱 → 回答 ¥300", () => {
  const state = makeDogFoodState()
  const orch = createHouseholdOrchestrator()

  const d = decide(orch, {
    text: "狗粮上次多少钱",
    state,
    itemViews: viewsOf(state.items)
  })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "answer")

  const msg = d.turn.message
  assert.ok(msg.includes("300"), `应回答 ¥300, 实际: ${msg}`)
  assert.ok(!msg.includes("110"), `不得回答 ¥110, 实际: ${msg}`)
})

// ---------- 4. 问"狗粮在哪买的" → 回答 淘宝 ----------

test("4. 狗粮在哪买的 → 回答 淘宝", () => {
  const state = makeDogFoodState()
  const orch = createHouseholdOrchestrator()

  const d = decide(orch, {
    text: "狗粮在哪买的",
    state,
    itemViews: viewsOf(state.items)
  })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "answer")

  const msg = d.turn.message
  assert.ok(msg.includes("淘宝"), `应回答 淘宝, 实际: ${msg}`)
  assert.ok(!msg.includes("拼多多"), `不得回答 拼多多, 实际: ${msg}`)
})

// ---------- 5. 问"狗粮买了几袋" → 回答 1袋 ----------

test("5. 狗粮买了几袋 → 回答 1袋", () => {
  const state = makeDogFoodState()
  const orch = createHouseholdOrchestrator()

  const d = decide(orch, {
    text: "狗粮买了几袋",
    state,
    itemViews: viewsOf(state.items)
  })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "answer")

  const msg = d.turn.message
  assert.ok(msg.includes("1袋") || msg.includes("1 袋"), `应回答 1袋, 实际: ${msg}`)
  assert.ok(!msg.includes("2袋") && !msg.includes("2 袋"), `不得回答 2袋, 实际: ${msg}`)
})

// ---------- 6. relevantFacts 注入测试 ----------

test("6. 用户显式问狗粮时，contextPack / relevantFacts 必须包含狗粮最新记录", () => {
  const state = makeDogFoodState()

  const contextPack = buildAgentContextPack({
    messages: [],
    currentUserText: "狗粮最近一次补货记录",
    state,
    itemViews: viewsOf(state.items),
    dateContext: DATE_CONTEXT
  })

  const facts = contextPack.relevantAppFacts
  // 必须包含狗粮
  assert.ok(facts.includes("狗粮"), `relevantFacts 应包含狗粮, 实际:\n${facts}`)
  // 必须包含最新记录的某些字段
  // serializeItemForContext 用 formatDate(evt.at) → "7/9"
  assert.ok(
    facts.includes("7/9") || facts.includes("2026/7/9"),
    `relevantFacts 应包含日期 7/9 或 2026/7/9, 实际:\n${facts}`
  )
  // 必须包含数量或价格
  assert.ok(
    facts.includes("1袋") || facts.includes("300") || facts.includes("¥300"),
    `relevantFacts 应包含 1袋 或 ¥300, 实际:\n${facts}`
  )
  // 必须包含平台
  assert.ok(facts.includes("淘宝"), `relevantFacts 应包含淘宝, 实际:\n${facts}`)
})

// ---------- 7. answerLlm 冲突测试 ----------

test("7. mock answerLlm 返回 2026-07-05/2袋 → 拒绝 LLM 答案，返回 grounded answer", () => {
  const state = makeDogFoodState()
  const orch = createHouseholdOrchestrator()
  const trace = createTrace("狗粮最近一次补货记录", {})

  // mock LLM 返回幻觉数据
  const llmContent = JSON.stringify({
    kind: "queryAnswer",
    answer: "狗粮最近一次补货是 2026-07-05，2袋，淘宝买的，¥300。"
  })

  const turn = orch.normalizeLlmResponse(llmContent, {
    text: "狗粮最近一次补货记录",
    state,
    itemViews: viewsOf(state.items),
    dateContext: DATE_CONTEXT,
    trace
  })

  assert.ok(turn, "应返回 turn（不应 null）")
  assert.equal(turn.kind, "answer")

  const msg = turn.message
  // 必须包含真实数据（grounded answer）
  assert.ok(msg.includes("2026/7/9"), `应返回 grounded answer 2026/7/9, 实际: ${msg}`)
  assert.ok(msg.includes("1袋") || msg.includes("1 袋"), `应返回 grounded answer 1袋, 实际: ${msg}`)
  // 不得包含 LLM 幻觉数据
  assert.ok(!msg.includes("2026-07-05") && !msg.includes("2026/7/5"), `不得包含 LLM 幻觉日期, 实际: ${msg}`)
  assert.ok(!msg.includes("2袋") && !msg.includes("2 袋"), `不得包含 LLM 幻觉数量, 实际: ${msg}`)

  // trace 必须记录 rejectReason=answer_not_grounded
  assert.ok(trace.validationResult, "trace 应有 validationResult")
  assert.equal(
    trace.validationResult.rejectReason,
    "answer_not_grounded",
    `rejectReason 应为 answer_not_grounded, 实际: ${trace.validationResult?.rejectReason}`
  )
  // finalDecision.turnKind 应为 grounded_query_answer
  assert.ok(trace.finalDecision, "trace 应有 finalDecision")
  assert.equal(
    trace.finalDecision.turnKind,
    "grounded_query_answer",
    `turnKind 应为 grounded_query_answer, 实际: ${trace.finalDecision?.turnKind}`
  )
})

// ---------- 8. 未找到物品 ----------

test("8. 不存在物品最近一次补货记录 → 不编造，回答没有查到", () => {
  // state 有狗粮，但用户问的是不存在的物品
  const state = makeDogFoodState()
  const orch = createHouseholdOrchestrator()

  const d = decide(orch, {
    text: "猫粮最近一次补货记录",
    state,
    itemViews: viewsOf(state.items)
  })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "answer")

  const msg = d.turn.message
  // 不编造记录
  assert.ok(!msg.includes("2026/7/9"), `不得编造日期, 实际: ${msg}`)
  assert.ok(!msg.includes("1袋") && !msg.includes("1 袋"), `不得编造数量, 实际: ${msg}`)
  assert.ok(!msg.includes("300"), `不得编造金额, 实际: ${msg}`)
  assert.ok(!msg.includes("淘宝"), `不得编造平台, 实际: ${msg}`)
  // 引导用户确认
  assert.ok(
    msg.includes("没有查到") || msg.includes("还没") || msg.includes("确认") || msg.includes("管理"),
    `应引导用户确认物品名, 实际: ${msg}`
  )
})
