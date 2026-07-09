// 阶段 2C 复盘：AgentDecisionTrace 测试
// 运行方式：node --test tests/agent-decision-trace.test.mjs
//
// 覆盖：
//   1. trace 类型基本字段填充（createTrace + commitTrace）
//   2. askTurnInterpreterLlm 填充 trace.llmInterpreter（含 rejectReason 分支）
//   3. decideSync + interpretAndRouteSync 填充 trace 完整链路
//   4. mock client 返回 platform=拼多多 时 final turn 更新 collection.platform
//   5. mock client 返回 malformed JSON 时 trace.rejectReason = json_parse_failed
//   6. mock client 返回 unknown 时 trace.rejectReason = intent_unknown
//   7. mock client 返回 supplement 空 fields 时 trace.rejectReason = supplement_with_empty_fields
//   8. mock client 返回 low confidence 时 trace.rejectReason = confidence_low
//   9. PDD / p'd'd / 拼夕夕 不能在未调用 LLM interpreter 的情况下直接 clarification
//  10. 查询「猫砂还能用多久」不误写入 collection
//  11. 新补货「今天买了 3 袋五常大米」仍然 start_new_collection
//  12. 本地高置信「45块」不调用 LLM，直接 price=45
//  13. 长评价「品质不错，不起灰」不调用 LLM 或即使调用也能保留 review

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
const { createDraftCollection } = await import("../src/agent/draftCollection.ts")
const { buildChatDateContext } = await import("../src/llm/householdChat.ts")
const {
  createTrace,
  commitTrace,
  peekLastTrace,
  resetLastTraceForTest
} = await import("../src/agent/agentDecisionTrace.ts")

const NOW = Date.UTC(2026, 6, 9) // 2026-07-09
const DATE_CONTEXT = buildChatDateContext(NOW)

function makeState(overrides = {}) {
  return {
    version: 3,
    categories: ["宠物用品", "卫生间", "其他"],
    items: [],
    settings: { aiApiKey: "test-key", aiChatModel: "qwen-plus" },
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

function buildWipesCollection() {
  const state = makeState({ items: [] })
  const draft = buildLocalDraftFromText("今天买了 5 包宠物擦脚巾湿巾", state)
  assert.ok(draft)
  return createDraftCollection(draft, [], NOW)
}

function buildCatSandCollection() {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const draft = buildLocalDraftFromText("今天买了 5 袋猫砂", state)
  assert.ok(draft)
  return createDraftCollection(draft, [], NOW)
}

function restockFields(draft) {
  if (draft.kind === "restock") {
    return {
      itemName: draft.itemName,
      platform: draft.platform,
      price: draft.price,
      review: draft.review
    }
  }
  if (draft.kind === "createItemWithRestock") {
    return {
      itemName: draft.item.itemName,
      platform: draft.restock.platform,
      price: draft.restock.price,
      review: draft.restock.review
    }
  }
  return { itemName: undefined, platform: undefined, price: undefined, review: undefined }
}

/** mock client */
function mockClient(response) {
  return {
    async complete(_prompt) {
      if (typeof response === "string") return response
      return JSON.stringify(response)
    }
  }
}

/** 创建带 trace 的 decide input */
function makeDecideInput(text, state, opts = {}) {
  const collection = opts.pendingCollection ?? buildWipesCollection()
  const trace = createTrace(text, {
    collectionItemName: collection
      ? (collection.draft.kind === "restock"
          ? collection.draft.itemName
          : collection.draft.kind === "createItemWithRestock"
            ? collection.draft.item.itemName
            : undefined)
      : undefined,
    collectionStatus: collection ? "pending" : undefined,
    missingFields: collection
      ? [...collection.requiredMissingSlots, ...collection.qualityMissingSlots]
      : undefined
  })
  return {
    input: {
      text,
      state,
      itemViews: opts.itemViews ?? [],
      pendingCollection: collection,
      dateContext: DATE_CONTEXT,
      trace
    },
    trace
  }
}

test.beforeEach(() => {
  resetLastTraceForTest()
})

// ---------- 1. trace 基本字段 ----------

test("1. createTrace 初始化基本字段", () => {
  const trace = createTrace("拼夕夕", {
    collectionItemName: "宠物擦脚巾湿巾",
    collectionStatus: "pending",
    missingFields: ["platform", "price"]
  })
  assert.ok(trace.id.startsWith("trace_"))
  assert.ok(trace.createdAt > 0)
  assert.equal(trace.userText, "拼夕夕")
  assert.equal(trace.pending.collectionItemName, "宠物擦脚巾湿巾")
  assert.equal(trace.pending.missingFields?.length, 2)
})

// ---------- 2. commitTrace 暴露到 window.__agentLastTrace ----------

test("2. commitTrace 暴露到 globalThis（测试环境无 window）", () => {
  const trace = createTrace("test", {})
  commitTrace(trace)
  const last = peekLastTrace()
  assert.equal(last, trace)
})

// ---------- 3. mock client 返回 platform=拼多多 时 final turn 更新 collection.platform ----------

test("3. 拼夕夕 + LLM 返回 platform=拼多多 → trace 完整，final collection.platform=拼多多", async () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const { input, trace } = makeDecideInput("拼夕夕", state)

  const d = orch.decide(input)
  assert.equal(d.kind, "needTurnInterpreterLlm")
  assert.equal(trace.decisionBeforeAppDispatch, "needTurnInterpreterLlm")
  assert.equal(trace.firstFocusDecision?.focus, "route_to_llm")
  assert.equal(trace.collectionFallback?.tried, true)
  assert.equal(trace.collectionFallback?.producedTurn, false)

  const llmDecision = await orch.interpretAndRoute(
    input,
    mockClient({
      intent: "supplement_current_collection",
      fields: { platform: "拼多多" },
      confidence: "high",
      reason: "拼夕夕是拼多多别名"
    })
  )
  assert.equal(llmDecision.kind, "sync")
  assert.ok(trace.llmInterpreter?.called, "LLM 必须被调用")
  assert.equal(trace.llmInterpreter?.rejected, false)
  assert.equal(trace.llmInterpreter?.normalizedInterpretation?.fields.platform, "拼多多")
  assert.equal(trace.secondFocusDecision?.focus, "continue_pending_collection")
  assert.equal(trace.synthesizedInput, "拼多多")
  assert.equal(trace.finalDecision?.kind, "sync")
  assert.ok(
    trace.finalDecision?.turnKind === "collection" || trace.finalDecision?.turnKind === "proposal",
    `期望 collection 或 proposal, 实际: ${trace.finalDecision?.turnKind}`
  )

  // 验证 collection.platform 真正更新
  if (llmDecision.turn.kind === "collection") {
    assert.equal(restockFields(llmDecision.turn.collection.draft).platform, "拼多多")
  } else if (llmDecision.turn.kind === "proposal") {
    assert.equal(restockFields(llmDecision.turn.executableDraft).platform, "拼多多")
  }
})

// ---------- 4. mock client 返回 malformed JSON → rejectReason = json_parse_failed ----------

test("4. LLM 返回非 JSON → trace.rejectReason = json_parse_failed, final 是 clarification", async () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const { input, trace } = makeDecideInput("拼夕夕", state)

  await orch.interpretAndRoute(
    input,
    mockClient("这不是 JSON，我只是想和你聊聊")
  )
  assert.ok(trace.llmInterpreter?.called)
  assert.equal(trace.llmInterpreter?.rejected, true)
  assert.equal(trace.llmInterpreter?.rejectReason, "json_parse_failed")
  assert.equal(trace.finalDecision?.kind, "sync")
  assert.equal(trace.finalDecision?.turnKind, "clarification")
})

// ---------- 5. mock client 返回 unknown → rejectReason = intent_unknown ----------

test("5. LLM 返回 unknown → trace.rejectReason = intent_unknown, final 是 clarification", async () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const { input, trace } = makeDecideInput("asdfasdf", state)

  await orch.interpretAndRoute(
    input,
    mockClient({
      intent: "unknown",
      fields: {},
      confidence: "high",
      reason: "无法理解"
    })
  )
  assert.equal(trace.llmInterpreter?.rejectReason, "intent_unknown")
  assert.equal(trace.finalDecision?.turnKind, "clarification")
})

// ---------- 6. mock client 返回 supplement 空 fields → rejectReason = supplement_with_empty_fields ----------

test("6. LLM 返回 supplement 空 fields → trace.rejectReason = supplement_with_empty_fields", async () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const { input, trace } = makeDecideInput("随便", state)

  await orch.interpretAndRoute(
    input,
    mockClient({
      intent: "supplement_current_collection",
      fields: {},
      confidence: "high",
      reason: "不知道补什么"
    })
  )
  assert.equal(trace.llmInterpreter?.rejectReason, "supplement_with_empty_fields")
  assert.equal(trace.finalDecision?.turnKind, "clarification")
})

// ---------- 7. mock client 返回 low confidence → rejectReason = confidence_low ----------

test("7. LLM 返回 low confidence → trace.rejectReason = confidence_low", async () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const { input, trace } = makeDecideInput("拼夕夕", state)

  await orch.interpretAndRoute(
    input,
    mockClient({
      intent: "supplement_current_collection",
      fields: { platform: "拼多多" },
      confidence: "low",
      reason: "不确定"
    })
  )
  assert.equal(trace.llmInterpreter?.rejectReason, "confidence_low")
  assert.equal(trace.finalDecision?.turnKind, "clarification")
})

// ---------- 8. PDD / p'd'd / 拼夕夕 不能在未调用 LLM 的情况下直接 clarification ----------

test("8. 拼夕夕 / PDD / p'd'd 必须进入 needTurnInterpreterLlm，不能直接 clarification", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()

  for (const text of ["拼夕夕", "PDD", "pdd", "p'd'd", "多多"]) {
    const { input, trace } = makeDecideInput(text, state)
    const d = orch.decide(input)
    assert.equal(
      d.kind,
      "needTurnInterpreterLlm",
      `「${text}」应进入 needTurnInterpreterLlm, 实际: ${d.kind}`
    )
    assert.equal(trace.decisionBeforeAppDispatch, "needTurnInterpreterLlm")
    assert.equal(trace.firstFocusDecision?.focus, "route_to_llm")
    // 关键：本地 collectionFallback 应该尝试过但失败
    assert.equal(trace.collectionFallback?.tried, true)
    assert.equal(trace.collectionFallback?.producedTurn, false)
    // 不应直接走 sync clarification
    assert.notEqual(trace.finalDecision?.turnKind, "clarification", `「${text}」不应直接 clarification`)
  }
})

// ---------- 9. 查询「猫砂还能用多久」不误写入 collection ----------

test("9. 猫砂还能用多久 → 不进入 needTurnInterpreterLlm，不修改 collection", () => {
  const catSand = makeItem("i1", "猫砂", "宠物用品")
  const state = makeState({ items: [catSand] })
  const orch = createHouseholdOrchestrator()
  const collection = buildCatSandCollection()
  const { input, trace } = makeDecideInput("猫砂还能用多久", state, {
    pendingCollection: collection,
    itemViews: viewsOf([catSand])
  })

  const d = orch.decide(input)
  assert.notEqual(d.kind, "needTurnInterpreterLlm", "查询不应进入 LLM interpreter")
  assert.notEqual(trace.firstFocusDecision?.focus, "route_to_llm")
})

// ---------- 10. 新补货「今天买了 3 袋五常大米」仍然 start_new_collection ----------

test("10. 今天买了 3 袋五常大米 → start_new_collection, 不被旧 collection 吞掉", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const { input, trace } = makeDecideInput("今天买了 3 袋五常大米", state)

  const d = orch.decide(input)
  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "collection")
  assert.equal(
    trace.firstFocusDecision?.focus,
    "start_new_collection",
    `应 start_new_collection, 实际: ${trace.firstFocusDecision?.focus}`
  )
  assert.equal(restockFields(d.turn.collection.draft).itemName, "五常大米")
})

// ---------- 11. 本地高置信「45块」不调用 LLM ----------

test("11. 45块 → 本地高置信 price=45, trace.llmInterpreter 不应被填充", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const { input, trace } = makeDecideInput("45块", state)

  const d = orch.decide(input)
  assert.equal(d.kind, "sync", `45块 应本地高置信, 实际: ${d.kind}`)
  assert.notEqual(trace.firstFocusDecision?.focus, "route_to_llm")
  assert.equal(trace.firstFocusDecision?.focus, "continue_pending_collection")
  // llmInterpreter 不应被填充（decideSync 没进入 interpretAndRoute）
  assert.equal(trace.llmInterpreter, undefined)
  assert.equal(trace.decisionBeforeAppDispatch, "sync")
  if (d.kind === "sync") {
    const draft = d.turn.kind === "collection" ? d.turn.collection.draft : d.turn.executableDraft
    assert.equal(restockFields(draft).price, 45)
  }
})

// ---------- 12. 长评价「品质不错，不起灰」不调用 LLM ----------

test("12. 这款猫砂品质不错，不起灰 → 本地处理, review 包含「不起灰」", () => {
  const catSand = makeItem("i1", "猫砂", "宠物用品")
  const state = makeState({ items: [catSand] })
  const orch = createHouseholdOrchestrator()
  const collection = buildCatSandCollection()
  const { input, trace } = makeDecideInput("这款猫砂品质不错，不起灰", state, {
    pendingCollection: collection,
    itemViews: viewsOf([catSand])
  })

  const d = orch.decide(input)
  assert.equal(d.kind, "sync")
  assert.notEqual(trace.firstFocusDecision?.focus, "route_to_llm")
  assert.equal(trace.llmInterpreter, undefined)
  if (d.kind === "sync") {
    const draft = d.turn.kind === "collection" ? d.turn.collection.draft : d.turn.executableDraft
    const f = restockFields(draft)
    assert.ok(f.review, "review 不应为空")
    assert.ok(f.review.includes("不起灰"), `review 应包含「不起灰」, 实际: ${f.review}`)
  }
})

// ---------- 13. LLM client 失败 → rejectReason 包含 client_exception ----------

test("13. LLM client 抛异常 → trace.rejectReason 包含 client_exception", async () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const { input, trace } = makeDecideInput("拼夕夕", state)

  await orch.interpretAndRoute(input, {
    async complete() {
      throw new Error("network error")
    }
  })
  assert.ok(trace.llmInterpreter?.rejected)
  assert.ok(
    trace.llmInterpreter?.rejectReason?.includes("client_exception"),
    `rejectReason 应含 client_exception, 实际: ${trace.llmInterpreter?.rejectReason}`
  )
  assert.equal(trace.finalDecision?.turnKind, "clarification")
})

// ---------- 14. clarification 不包含「超出家务范围」 ----------

test("14. LLM 失败时 clarification 不包含「超出家务范围」", async () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const { input, trace } = makeDecideInput("asdfasdf", state)

  const d = await orch.interpretAndRoute(
    input,
    mockClient("not json at all")
  )
  assert.equal(d.kind, "sync")
  assert.equal(d.turn.kind, "clarification")
  assert.ok(
    !d.turn.message.includes("超出家务范围"),
    `clarification 不应包含「超出家务范围」, 实际: ${d.turn.message}`
  )
  assert.ok(
    trace.finalDecision?.message?.includes("宠物擦脚巾湿巾") || trace.finalDecision?.message?.includes("记录"),
    `clarification 应提及当前记录, 实际: ${trace.finalDecision?.message}`
  )
})

// ---------- 15. 泛化 holdout 测试：P D D / pin duo duo / 拼西西 不能直接「超出家务范围」 ----------

test("15. 泛化输入 P D D / pin duo duo / 拼西西 → 必须进入 needTurnInterpreterLlm 或合理路由", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()

  const holdouts = ["P D D", "pin duo duo", "拼西西", "拼夕", "狗东", "jd", "某东"]
  for (const text of holdouts) {
    const { input, trace } = makeDecideInput(text, state)
    const d = orch.decide(input)
    // 合理结果只有三类：
    //   1. sync（本地高置信补字段，不太可能）
    //   2. needTurnInterpreterLlm（最可能，交 LLM 解释）
    //   3. needLlm（兜底）
    // 禁止直接 clarification「超出家务范围」
    assert.ok(
      d.kind === "sync" || d.kind === "needTurnInterpreterLlm" || d.kind === "needLlm",
      `「${text}」应路由到 sync/needTurnInterpreterLlm/needLlm, 实际: ${d.kind}`
    )
    if (d.kind === "sync") {
      // 如果是 sync，message 不应包含「超出家务范围」
      assert.ok(
        !d.turn.message.includes("超出家务范围"),
        `「${text}」sync turn 不应包含「超出家务范围」, 实际: ${d.turn.message}`
      )
    }
  }
})
