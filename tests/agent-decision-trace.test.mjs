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
const { createAgentPlan } = await import("../src/agent/actions.ts")
const { buildChatDateContext } = await import("../src/llm/householdChat.ts")
const {
  createTrace,
  commitTrace,
  peekLastTrace,
  peekTraceHistory,
  resetLastTraceForTest,
  buildTraceCurrentState,
  setRouteDecision,
  setFinalDecision,
  formatTraceForCopy
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

// ============================================================
// 阶段 9 字段 trace 扩展测试（buildTraceCurrentState / setRouteDecision /
// setFinalDecision / formatTraceForCopy / commitTrace history / normalizeLlm 填充）
// ============================================================

// ---------- 16. buildTraceCurrentState：无 pending 时返回空对象 ----------

test("16. buildTraceCurrentState 无 pending 返回空对象（无任何 has* 字段）", () => {
  const cs = buildTraceCurrentState({})
  assert.equal(cs.hasPendingPlan, undefined)
  assert.equal(cs.hasPendingDraft, undefined)
  assert.equal(cs.hasPendingCollection, undefined)
  assert.equal(cs.hasPendingBatch, undefined)
})

// ---------- 17. buildTraceCurrentState：pendingPlan 摘要 ----------

test("17. buildTraceCurrentState 含 pendingPlan → 摘要包含动作数与动作类型", () => {
  const plan = createAgentPlan(
    [
      { type: "createCategory", name: "宠物用品" },
      { type: "deleteItem", itemId: "i1", itemName: "猫砂" }
    ],
    "帮我建个宠物用品分类顺便删掉猫砂",
    NOW
  )
  const cs = buildTraceCurrentState({ pendingPlan: plan })
  assert.equal(cs.hasPendingPlan, true)
  assert.equal(cs.pendingPlanStatus, "pending")
  assert.equal(cs.pendingPlanRisk, "high") // deleteItem → high
  assert.ok(cs.pendingPlanSummary?.includes("createCategory(宠物用品)"), `summary: ${cs.pendingPlanSummary}`)
  assert.ok(cs.pendingPlanSummary?.includes("deleteItem(猫砂)"), `summary: ${cs.pendingPlanSummary}`)
  assert.ok(cs.pendingPlanSummary?.startsWith("2 actions:"), `summary: ${cs.pendingPlanSummary}`)
})

// ---------- 18. buildTraceCurrentState：pendingDraft 摘要 ----------

test("18. buildTraceCurrentState 含 pendingDraft(restock) → 摘要含物品名/qty/platform/price", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const draft = buildLocalDraftFromText("今天在拼多多买了 5 袋猫砂 花了 45 块", state)
  assert.ok(draft, "应解析出 draft")
  const cs = buildTraceCurrentState({ pendingDraft: draft })
  assert.equal(cs.hasPendingDraft, true)
  assert.ok(cs.pendingDraftSummary?.includes("restock("), `summary: ${cs.pendingDraftSummary}`)
  assert.ok(cs.pendingDraftSummary?.includes("猫砂"), `summary: ${cs.pendingDraftSummary}`)
  assert.ok(cs.pendingDraftSummary?.includes("拼多多"), `summary: ${cs.pendingDraftSummary}`)
})

// ---------- 19. buildTraceCurrentState：pendingCollection 摘要 ----------

test("19. buildTraceCurrentState 含 pendingCollection → 摘要含物品名与缺失字段", () => {
  const collection = buildWipesCollection()
  const cs = buildTraceCurrentState({ pendingCollection: collection })
  assert.equal(cs.hasPendingCollection, true)
  assert.ok(cs.pendingCollectionSummary?.includes("宠物擦脚巾湿巾"), `summary: ${cs.pendingCollectionSummary}`)
  assert.ok(cs.pendingCollectionSummary?.includes("completeness="), `summary: ${cs.pendingCollectionSummary}`)
})

// ---------- 20. buildTraceCurrentState：pendingBatch 计数 ----------

test("20. buildTraceCurrentState 含 pendingBatch → 计数正确", () => {
  const state = makeState()
  const d1 = buildLocalDraftFromText("今天买了 5 袋猫砂", state)
  const d2 = buildLocalDraftFromText("今天买了 2 瓶洗发水", state)
  assert.ok(d1 && d2)
  const cs = buildTraceCurrentState({ pendingBatch: [d1, d2] })
  assert.equal(cs.hasPendingBatch, true)
  assert.equal(cs.pendingBatchCount, 2)
})

// ---------- 21. setRouteDecision：填充各字段 ----------

test("21. setRouteDecision 填充 handler/rule/interceptedByRule/routeToLlm/reason", () => {
  const trace = createTrace("测试", {})
  setRouteDecision(trace, "boundary", {
    rule: "boundary.casual",
    interceptedByRule: true
  })
  assert.equal(trace.routeDecision?.handler, "boundary")
  assert.equal(trace.routeDecision?.rule, "boundary.casual")
  assert.equal(trace.routeDecision?.interceptedByRule, true)
  assert.equal(trace.routeDecision?.routeToLlm, undefined)

  setRouteDecision(trace, "needLlm", {
    rule: "query_intent_or_unmatched",
    routeToLlm: true,
    reason: "query intent or unmatched input"
  })
  assert.equal(trace.routeDecision?.handler, "needLlm")
  assert.equal(trace.routeDecision?.routeToLlm, true)
  assert.equal(trace.routeDecision?.reason, "query intent or unmatched input")
})

// ---------- 22. setRouteDecision：trace 为 undefined 时安全跳过 ----------

test("22. setRouteDecision(undefined, ...) 不抛错", () => {
  assert.doesNotThrow(() => setRouteDecision(undefined, "boundary", { rule: "x" }))
})

// ---------- 23. setFinalDecision：填充 finalDecision 与完整 finalMessage ----------

test("23. setFinalDecision 填充 finalDecision.kind/turnKind 与完整 finalMessage", () => {
  const trace = createTrace("测试", {})
  const msg = "猫砂我就按一袋记，今天补上。价格和平台这次先空着，不影响记录。"
  setFinalDecision(trace, { kind: "llm", turnKind: "proposal", message: msg })
  assert.equal(trace.finalDecision?.kind, "llm")
  assert.equal(trace.finalDecision?.turnKind, "proposal")
  assert.equal(trace.finalMessage, msg, "finalMessage 应为完整文本")
})

// ---------- 24. setFinalDecision：长消息 finalDecision.message 截断 300，finalMessage 保留完整 ----------

test("24. setFinalDecision 长消息：finalDecision.message 截断 300，finalMessage 完整", () => {
  const trace = createTrace("测试", {})
  const longMsg = "这是非常长的回复".repeat(100) // 远超 300 字符
  setFinalDecision(trace, { kind: "sync", message: longMsg })
  assert.ok(
    (trace.finalDecision?.message?.length ?? 0) <= 300,
    `finalDecision.message 应 <= 300, 实际: ${trace.finalDecision?.message?.length}`
  )
  assert.equal(trace.finalMessage, longMsg, "finalMessage 应保留完整文本")
})

// ---------- 25. setFinalDecision：trace 为 undefined 时安全跳过 ----------

test("25. setFinalDecision(undefined, ...) 不抛错", () => {
  assert.doesNotThrow(() => setFinalDecision(undefined, { kind: "sync", message: "x" }))
})

// ---------- 26. createTrace 第三参 currentState 注入 ----------

test("26. createTrace 第三参 currentState 被原样保留", () => {
  const cs = buildTraceCurrentState({
    pendingPlan: createAgentPlan([{ type: "setMonthlyBudget", amount: 500 }], "设预算", NOW)
  })
  const trace = createTrace("设预算", {}, cs)
  assert.equal(trace.currentState, cs)
  assert.equal(trace.currentState?.hasPendingPlan, true)
  assert.ok(trace.currentState?.pendingPlanSummary?.includes("setMonthlyBudget"))
})

// ---------- 27. formatTraceForCopy：包含全部 9 个字段标签 ----------

test("27. formatTraceForCopy 输出包含 9 个字段标签", () => {
  const trace = createTrace("今天买了 5 袋猫砂", {})
  setRouteDecision(trace, "writeDraft", { rule: "drafts.proposal", interceptedByRule: true })
  setFinalDecision(trace, { kind: "sync", turnKind: "proposal", message: "猫砂我就按一袋记下。" })
  const text = formatTraceForCopy(trace)
  assert.ok(text.includes("【1. userInput】"), "缺 1. userInput")
  assert.ok(text.includes("【2. currentState】"), "缺 2. currentState")
  assert.ok(text.includes("【3. routeDecision】"), "缺 3. routeDecision")
  assert.ok(text.includes("【4. llmRequest】"), "缺 4. llmRequest")
  assert.ok(text.includes("【5. llmResponse】"), "缺 5. llmResponse")
  assert.ok(text.includes("【6. parseResult】"), "缺 6. parseResult")
  assert.ok(text.includes("【7. validationResult】"), "缺 7. validationResult")
  assert.ok(text.includes("【8. finalDecision】"), "缺 8. finalDecision")
  assert.ok(text.includes("【9. finalMessage】"), "缺 9. finalMessage")
  assert.ok(text.includes("今天买了 5 袋猫砂"), "应包含 userInput 原文")
  assert.ok(text.includes("猫砂我就按一袋记下。"), "应包含 finalMessage 完整文本")
  assert.ok(text.includes("AGENT DECISION TRACE"), "应包含 header")
  assert.ok(text.includes("END TRACE"), "应包含 footer")
})

// ---------- 28. formatTraceForCopy：未填充字段显示 (not captured) ----------

test("28. formatTraceForCopy 未填充字段显示 not captured / no LLM call", () => {
  const trace = createTrace("测试", {})
  const text = formatTraceForCopy(trace)
  assert.ok(text.includes("(not captured)"), "currentState 未填充应显示 not captured")
  assert.ok(text.includes("(no LLM call)"), "llmRequest 未填充应显示 no LLM call")
  assert.ok(text.includes("(no LLM response)"), "llmResponse 未填充应显示 no LLM response")
})

// ---------- 29. commitTrace 注册 __copyAgentTrace 与 __agentTraceHistory ----------

test("29. commitTrace 注册 globalThis.__copyAgentTrace 返回 formatTraceForCopy 文本", () => {
  const trace = createTrace("拼夕夕", { collectionItemName: "猫砂" })
  commitTrace(trace)
  // eslint-disable-next-line no-undef
  assert.equal(typeof globalThis.__copyAgentTrace, "function")
  const copied = globalThis.__copyAgentTrace()
  assert.ok(copied.includes("拼夕夕"), "copy 文本应含 userInput")
  assert.ok(copied.includes("【1. userInput】"))
})

// ---------- 30. peekTraceHistory：累积历史，上限 20 ----------

test("30. peekTraceHistory 累积历史，超过上限 20 时丢弃最旧", () => {
  for (let i = 0; i < 25; i++) {
    commitTrace(createTrace(`输入${i}`, {}))
  }
  const history = peekTraceHistory()
  assert.equal(history.length, 20, `history 应上限 20, 实际: ${history.length}`)
  // 最旧的「输入0~4」应被丢弃，保留「输入5~24」
  assert.equal(history[0].userText, "输入5", `最旧应保留输入5, 实际: ${history[0].userText}`)
  assert.equal(history[19].userText, "输入24", `最新应保留输入24, 实际: ${history[19].userText}`)
})

// ---------- 31. normalizeLlm：queryAnswer 填充 parseResult + validationResult ----------

test("31. normalizeLlm queryAnswer → parseResult.ok=true, validationResult.passed=true", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const trace = createTrace("猫砂还能用多久", {})
  const turn = orch.normalizeLlmResponse(
    '{"kind":"queryAnswer","answer":"猫砂大概还能用 5 天。"}',
    { text: "猫砂还能用多久", state, itemViews: [], dateContext: DATE_CONTEXT, trace }
  )
  assert.ok(turn, "queryAnswer 应解析成功")
  assert.equal(turn.kind, "answer")
  assert.equal(trace.parseResult?.ok, true)
  assert.equal(trace.parseResult?.kind, "queryAnswer")
  assert.equal(trace.validationResult?.passed, true)
  assert.equal(trace.validationResult?.turnKind, "answer")
})

// ---------- 32. normalizeLlm：解析失败填充 parseResult + validationResult ----------

test("32. normalizeLlm 非 JSON → parseResult.ok=false, validationResult.rejectReason=normalize_returned_null", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const trace = createTrace("随便说", {})
  const turn = orch.normalizeLlmResponse(
    "这不是 JSON",
    { text: "随便说", state, itemViews: [], dateContext: DATE_CONTEXT, trace }
  )
  assert.equal(turn, null, "非 JSON 应返回 null")
  assert.equal(trace.parseResult?.ok, false)
  assert.equal(trace.parseResult?.error, "parse_failed")
  assert.equal(trace.validationResult?.passed, false)
  assert.equal(trace.validationResult?.rejectReason, "normalize_returned_null")
})

// ---------- 33. normalizeLlm：draft 填充 parseResult + validationResult ----------

test("33. normalizeLlm draft(restock) → parseResult.kind=draft, validationResult.turnKind=proposal/collection", () => {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const orch = createHouseholdOrchestrator()
  const trace = createTrace("今天买了 5 袋猫砂", {})
  const turn = orch.normalizeLlmResponse(
    '{"kind":"draft","message":"猫砂我就按一袋记下。","draft":{"kind":"restock","itemName":"猫砂","qty":5,"unit":"袋"}}',
    { text: "今天买了 5 袋猫砂", state, itemViews: viewsOf([makeItem("i1", "猫砂", "宠物用品")]), dateContext: DATE_CONTEXT, trace }
  )
  assert.ok(turn, "draft 应解析成功")
  assert.equal(trace.parseResult?.ok, true)
  assert.equal(trace.parseResult?.kind, "draft")
  assert.equal(trace.validationResult?.passed, true)
  assert.ok(
    trace.validationResult?.turnKind === "proposal" || trace.validationResult?.turnKind === "collection",
    `turnKind 应为 proposal 或 collection, 实际: ${trace.validationResult?.turnKind}`
  )
})

// ---------- 34. normalizeLlm：clarification 填充 parseResult + validationResult ----------

test("34. normalizeLlm clarification → parseResult.kind=clarification, validationResult.passed=true", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const trace = createTrace("加一个", {})
  const turn = orch.normalizeLlmResponse(
    '{"kind":"clarification","clarification":{"question":"你说的「加一个」是要加什么？","options":["猫砂","猫粮"]}}',
    { text: "加一个", state, itemViews: [], dateContext: DATE_CONTEXT, trace }
  )
  assert.ok(turn, "clarification 应解析成功")
  assert.equal(turn.kind, "clarification")
  assert.equal(trace.parseResult?.kind, "clarification")
  assert.equal(trace.validationResult?.passed, true)
  assert.equal(trace.validationResult?.turnKind, "clarification")
})

// ---------- 35. normalizeLlm：未传 trace 时不报错（向后兼容） ----------

test("35. normalizeLlm 未传 trace → 正常解析，不报错", () => {
  const state = makeState()
  const orch = createHouseholdOrchestrator()
  const turn = orch.normalizeLlmResponse(
    '{"kind":"queryAnswer","answer":"好的。"}',
    { text: "好", state, itemViews: [], dateContext: DATE_CONTEXT }
  )
  assert.ok(turn)
  assert.equal(turn.kind, "answer")
})

// ---------- 36. formatTraceForCopy：llmRequest + llmResponse 完整渲染 ----------

test("36. formatTraceForCopy 渲染 llmRequest/llmResponse/parseResult/validationResult 全字段", () => {
  const trace = createTrace("帮我看看猫砂", {})
  setRouteDecision(trace, "needLlm", { rule: "query_intent_or_unmatched", routeToLlm: true })
  trace.llmRequest = {
    kind: "answerLlm",
    model: "qwen-plus",
    systemPromptPreview: "你是 403 家庭管家",
    recentMessageCount: 6,
    relevantFactsPreview: "猫砂：余量充足",
    activeFocus: "queryTopic",
    allowedActions: ["queryAnswer", "draft", "clarification"]
  }
  trace.llmResponse = {
    ok: true,
    content: '{"kind":"queryAnswer","answer":"猫砂还能用 5 天。"}',
    elapsedMs: 820
  }
  trace.parseResult = { ok: true, kind: "queryAnswer" }
  trace.validationResult = { passed: true, turnKind: "answer" }
  setFinalDecision(trace, { kind: "llm", turnKind: "answer", message: "猫砂还能用 5 天。" })
  const text = formatTraceForCopy(trace)
  assert.ok(text.includes("kind=answerLlm"), "应渲染 llmRequest.kind")
  assert.ok(text.includes("model=qwen-plus"), "应渲染 model")
  assert.ok(text.includes("recentMessageCount=6"), "应渲染 recentMessageCount")
  assert.ok(text.includes("activeFocus=queryTopic"), "应渲染 activeFocus")
  assert.ok(text.includes("你是 403 家庭管家"), "应渲染 systemPromptPreview")
  assert.ok(text.includes("ok=true, elapsedMs=820"), "应渲染 llmResponse ok 与 elapsedMs")
  assert.ok(text.includes("猫砂还能用 5 天"), "应渲染 llmResponse content")
  assert.ok(text.includes("ok=true, kind=queryAnswer"), "应渲染 parseResult")
  assert.ok(text.includes("passed=true, turnKind=answer"), "应渲染 validationResult")
})

// ---------- 37. formatTraceForCopy：validation 失败渲染 rejectReason ----------

test("37. formatTraceForCopy 渲染 validationResult.rejectReason", () => {
  const trace = createTrace("随便", {})
  trace.parseResult = { ok: false, error: "parse_failed" }
  trace.validationResult = { passed: false, rejectReason: "normalize_returned_null" }
  const text = formatTraceForCopy(trace)
  assert.ok(text.includes("ok=false"), "应渲染 parseResult.ok=false")
  assert.ok(text.includes("error=parse_failed"), "应渲染 parseResult.error")
  assert.ok(text.includes("passed=false"), "应渲染 validationResult.passed=false")
  assert.ok(text.includes("rejectReason=normalize_returned_null"), "应渲染 rejectReason")
})
