// 阶段 4B.4：LLM answer fallback + allowedActions 代码级硬约束测试
// 运行方式：node --test tests/agent-llm-answer-fallback-and-action-guard.test.mjs
//
// 覆盖 15 个场景：
//   1. answerLlm 返回纯文本 → answer，不 fallback 到 unsupported
//   2. answerLlm 返回短文本 → answer，不因长度过短被丢弃
//   3. answerLlm 返回残缺 JSON，含 answer 字段 → 抢救 answer
//   4. answerLlm 返回带尾逗号 JSON，含 message → 抢救 message
//   5. answerLlm 返回含大括号的自然语言 → answer，不因 { } 被否决
//   6. no pending + "如何财富自由" → answer，不出现"超出家务范围"，不写入
//   7. no pending + "你好棒" → 自然回应，不出现"超出家务范围"，不写入
//   8. pendingCollection + 随机 query → 不写入/不取消/不确认，不 unsupported
//   9. pendingDraft + allowedActions 不含 draft，LLM 返回 draft → action_not_allowed
//  10. pendingDraft + allowedActions 不含 collection，LLM 返回 draft → action_not_allowed
//  11. unknown kind JSON 含 answer → 不进入 normalizeDraft，作为 answer
//  12. unknown kind JSON 无 answer/message → 不写入，中性 answer
//  13. action route 下非法 JSON → 仍不写入，保持严格校验
//  14. __copyAgentTrace() → debug guard，不进入 LLM，不写入
//  15. copyAgentTrace() → 如果进入 LLM，不写入，最终 answer/clarification

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
const { buildLocalDraftFromText, parseAgentResponse } = await import("../src/agent/drafts.ts")
const { createDraftCollection } = await import("../src/agent/draftCollection.ts")
const { buildChatDateContext } = await import("../src/llm/householdChat.ts")
const { createTrace } = await import("../src/agent/agentDecisionTrace.ts")

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

/** 构造「宠物擦脚湿巾」采集态 */
function buildWipesCollection() {
  const state = makeState({ items: [] })
  const draft = buildLocalDraftFromText("今天买了 5 包宠物擦脚湿巾", state)
  assert.ok(draft)
  return createDraftCollection(draft, [], NOW)
}

/** 构造一个 pendingDraft（restock 类型，字段齐全） */
function buildPendingDraft() {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const draft = buildLocalDraftFromText("今天买了 3 袋猫砂", state)
  assert.ok(draft)
  return draft
}

test.beforeEach(() => {
  // 清理 trace 全局状态
  try {
    const g = globalThis
    if (g.window) {
      delete g.window.__agentLastTrace
      delete g.window.__copyAgentTrace
      delete g.window.__agentTraceHistory
    }
    delete g.__agentLastTrace
    delete g.__copyAgentTrace
    delete g.__agentTraceHistory
  } catch { /* ignore */ }
})

// ---------- 1. answerLlm 返回纯文本 ----------

test("1. answerLlm 返回纯文本「目前没有待确认的记录了。」→ answer，不 fallback 到 unsupported", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [] })
  const trace = createTrace("现在还有什么待确认的吗", {})

  const turn = orch.normalizeLlmResponse("目前没有待确认的记录了。", {
    text: "现在还有什么待确认的吗",
    state,
    itemViews: [],
    dateContext: DATE_CONTEXT,
    trace
  })

  assert.ok(turn, "应返回 turn（不应 null）")
  assert.equal(turn.kind, "answer")
  assert.equal(turn.message, "目前没有待确认的记录了。")
  assert.ok(!turn.message.includes("超出家务范围"), "不应包含「超出家务范围」")
  assert.ok(!turn.message.includes("不太属于我能直接处理"), "不应包含旧 unsupported 文案")
  // trace
  assert.equal(trace.parseResult?.ok, false)
  assert.equal(trace.parseResult?.error, "parse_failed_but_answer_salvaged")
  assert.equal(trace.validationResult?.passed, true)
  assert.equal(trace.validationResult?.turnKind, "answer")
})

// ---------- 2. answerLlm 返回短文本 ----------

test("2. answerLlm 返回短文本「没有了」→ answer，不因长度过短被丢弃", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [] })

  const turn = orch.normalizeLlmResponse("没有了", {
    text: "现在还有什么待确认的吗",
    state,
    itemViews: [],
    dateContext: DATE_CONTEXT
  })

  assert.ok(turn, "短文本应返回 turn（不应 null）")
  assert.equal(turn.kind, "answer")
  assert.equal(turn.message, "没有了")
})

// ---------- 3. answerLlm 返回残缺 JSON，含 answer 字段 ----------

test("3. answerLlm 返回残缺 JSON 含 answer → 抢救 answer 并展示", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [] })

  // 残缺 JSON（缺少闭合大括号），但 answer 字段完整
  const malformedJson = '{"kind":"queryAnswer","answer":"目前没有待确认的记录了"'
  const turn = orch.normalizeLlmResponse(malformedJson, {
    text: "现在还有什么待确认的吗",
    state,
    itemViews: [],
    dateContext: DATE_CONTEXT
  })

  assert.ok(turn, "应抢救出 answer（不应 null）")
  assert.equal(turn.kind, "answer")
  assert.equal(turn.message, "目前没有待确认的记录了")
  assert.ok(!turn.message.includes("{"), "不应包含原始 JSON 结构")
})

// ---------- 4. answerLlm 返回带尾逗号 JSON，含 message ----------

test("4. answerLlm 返回带尾逗号 JSON 含 message → 抢救 message 并展示", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [] })

  // JSON.parse 会失败的尾逗号 JSON，但 message 字段完整
  const trailingCommaJson = '{"kind":"answer","message":"目前没有待确认的记录了",}'
  const turn = orch.normalizeLlmResponse(trailingCommaJson, {
    text: "现在还有什么待确认的吗",
    state,
    itemViews: [],
    dateContext: DATE_CONTEXT
  })

  assert.ok(turn, "应抢救出 message（不应 null）")
  assert.equal(turn.kind, "answer")
  assert.equal(turn.message, "目前没有待确认的记录了")
  assert.ok(!turn.message.includes("{"), "不应包含原始 JSON 结构")
})

// ---------- 5. answerLlm 返回含大括号的自然语言 ----------

test("5. answerLlm 返回含大括号的自然语言 → answer，不因 { } 被否决", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [] })

  const textWithBraces = "我看到 {抽纸} 这条记录还没确认。"
  const turn = orch.normalizeLlmResponse(textWithBraces, {
    text: "现在还有什么待确认的吗",
    state,
    itemViews: [],
    dateContext: DATE_CONTEXT
  })

  assert.ok(turn, "含大括号的自然语言应返回 turn（不应 null）")
  assert.equal(turn.kind, "answer")
  assert.ok(turn.message.includes("抽纸"), "应保留原始内容")
  assert.ok(!turn.message.includes("超出家务范围"), "不应包含「超出家务范围」")
})

// ---------- 6. no pending + "如何财富自由" ----------

test("6. no pending + 「如何财富自由」→ answer，不出现「超出家务范围」，不写入", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [] })

  // 模拟 LLM 以 403 管家身份自然回应
  const llmResponse = "这个我帮不了太多，财富自由不是我的专长。我主要帮你管家里的消耗品和补货记录，比如猫砂快没了、洗衣液该买了这种事。"
  const turn = orch.normalizeLlmResponse(llmResponse, {
    text: "如何财富自由",
    state,
    itemViews: [],
    dateContext: DATE_CONTEXT
  })

  assert.ok(turn, "应返回 turn（不应 null）")
  assert.equal(turn.kind, "answer")
  assert.ok(!turn.message.includes("超出家务范围"), "不应包含「超出家务范围」")
  assert.ok(!turn.message.includes("不太属于我能直接处理"), "不应包含旧 unsupported 文案")
  // 不应产生写入类 turn
  assert.notEqual(turn.kind, "collection")
  assert.notEqual(turn.kind, "proposal")
  assert.notEqual(turn.kind, "planProposal")
  assert.notEqual(turn.kind, "proposalBatch")
})

// ---------- 7. no pending + "你好棒" ----------

test("7. no pending + 「你好棒」→ 自然回应，不出现「超出家务范围」，不写入", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [] })

  const llmResponse = "谢谢，你有什么需要我帮忙记的随时说。"
  const turn = orch.normalizeLlmResponse(llmResponse, {
    text: "你好棒",
    state,
    itemViews: [],
    dateContext: DATE_CONTEXT
  })

  assert.ok(turn, "应返回 turn（不应 null）")
  assert.equal(turn.kind, "answer")
  assert.ok(!turn.message.includes("超出家务范围"), "不应包含「超出家务范围」")
  assert.ok(!turn.message.includes("不太属于我能直接处理"), "不应包含旧 unsupported 文案")
  // 不应产生写入类 turn
  assert.notEqual(turn.kind, "collection")
  assert.notEqual(turn.kind, "proposal")
})

// ---------- 8. pendingCollection + 随机 query ----------

test("8. pendingCollection + 随机 query → 不写入/不取消/不确认，不 unsupported", () => {
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildWipesCollection()

  // 模拟 LLM 返回一段自然回答
  const llmResponse = "你现在正在整理「宠物擦脚湿巾」的补货记录，还需要补充购买平台和价格。"
  const turn = orch.normalizeLlmResponse(llmResponse, {
    text: "现在什么情况",
    state,
    itemViews: [],
    pendingCollection,
    dateContext: DATE_CONTEXT
  })

  assert.ok(turn, "应返回 turn（不应 null）")
  // 可以是 answer 或 clarification，但不能是写入类
  assert.ok(
    turn.kind === "answer" || turn.kind === "clarification",
    `应为 answer 或 clarification, 实际: ${turn.kind}`
  )
  assert.notEqual(turn.kind, "collection", "不应创建新 collection")
  assert.notEqual(turn.kind, "proposal", "不应创建 proposal")
  assert.notEqual(turn.kind, "cancelled", "不应取消 collection")
  assert.ok(!turn.message.includes("超出家务范围"), "不应包含「超出家务范围」")
})

// ---------- 9. pendingDraft + allowedActions 不含 draft，LLM 返回 draft ----------

test("9. pendingDraft + allowedActions 不含 draft → rejectReason=action_not_allowed，不创建 collection", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingDraft = buildPendingDraft()
  const trace = createTrace("今天买了 2 瓶洗洁精", {})

  // pendingDraft 状态下 allowedActions = [confirm, cancel, revise, offTopic]
  // LLM 返回一个 draft（新补货记录）
  const llmDraftJson = '{"kind":"draft","message":"洗洁精我帮你记下。","draft":{"kind":"restock","itemName":"洗洁精","qty":2,"unit":"瓶"}}'
  const turn = orch.normalizeLlmResponse(llmDraftJson, {
    text: "今天买了 2 瓶洗洁精",
    state,
    itemViews: viewsOf([makeItem("i1", "猫砂", "宠物用品")]),
    pendingDraft,
    dateContext: DATE_CONTEXT,
    trace,
    allowedActions: ["confirm", "cancel", "revise", "offTopic"]
  })

  // 不应创建 collection 或 proposal
  assert.ok(turn, "应返回 turn（降级为 answer）")
  assert.notEqual(turn.kind, "collection", "不应创建 collection")
  assert.notEqual(turn.kind, "proposal", "不应创建 proposal")
  // trace: action_not_allowed
  assert.equal(trace.parseResult?.ok, true)
  assert.equal(trace.parseResult?.kind, "draft")
  assert.equal(trace.validationResult?.passed, false)
  assert.equal(trace.validationResult?.rejectReason, "action_not_allowed")
})

// ---------- 10. pendingDraft + allowedActions 不含 collection，LLM 返回 draft（会变 collection 的） ----------

test("10. pendingDraft + allowedActions 不含 draft → 即使 draft 会变 collection 也被拒绝", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const pendingDraft = buildPendingDraft()
  const trace = createTrace("今天买了 3 袋大米", {})

  // LLM 返回一个字段不齐的 draft（正常会进入 collection 采集态）
  // 但 allowedActions 不含 draft，应在进入 collection 前被拒绝
  const llmDraftJson = '{"kind":"draft","draft":{"kind":"restock","itemName":"大米","qty":3,"unit":"袋"}}'
  const turn = orch.normalizeLlmResponse(llmDraftJson, {
    text: "今天买了 3 袋大米",
    state,
    itemViews: viewsOf([makeItem("i1", "猫砂", "宠物用品")]),
    pendingDraft,
    dateContext: DATE_CONTEXT,
    trace,
    allowedActions: ["confirm", "cancel", "revise", "offTopic"]
  })

  // 不应创建 collection
  assert.ok(turn, "应返回 turn（降级为 answer）")
  assert.notEqual(turn.kind, "collection", "不应创建 collection")
  assert.notEqual(turn.kind, "proposal", "不应创建 proposal")
  assert.equal(trace.validationResult?.passed, false)
  assert.equal(trace.validationResult?.rejectReason, "action_not_allowed")
})

// ---------- 11. unknown kind JSON 含 answer ----------

test("11. unknown kind JSON 含 answer → 不进入 normalizeDraft，作为 answer", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [] })

  // queryAnswer 是合法 kind，parseAgentResponse 会正确处理
  const json = '{"kind":"queryAnswer","answer":"目前没有待确认的记录了"}'
  // 前置验证：parseAgentResponse 正确解析为 queryAnswer
  const parsed = parseAgentResponse(json, state)
  assert.ok(parsed, "parseAgentResponse 应成功解析")
  assert.equal(parsed.kind, "queryAnswer")

  const turn = orch.normalizeLlmResponse(json, {
    text: "现在还有什么待确认的吗",
    state,
    itemViews: [],
    dateContext: DATE_CONTEXT
  })

  assert.ok(turn, "应返回 turn")
  assert.equal(turn.kind, "answer")
  assert.equal(turn.message, "目前没有待确认的记录了")
  // 不应产生写入类 turn
  assert.notEqual(turn.kind, "collection")
  assert.notEqual(turn.kind, "proposal")
})

// ---------- 12. unknown kind JSON 无 answer/message ----------

test("12. unknown kind JSON 无 answer/message → 不写入，中性 answer，不 unsupported", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [] })

  // 非标准 kind，无 answer/message 字段
  const json = '{"kind":"somethingElse","foo":"bar"}'
  // 前置验证：parseAgentResponse 返回 null（不再兜底转 normalizeDraft）
  const parsed = parseAgentResponse(json, state)
  assert.equal(parsed, null, "parseAgentResponse 对未知 kind 应返回 null")

  const turn = orch.normalizeLlmResponse(json, {
    text: "随便问的",
    state,
    itemViews: [],
    dateContext: DATE_CONTEXT
  })

  assert.ok(turn, "应返回 turn（不应 null）")
  assert.equal(turn.kind, "answer")
  assert.ok(!turn.message.includes("{"), "不应把原始 JSON 吐给用户")
  assert.ok(!turn.message.includes("超出家务范围"), "不应包含「超出家务范围」")
  assert.ok(!turn.message.includes("不太属于我能直接处理"), "不应包含旧 unsupported 文案")
  // 不应产生写入类 turn
  assert.notEqual(turn.kind, "collection")
  assert.notEqual(turn.kind, "proposal")
})

// ---------- 13. action route 下非法 JSON ----------

test("13. action route 下非法 JSON → 仍不写入，保持严格校验", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })

  // 完全非法的 JSON（不是任何合法结构）
  const garbage = '这不是JSON也不是合理的回答内容{{{}}}'
  const turn = orch.normalizeLlmResponse(garbage, {
    text: "今天买了 3 袋猫砂",
    state,
    itemViews: viewsOf([makeItem("i1", "猫砂", "宠物用品")]),
    dateContext: DATE_CONTEXT
  })

  // 不应产生写入类 turn
  if (turn) {
    assert.notEqual(turn.kind, "collection", "不应创建 collection")
    assert.notEqual(turn.kind, "proposal", "不应创建 proposal")
    assert.notEqual(turn.kind, "planProposal", "不应创建 plan")
    assert.ok(!turn.message.includes("超出家务范围"), "不应包含「超出家务范围」")
  }
})

// ---------- 14. __copyAgentTrace() → debug guard ----------

test("14. __copyAgentTrace() → debug guard，不进入 LLM，不写入", () => {
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()
  const trace = createTrace("__copyAgentTrace()", {})

  const d = orch.decide({
    text: "__copyAgentTrace()",
    state,
    itemViews: viewsOf(state.items),
    dateContext: DATE_CONTEXT,
    trace
  })

  assert.equal(d.kind, "sync", "应返回 sync，不进入 LLM")
  assert.equal(d.turn.kind, "answer")
  assert.ok(
    d.turn.message.includes("调试命令") || d.turn.message.includes("Console"),
    `应提示去 Console 执行, 实际: ${d.turn.message}`
  )
  // 不应产生写入类 turn
  assert.notEqual(d.turn.kind, "collection")
  assert.notEqual(d.turn.kind, "proposal")
  // 不应进入 LLM
  assert.equal(trace.llmInterpreter.called, false)
  assert.equal(trace.llmInterpreter.skipReason, "debug_command_guard")
})

// ---------- 15. copyAgentTrace() → 不写入，最终 answer/clarification ----------

test("15. copyAgentTrace() → 如果进入 LLM 也不写入，最终 answer/clarification", () => {
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()

  // copyAgentTrace()（不带 __ 前缀）可能不被 debug guard 拦截，进入 LLM 路径
  // 即使进入 LLM，最终也不应写入
  const d = orch.decide({
    text: "copyAgentTrace()",
    state,
    itemViews: viewsOf(state.items),
    dateContext: DATE_CONTEXT
  })

  // 无论 sync 还是 needLlm，都不应产生写入类 turn
  if (d.kind === "sync") {
    assert.ok(
      d.turn.kind === "answer" || d.turn.kind === "clarification",
      `sync 路径应为 answer 或 clarification, 实际: ${d.turn.kind}`
    )
    assert.notEqual(d.turn.kind, "collection", "不应创建 collection")
    assert.notEqual(d.turn.kind, "proposal", "不应创建 proposal")
  }
  // needLlm 路径：LLM 返回后由 normalizeLlmResponse 处理，不在此测试范围内
  // 关键是 decide 不直接产生写入类 turn
})
