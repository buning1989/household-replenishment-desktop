// 阶段 3B.1：agentDecisionTrace llmInterpreter.called 字段硬化测试
// 运行方式：node --test tests/agent-decision-trace-llm-called.test.mjs
//
// 覆盖：
//   1. 本地高置信输入 → llmInterpreter.called=false, skipReason=local_high_confidence
//   2. pendingCollection 低置信别名 → LLM mock 返回 platform=拼多多，called=true, schemaValid=true
//   3. LLM rawResponse 非法 JSON → called=true, schemaValid=false, rejectReason 存在
//   4. LLM 成功解释后被本地规则继续路由 → called=true 且 interceptedByRule=true 可同时成立
//   5. 无 LLM client / 无 key → 不抛异常，trace 说明 skipReason
//   6. createTrace 默认初始化 llmInterpreter.called=false
//   7. formatTraceForCopy 包含 called / skipReason / schemaValid 字段
//   8. LLM client 抛异常 → called=true, error 存在, rejectReason 存在
//
// 所有 LLM 调用通过 mock client 注入，不真实调用外部 LLM。

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
const { createTrace, formatTraceForCopy, setRouteDecision, setFinalDecision } = await import("../src/agent/agentDecisionTrace.ts")
const { askTurnInterpreterLlm } = await import("../src/agent/turnInterpreterLlm.ts")
const { buildLocalDraftFromText } = await import("../src/agent/drafts.ts")
const { createDraftCollection } = await import("../src/agent/draftCollection.ts")
const { buildChatDateContext } = await import("../src/llm/householdChat.ts")

const NOW = Date.UTC(2026, 6, 9) // 2026-07-09
const DATE_CONTEXT = buildChatDateContext(NOW)

function makeState(overrides = {}) {
  return {
    version: 3,
    categories: ["宠物用品", "卫生间", "其他"],
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

// 构造「宠物擦脚巾湿巾」采集态
function buildWipesCollection() {
  const state = makeState({ items: [] })
  const draft = buildLocalDraftFromText("今天买了 5 包宠物擦脚巾湿巾", state)
  assert.ok(draft)
  return createDraftCollection(draft, [], NOW)
}

/** mock client：返回预设 JSON 字符串 */
function mockClient(response) {
  return {
    async complete(_prompt) {
      if (typeof response === "string") return response
      return JSON.stringify(response)
    }
  }
}

/** mock client：抛异常 */
function failingClient() {
  return {
    async complete(_prompt) {
      throw new Error("mock llm failure")
    }
  }
}

/** 从 AgentDraft 统一取出补货字段 */
function restockFields(draft) {
  if (draft.kind === "restock") {
    return { itemName: draft.itemName, platform: draft.platform }
  }
  if (draft.kind === "createItemWithRestock") {
    return { itemName: draft.item.itemName, platform: draft.restock.platform }
  }
  return { itemName: undefined, platform: undefined }
}

// ---------- 1. 本地高置信输入 → called=false ----------

test("1. 本地高置信输入「今天买了 3 袋五常大米」→ llmInterpreter.called=false", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [] })
  const trace = createTrace("今天买了 3 袋五常大米", {})

  const decision = decide(orch, {
    text: "今天买了 3 袋五常大米",
    state,
    itemViews: viewsOf(state.items),
    trace
  })

  assert.equal(decision.kind, "sync")
  assert.ok(trace.llmInterpreter, "llmInterpreter 应被 createTrace 默认初始化")
  assert.equal(trace.llmInterpreter.called, false, "本地高置信路径 called=false")
  assert.equal(trace.llmInterpreter.shouldCall, false, "shouldCall=false")
  assert.equal(trace.llmInterpreter.skipReason, "local_high_confidence", "skipReason=local_high_confidence")
})

// ---------- 2. pendingCollection 低置信别名 → LLM mock 返回 platform=拼多多 ----------

test("2. pendingCollection + 拼夕夕 → LLM called=true, schemaValid=true, platform=拼多多", async () => {
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildWipesCollection()
  const trace = createTrace("拼夕夕", {})

  // 2a. decide 返回 needTurnInterpreterLlm
  const d = decide(orch, {
    text: "拼夕夕",
    state,
    itemViews: [],
    pendingCollection,
    trace
  })
  assert.equal(d.kind, "needTurnInterpreterLlm")

  // 2b. interpretAndRoute 走 LLM mock
  const llmDecision = await orch.interpretAndRoute(
    {
      text: "拼夕夕",
      state,
      itemViews: [],
      pendingCollection,
      dateContext: DATE_CONTEXT,
      trace
    },
    mockClient({
      intent: "supplement_current_collection",
      fields: { platform: "拼多多" },
      confidence: "high",
      reason: "拼夕夕是拼多多别名"
    })
  )

  assert.equal(llmDecision.kind, "sync")
  assert.ok(trace.llmInterpreter, "llmInterpreter 应存在")
  assert.equal(trace.llmInterpreter.called, true, "called=true")
  assert.equal(trace.llmInterpreter.shouldCall, true, "shouldCall=true")
  assert.equal(trace.llmInterpreter.schemaValid, true, "schemaValid=true")
  assert.equal(trace.llmInterpreter.provider, "mock", "provider=mock")
  assert.ok(trace.llmInterpreter.rawResponse, "rawResponse 应存在")
  assert.ok(trace.llmInterpreter.durationMs >= 0, "durationMs 应记录")

  // 最终仍能补全 platform
  const draft = llmDecision.turn.kind === "collection"
    ? llmDecision.turn.collection.draft
    : llmDecision.turn.executableDraft
  assert.equal(restockFields(draft).platform, "拼多多")
})

// ---------- 3. LLM rawResponse 非法 JSON → called=true, schemaValid=false ----------

test("3. LLM 返回非法 JSON → called=true, schemaValid=false, rejectReason 存在", async () => {
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildWipesCollection()
  const trace = createTrace("asdfasdf", {})

  const d = decide(orch, {
    text: "asdfasdf",
    state,
    itemViews: [],
    pendingCollection,
    trace
  })
  assert.equal(d.kind, "needTurnInterpreterLlm")

  const llmDecision = await orch.interpretAndRoute(
    {
      text: "asdfasdf",
      state,
      itemViews: [],
      pendingCollection,
      dateContext: DATE_CONTEXT,
      trace
    },
    mockClient("这不是合法 JSON {{{")
  )

  // 非法 JSON → repair 失败 → clarification fallback
  assert.equal(llmDecision.kind, "sync")
  assert.ok(trace.llmInterpreter.called, "called=true（已尝试调用）")
  assert.equal(trace.llmInterpreter.schemaValid, false, "schemaValid=false")
  assert.ok(trace.llmInterpreter.rejectReason, "rejectReason 应存在")
  assert.ok(trace.llmInterpreter.rawResponse, "rawResponse 应记录原始非法文本")
})

// ---------- 4. LLM 成功解释后被本地规则继续路由 → called=true 且 interceptedByRule=true ----------

test("4. LLM 成功解释 + 后续被本地 route rule 接住 → called=true 且 interceptedByRule=true 可同时成立", async () => {
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildWipesCollection()
  const trace = createTrace("拼夕夕", {})

  const d = decide(orch, {
    text: "拼夕夕",
    state,
    itemViews: [],
    pendingCollection,
    trace
  })
  assert.equal(d.kind, "needTurnInterpreterLlm")

  // LLM 返回 supplement_current_collection + platform=拼多多
  // interpretAndRouteSync 会用 handlePendingCollectionIntent 处理 → 本地 route rule 接住
  const llmDecision = await orch.interpretAndRoute(
    {
      text: "拼夕夕",
      state,
      itemViews: [],
      pendingCollection,
      dateContext: DATE_CONTEXT,
      trace
    },
    mockClient({
      intent: "supplement_current_collection",
      fields: { platform: "拼多多" },
      confidence: "high",
      reason: "拼夕夕是拼多多别名"
    })
  )

  assert.equal(llmDecision.kind, "sync")
  // LLM 被调用
  assert.equal(trace.llmInterpreter.called, true, "LLM 被调用")
  // 最终被本地 route rule 接住
  assert.ok(trace.routeDecision, "routeDecision 应存在")
  assert.equal(trace.routeDecision.interceptedByRule, true, "interceptedByRule=true（本地规则接住）")
  // 关键断言：二者可同时为 true，不互相覆盖
  assert.ok(
    trace.llmInterpreter.called && trace.routeDecision.interceptedByRule,
    "called=true 和 interceptedByRule=true 可同时成立，不互相覆盖"
  )
})

// ---------- 5. 无 LLM client / 无 key → 不抛异常，trace 说明 skipReason ----------

test("5. 无 API key + 无 clientOverride → 不抛异常，trace.skipReason=no_api_key", async () => {
  const state = makeState({ items: [], settings: {} }) // 无 aiApiKey
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildWipesCollection()
  const trace = createTrace("拼夕夕", {})

  const d = decide(orch, {
    text: "拼夕夕",
    state,
    itemViews: [],
    pendingCollection,
    trace
  })
  assert.equal(d.kind, "needTurnInterpreterLlm")

  // 无 clientOverride → createDesktopTurnInterpreterLlmClient 返回 null（无 window.desktop）
  const llmDecision = await orch.interpretAndRoute(
    {
      text: "拼夕夕",
      state,
      itemViews: [],
      pendingCollection,
      dateContext: DATE_CONTEXT,
      trace
    }
    // 不传 clientOverride
  )

  // 不抛异常，返回 clarification fallback
  assert.equal(llmDecision.kind, "sync")
  assert.equal(trace.llmInterpreter.called, false, "called=false（无 client）")
  assert.ok(trace.llmInterpreter.skipReason, "skipReason 应存在")
  // skipReason 可能是 no_api_key 或 no_desktop_bridge
  assert.ok(
    trace.llmInterpreter.skipReason === "no_api_key" || trace.llmInterpreter.skipReason === "no_desktop_bridge",
    `skipReason 应为 no_api_key 或 no_desktop_bridge, 实际: ${trace.llmInterpreter.skipReason}`
  )
})

// ---------- 6. createTrace 默认初始化 llmInterpreter.called=false ----------

test("6. createTrace 默认初始化 llmInterpreter.called=false, skipReason=local_high_confidence", () => {
  const trace = createTrace("测试", {})
  assert.ok(trace.llmInterpreter, "llmInterpreter 应被默认初始化")
  assert.equal(trace.llmInterpreter.called, false)
  assert.equal(trace.llmInterpreter.shouldCall, false)
  assert.equal(trace.llmInterpreter.skipReason, "local_high_confidence")
})

// ---------- 7. formatTraceForCopy 包含 called / skipReason / schemaValid 字段 ----------

test("7. formatTraceForCopy 包含 called / skipReason / schemaValid 字段", () => {
  // 场景 A：本地高置信（called=false）
  const traceA = createTrace("今天买了 3 袋五常大米", {})
  setRouteDecision(traceA, "writeDraft", { rule: "drafts.collection", interceptedByRule: true })
  const textA = formatTraceForCopy(traceA)
  assert.ok(textA.includes("called=false"), "应包含 called=false")
  assert.ok(textA.includes("skipReason=local_high_confidence"), "应包含 skipReason")
  assert.ok(
    textA.includes("interceptedByRule=true 只表示") || textA.includes("不代表「未调用 LLM」"),
    "应包含 interceptedByRule 不等于未调用 LLM 的提示"
  )

  // 场景 B：LLM 调用成功（called=true, schemaValid=true）
  const traceB = createTrace("拼夕夕", {})
  traceB.llmInterpreter = {
    shouldCall: true,
    called: true,
    provider: "mock",
    model: "qwen-plus",
    rawResponse: '{"intent":"supplement_current_collection"}',
    schemaValid: true,
    durationMs: 42
  }
  setRouteDecision(traceB, "turnInterpreter", { rule: "llm_success", interceptedByRule: true })
  const textB = formatTraceForCopy(traceB)
  assert.ok(textB.includes("called=true"), "应包含 called=true")
  assert.ok(textB.includes("schemaValid=true"), "应包含 schemaValid=true")
  assert.ok(textB.includes("provider=mock"), "应包含 provider=mock")
  assert.ok(textB.includes("durationMs=42"), "应包含 durationMs=42")
})

// ---------- 8. LLM client 抛异常 → called=true, error 存在, rejectReason 存在 ----------

test("8. LLM client 抛异常 → called=true, error 存在, rejectReason 存在", async () => {
  const state = makeState({ items: [] })
  const orch = createHouseholdOrchestrator()
  const pendingCollection = buildWipesCollection()
  const trace = createTrace("拼夕夕", {})

  const d = decide(orch, {
    text: "拼夕夕",
    state,
    itemViews: [],
    pendingCollection,
    trace
  })
  assert.equal(d.kind, "needTurnInterpreterLlm")

  const llmDecision = await orch.interpretAndRoute(
    {
      text: "拼夕夕",
      state,
      itemViews: [],
      pendingCollection,
      dateContext: DATE_CONTEXT,
      trace
    },
    failingClient()
  )

  assert.equal(llmDecision.kind, "sync")
  assert.equal(trace.llmInterpreter.called, true, "called=true（已尝试调用）")
  assert.ok(trace.llmInterpreter.error, "error 应存在（client 抛异常）")
  assert.ok(trace.llmInterpreter.rejectReason, "rejectReason 应存在")
  assert.ok(
    trace.llmInterpreter.rejectReason.includes("client_exception"),
    `rejectReason 应含 client_exception, 实际: ${trace.llmInterpreter.rejectReason}`
  )
  assert.ok(trace.llmInterpreter.durationMs >= 0, "durationMs 应记录")
})

// ---------- 9. askTurnInterpreterLlm 直接调用：无 client + 无 key → skipReason ----------

test("9. askTurnInterpreterLlm 无 client + 无 key → called=false, skipReason=no_api_key", async () => {
  const state = makeState({ items: [], settings: {} }) // 无 aiApiKey
  const collection = buildWipesCollection()
  const trace = createTrace("拼夕夕", {})

  const result = await askTurnInterpreterLlm({
    text: "拼夕夕",
    pendingCollection: collection,
    state,
    itemViews: [],
    dateContext: DATE_CONTEXT,
    trace
    // 不传 client → createDesktopTurnInterpreterLlmClient 返回 null
  })

  assert.equal(result, null)
  assert.equal(trace.llmInterpreter.called, false)
  assert.ok(trace.llmInterpreter.skipReason, "skipReason 应存在")
  assert.ok(
    trace.llmInterpreter.skipReason === "no_api_key" || trace.llmInterpreter.skipReason === "no_desktop_bridge",
    `skipReason 应为 no_api_key 或 no_desktop_bridge, 实际: ${trace.llmInterpreter.skipReason}`
  )
})

// ---------- 10. pendingDraft 本地高置信 → called=false（阶段 3B 回归） ----------

test("10. pendingDraft + 确认 → called=false, interceptedByRule=true（不冲突）", () => {
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const pendingDraft = {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 2,
    unit: "袋",
    price: 89,
    platform: "京东",
    restockDate: NOW
  }
  const trace = createTrace("确认", {})

  const decision = decide(orch, {
    text: "确认",
    state,
    itemViews: viewsOf(state.items),
    pendingDraft,
    trace
  })

  assert.equal(decision.kind, "sync")
  assert.equal(trace.llmInterpreter.called, false, "本地高置信 called=false")
  assert.equal(trace.routeDecision.interceptedByRule, true, "interceptedByRule=true")
  // 二者不冲突
  assert.ok(
    !trace.llmInterpreter.called && trace.routeDecision.interceptedByRule,
    "called=false 和 interceptedByRule=true 可同时成立"
  )
})

// ---------- 11. pendingPlan 本地高置信 → called=false（阶段 3A 回归） ----------

test("11. pendingPlan + 确认 → called=false, interceptedByRule=true（不冲突）", async () => {
  const { createAgentPlan } = await import("../src/agent/actions.ts")
  const orch = createHouseholdOrchestrator()
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const plan = createAgentPlan(
    [{ type: "createCategory", name: "清洁用品" }],
    "新建分类清洁用品",
    NOW
  )
  const pendingPlan = { ...plan, status: "pending" }
  const trace = createTrace("确认", {})

  const decision = decide(orch, {
    text: "确认",
    state,
    itemViews: viewsOf(state.items),
    pendingPlan,
    trace
  })

  assert.equal(decision.kind, "sync")
  assert.equal(trace.llmInterpreter.called, false, "本地高置信 called=false")
  assert.equal(trace.routeDecision.interceptedByRule, true, "interceptedByRule=true")
})
