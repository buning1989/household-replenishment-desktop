// 阶段 4B.3：pending status query + 调试命令误输入保护 + 纯文本 answer fallback 测试
// 运行方式：node --test tests/agent-pending-status-and-debug-guard.test.mjs
//
// 覆盖 7 个场景：
//   1. no pending + 「现在还有什么待确认的吗」→ 本地 answer，不出现「超出家务范围」
//   2. pendingCollection + 「现在还有什么待确认的吗」→ 本地 answer 待补全记录
//   3. pendingDraft + 「现在还有什么待确认的吗」→ 本地 answer 草稿状态
//   4. pendingPlan + 「现在还有什么待确认的吗」→ 本地 answer 计划状态
//   5. pendingBatch + 「现在还有什么待确认的吗」→ 本地 answer 批量状态
//   6. pendingDraft + 「__copyAgentTrace()」→ 本地 answer 调试提示，不写入
//   7. no pending + 「__copyAgentTrace()」→ 本地 answer 调试提示，不进入 LLM
//
// 额外覆盖：
//   8. normalizeLlm 纯文本 answer fallback 防线（parse 失败但内容是合理自然语言）

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
const { buildLocalDraftFromText, parseAgentResponse } = await import("../src/agent/drafts.ts")
const { createDraftCollection } = await import("../src/agent/draftCollection.ts")
const { buildChatDateContext } = await import("../src/llm/householdChat.ts")
const { createTrace } = await import("../src/agent/agentDecisionTrace.ts")
const { createAgentPlan } = await import("../src/agent/actions.ts")

const NOW = Date.UTC(2026, 6, 9) // 2026-07-09
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

function viewsOf(items) {
  return items.map((item) => ({ item }))
}

function decide(orch, input) {
  return orch.decide({ dateContext: DATE_CONTEXT, itemViews: [], ...input })
}

/** 构造「宠物擦脚湿巾」采集态（state 无此物品 → createItemWithRestock，缺 platform/price） */
function buildWipesCollection() {
  const state = makeState({ items: [] })
  const draft = buildLocalDraftFromText("今天买了 5 包宠物擦脚湿巾", state)
  assert.ok(draft)
  return createDraftCollection(draft, [], NOW)
}

/** 构造一个 pendingDraft（restock 类型，字段齐全 → proposal 态） */
function buildPendingDraft() {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const draft = buildLocalDraftFromText("今天买了 3 袋猫砂", state)
  assert.ok(draft)
  // 直接返回 draft 作为 pendingDraft（App.tsx 中 pendingDraft 即 AgentDraft）
  return draft
}

/** 构造一个 pendingBatch（多条 AgentDraft） */
function buildPendingBatch() {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const d1 = buildLocalDraftFromText("今天买了 3 袋猫砂", state)
  const d2 = buildLocalDraftFromText("今天买了 2 瓶洗洁精", state)
  assert.ok(d1 && d2)
  return [d1, d2]
}

/** 构造一个 pendingPlan（含 1 个 createCategory action） */
function buildPendingPlan() {
  return createAgentPlan([
    { type: "createCategory", categoryName: "厨房用品" }
  ])
}

// ---------- 1. no pending + pending status query ----------

test("1. no pending + 「现在还有什么待确认的吗」→ 本地 answer，不出现「超出家务范围」", () => {
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()
  const trace = createTrace("现在还有什么待确认的吗", {})

  const d = decide(orch, {
    text: "现在还有什么待确认的吗",
    state,
    itemViews: viewsOf(state.items),
    trace
  })

  assert.equal(d.kind, "sync", "应返回 sync，不进入 needLlm")
  assert.equal(d.turn.kind, "answer", "应返回 answer")
  assert.ok(!d.turn.message.includes("超出家务范围"), `不应包含「超出家务范围」, 实际: ${d.turn.message}`)
  assert.ok(!d.turn.message.includes("不太属于我能直接处理"), `不应包含「不太属于我能直接处理」, 实际: ${d.turn.message}`)
  // trace：本地高置信，called=false
  assert.ok(trace.llmInterpreter, "llmInterpreter 应存在")
  assert.equal(trace.llmInterpreter.called, false, "本地高置信 called=false")
  // routeDecision 应标记 pendingStatusQuery
  assert.equal(trace.routeDecision?.handler, "pendingStatusQuery")
})

// ---------- 2. pendingCollection + pending status query ----------

test("2. pendingCollection + 「现在还有什么待确认的吗」→ answer 待补全记录，不取消/不确认/不写入", () => {
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildWipesCollection()
  const trace = createTrace("现在还有什么待确认的吗", {
    collectionItemName: "宠物擦脚湿巾",
    collectionStatus: "pending"
  })

  const d = decide(orch, {
    text: "现在还有什么待确认的吗",
    state,
    itemViews: viewsOf(state.items),
    pendingCollection,
    trace
  })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "answer")
  assert.ok(d.turn.message.includes("宠物擦脚湿巾"), `应提及当前物品名, 实际: ${d.turn.message}`)
  assert.ok(!d.turn.message.includes("超出家务范围"))
  // 不应取消/确认/写入
  assert.notEqual(d.turn.kind, "cancelled")
  assert.notEqual(d.turn.kind, "collection")
  assert.notEqual(d.turn.kind, "proposal")
  // trace
  assert.equal(trace.llmInterpreter.called, false)
  assert.equal(trace.routeDecision?.handler, "pendingStatusQuery")
})

// ---------- 3. pendingDraft + pending status query ----------

test("3. pendingDraft + 「现在还有什么待确认的吗」→ answer 草稿状态，不触发 LLM 写入", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingDraft = buildPendingDraft()
  const trace = createTrace("现在还有什么待确认的吗", {})

  const d = decide(orch, {
    text: "现在还有什么待确认的吗",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft,
    trace
  })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "answer")
  assert.ok(d.turn.message.includes("待确认") || d.turn.message.includes("猫砂"), `应提及草稿, 实际: ${d.turn.message}`)
  assert.ok(!d.turn.message.includes("超出家务范围"))
  assert.notEqual(d.turn.kind, "proposal")
  assert.notEqual(d.turn.kind, "cancelled")
  assert.equal(trace.llmInterpreter.called, false)
  assert.equal(trace.routeDecision?.handler, "pendingStatusQuery")
})

// ---------- 4. pendingPlan + pending status query ----------

test("4. pendingPlan + 「现在还有什么待确认的吗」→ answer 计划状态，不执行 plan", () => {
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()
  const pendingPlan = buildPendingPlan()
  const trace = createTrace("现在还有什么待确认的吗", {})

  const d = decide(orch, {
    text: "现在还有什么待确认的吗",
    state,
    itemViews: viewsOf(state.items),
    pendingPlan,
    trace
  })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "answer")
  assert.ok(d.turn.message.includes("待确认") || d.turn.message.includes("操作"), `应提及计划, 实际: ${d.turn.message}`)
  assert.ok(!d.turn.message.includes("超出家务范围"))
  // 不应执行 plan（不返回 planCommand）
  assert.notEqual(d.turn.kind, "planCommand")
  assert.notEqual(d.turn.kind, "planProposal")
  assert.equal(trace.llmInterpreter.called, false)
  assert.equal(trace.routeDecision?.handler, "pendingStatusQuery")
})

// ---------- 5. pendingBatch + pending status query ----------

test("5. pendingBatch + 「现在还有什么待确认的吗」→ answer 批量状态，不确认 batch", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingBatch = buildPendingBatch()
  const trace = createTrace("现在还有什么待确认的吗", {})

  const d = decide(orch, {
    text: "现在还有什么待确认的吗",
    state,
    itemViews: viewsOf(state.items),
    pendingBatch,
    trace
  })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "answer")
  assert.ok(d.turn.message.includes("批量") || d.turn.message.includes("条"), `应提及批量记录, 实际: ${d.turn.message}`)
  assert.ok(!d.turn.message.includes("超出家务范围"))
  // 不应确认 batch（不返回 planCommand batchConfirm）
  assert.notEqual(d.turn.kind, "planCommand")
  assert.equal(trace.llmInterpreter.called, false)
  assert.equal(trace.routeDecision?.handler, "pendingStatusQuery")
})

// ---------- 6. pendingDraft + debug command ----------

test("6. pendingDraft + 「__copyAgentTrace()」→ answer 调试提示，不进入 LLM，不创建 collection，不修改 pendingDraft", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingDraft = buildPendingDraft()
  const trace = createTrace("__copyAgentTrace()", {})

  const d = decide(orch, {
    text: "__copyAgentTrace()",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft,
    trace
  })

  assert.equal(d.kind, "sync", "应返回 sync，不进入 LLM")
  assert.equal(d.turn.kind, "answer")
  assert.ok(d.turn.message.includes("调试命令") || d.turn.message.includes("Console"), `应提示去 Console 执行, 实际: ${d.turn.message}`)
  // 不应创建 collection
  assert.notEqual(d.turn.kind, "collection")
  // 不应确认/取消 draft
  assert.notEqual(d.turn.kind, "proposal")
  assert.notEqual(d.turn.kind, "cancelled")
  // 不应进入 LLM
  assert.equal(trace.llmInterpreter.called, false)
  assert.equal(trace.llmInterpreter.skipReason, "debug_command_guard")
  assert.equal(trace.routeDecision?.handler, "debugCommandGuard")
})

// ---------- 7. no pending + debug command ----------

test("7. no pending + 「__copyAgentTrace()」→ answer 调试提示，不进入 LLM", () => {
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()
  const trace = createTrace("__copyAgentTrace()", {})

  const d = decide(orch, {
    text: "__copyAgentTrace()",
    state,
    itemViews: viewsOf(state.items),
    trace
  })

  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "answer")
  assert.ok(d.turn.message.includes("调试命令") || d.turn.message.includes("Console"))
  assert.equal(trace.llmInterpreter.called, false)
  assert.equal(trace.llmInterpreter.skipReason, "debug_command_guard")
  assert.equal(trace.routeDecision?.handler, "debugCommandGuard")
  // 不应有写入类 finalDecision
  const writeKinds = ["collection", "proposal", "planCommand", "planProposal"]
  if (trace.finalDecision) {
    assert.ok(
      !writeKinds.includes(trace.finalDecision.turnKind ?? ""),
      `无 pending 不应产生写入类 finalDecision, 实际: ${trace.finalDecision.turnKind}`
    )
  }
})

// ---------- 8. 纯文本 answer fallback 防线 ----------

test("8. normalizeLlm 纯文本 answer：parse 失败但内容合理时返回 answer，不替换为「超出家务范围」", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [] })

  // LLM 返回一段合理自然语言（非 JSON），parseAgentResponse 应返回 null
  const freeTextContent = "现在没有待确认的记录，你可以继续告诉我买了什么或快没什么。"
  assert.equal(parseAgentResponse(freeTextContent, state), null, "前置：parseAgentResponse 应返回 null")

  // normalizeLlm 应通过纯文本 fallback 返回 answer
  const turn = orch.normalizeLlmResponse(freeTextContent, {
    text: "现在还有什么待确认的吗",
    state,
    itemViews: [],
    dateContext: DATE_CONTEXT
  })

  assert.ok(turn, "normalizeLlm 应返回 turn（不应 null）")
  assert.equal(turn.kind, "answer")
  assert.equal(turn.message, freeTextContent)
  assert.ok(!turn.message.includes("超出家务范围"), "不应替换为「超出家务范围」")
  assert.ok(!turn.message.includes("不太属于我能直接处理"), "不应替换为边界 fallback 文案")
})

// ---------- 9. 旧错误兜底文案被替换成中性管家式回答 ----------

test("9. normalizeLlm：包含「超出家务范围」时替换成中性管家式回答，不原样展示", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [] })

  const badContent = "这个超出家务范围了，我处理不了。"
  const turn = orch.normalizeLlmResponse(badContent, {
    text: "随便问的",
    state,
    itemViews: [],
    dateContext: DATE_CONTEXT
  })

  // 阶段 4B.4：包含旧错误兜底文案时，不原样展示，替换成中性管家式回答
  // 不返回 null 给 App.tsx 走 unsupported
  assert.ok(turn, "应返回 turn（不应 null）")
  assert.equal(turn.kind, "answer")
  assert.ok(!turn.message.includes("超出家务范围"), "不应原样展示「超出家务范围」")
  assert.ok(!turn.message.includes("不太属于我能直接处理"), "不应包含旧 unsupported 文案")
})

// ---------- 10. JSON-like 无 answer/message → 中性兜底 answer ----------

test("10. normalizeLlm：JSON-like 无 answer/message 时返回中性兜底 answer", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [] })

  // 不合法的 JSON（parse 失败），无 answer/message 字段
  const jsonLikeContent = '{ "kind": "invalid", "data": ... }'
  const turn = orch.normalizeLlmResponse(jsonLikeContent, {
    text: "随便问的",
    state,
    itemViews: [],
    dateContext: DATE_CONTEXT
  })

  // 阶段 4B.4：JSON-like 无 answer/message 时不把原始 JSON 吐给用户
  // 返回中性兜底 answer，不返回 null 走 unsupported
  assert.ok(turn, "应返回 turn（不应 null）")
  assert.equal(turn.kind, "answer")
  assert.ok(!turn.message.includes("{"), "不应把原始 JSON 吐给用户")
  assert.ok(!turn.message.includes("超出家务范围"), "不应包含旧 unsupported 文案")
})
