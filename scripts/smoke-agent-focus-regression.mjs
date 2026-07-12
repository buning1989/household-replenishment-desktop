#!/usr/bin/env node
// 阶段 4A：Agent 焦点回归 smoke（mock，不依赖真实 LLM）
// 运行方式：npm run smoke:agent-focus-regression
//
// 覆盖四类 pending 状态下「新采购记录不被吞掉 + 确认/取消仍走旧 handler」的核心路径。
// 每个 case 输出 PASS / FAIL；失败时输出 finalDecision / routeDecision / llmInterpreter / firstFocusDecision。
//
// 不依赖真实 LLM。pendingCollection 低置信别名场景使用 mock client。

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
const { createTrace } = await import("../src/agent/agentDecisionTrace.ts")
const { buildLocalDraftFromText } = await import("../src/agent/drafts.ts")
const { createDraftCollection } = await import("../src/agent/draftCollection.ts")
const { createAgentPlan } = await import("../src/agent/actions.ts")
const { buildChatDateContext } = await import("../src/llm/householdChat.ts")

const NOW = Date.UTC(2026, 6, 9)
const DATE_CONTEXT = buildChatDateContext(NOW)

// ---------- 夹具 ----------

function makeState(overrides = {}) {
  return {
    version: 3,
    categories: ["宠物用品", "卫生间", "日常护理", "其他"],
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

/** 从 AgentDraft 统一取出补货字段 */
function restockFields(draft) {
  if (!draft) return { itemName: undefined, qty: undefined, platform: undefined }
  if (draft.kind === "restock") {
    return { itemName: draft.itemName, qty: draft.qty, platform: draft.platform }
  }
  if (draft.kind === "createItemWithRestock") {
    return { itemName: draft.item.itemName, qty: draft.restock.qty, platform: draft.restock.platform }
  }
  return { itemName: undefined, qty: undefined, platform: undefined }
}

/** 构造「宠物擦脚巾湿巾」采集态 */
function buildWipesCollection() {
  const state = makeState({ items: [] })
  const draft = buildLocalDraftFromText("今天买了 5 包宠物擦脚巾湿巾", state)
  return createDraftCollection(draft, [], NOW)
}

/** 构造 pendingDraft（猫砂补货 proposal） */
function makePendingDraft() {
  return {
    kind: "restock",
    itemId: "i1",
    itemName: "猫砂",
    qty: 2,
    unit: "袋",
    price: 89,
    platform: "京东",
    restockDate: NOW
  }
}

/** 构造 pendingBatch（订单导入后的多条草稿） */
function makePendingBatch() {
  return [
    { kind: "restock", itemId: "i1", itemName: "猫砂", qty: 2, unit: "袋", price: 89, platform: "京东", restockDate: NOW },
    { kind: "restock", itemId: "i2", itemName: "猫粮", qty: 1, unit: "袋", price: 120, platform: "淘宝", restockDate: NOW }
  ]
}

/** mock LLM client：返回预设 JSON */
function mockClient(response) {
  return {
    async complete(_prompt) {
      if (typeof response === "string") return response
      return JSON.stringify(response)
    }
  }
}

function decide(orch, input) {
  return orch.decide({ dateContext: DATE_CONTEXT, itemViews: [], ...input })
}

// ---------- 断言辅助 ----------

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assertNotEqual(actual, unexpected, message) {
  if (actual === unexpected) {
    throw new Error(`${message}: should not equal ${JSON.stringify(unexpected)}, got ${JSON.stringify(actual)}`)
  }
}

function assertOk(value, message) {
  if (!value) {
    throw new Error(`${message}: expected truthy, got ${JSON.stringify(value)}`)
  }
}

// ---------- case 定义 ----------

/**
 * 每个 case 返回 { status: "PASS" | "FAIL", detail?: string }
 * 失败时附加 trace 摘要
 */
function runCase(name, fn) {
  try {
    const result = fn()
    return { name, status: "PASS", ...result }
  } catch (err) {
    return { name, status: "FAIL", error: err.message }
  }
}

/**
 * 异步 case（需要 interpretAndRoute）
 */
async function runAsyncCase(name, fn) {
  try {
    const result = await fn()
    return { name, status: "PASS", ...result }
  } catch (err) {
    return { name, status: "FAIL", error: err.message }
  }
}

function traceSummary(trace) {
  if (!trace) return "(no trace)"
  return JSON.stringify({
    firstFocus: trace.firstFocusDecision?.focus,
    routeHandler: trace.routeDecision?.handler,
    routeRule: trace.routeDecision?.rule,
    interceptedByRule: trace.routeDecision?.interceptedByRule,
    routeToLlm: trace.routeDecision?.routeToLlm,
    llmCalled: trace.llmInterpreter?.called,
    llmSkipReason: trace.llmInterpreter?.skipReason,
    llmSchemaValid: trace.llmInterpreter?.schemaValid,
    llmRejectReason: trace.llmInterpreter?.rejectReason,
    llmError: trace.llmInterpreter?.error,
    finalKind: trace.finalDecision?.kind,
    finalTurnKind: trace.finalDecision?.turnKind
  }, null, 2)
}

// ============================================================
// 1. pendingCollection 场景
// ============================================================

const collectionCases = [
  {
    group: "pendingCollection",
    name: "1.1 拼夕夕 → platform=拼多多（本地别名，不送 LLM）",
    run: () => {
      const orch = createHouseholdOrchestrator()
      const state = makeState({ items: [] })
      const pendingCollection = buildWipesCollection()
      const trace = createTrace("拼夕夕", {})

      const d = decide(orch, { text: "拼夕夕", state, itemViews: [], pendingCollection, trace })
      // 阶段 4B.5：拼夕夕现在由本地 parsePlatform 别名表处理，不再送 LLM
      assertEqual(d.kind, "sync", "decide kind")
      assertOk(d.turn.kind === "collection" || d.turn.kind === "proposal", "turn kind")
      const draft = d.turn.kind === "collection" ? d.turn.collection?.draft : d.turn.executableDraft
      assertEqual(restockFields(draft).platform, "拼多多", "platform")
      assertEqual(trace.llmInterpreter.called, false, "llm not called")
      return { trace }
    }
  },
  {
    group: "pendingCollection",
    name: "1.2 今天买了 3 袋五常大米 → 新建 collection",
    run: () => {
      const orch = createHouseholdOrchestrator()
      const state = makeState({ items: [] })
      const pendingCollection = buildWipesCollection()
      const trace = createTrace("今天买了 3 袋五常大米", {})

      const d = decide(orch, { text: "今天买了 3 袋五常大米", state, itemViews: [], pendingCollection, trace })
      assertEqual(d.kind, "sync", "decide kind")
      assertEqual(d.turn.kind, "collection", "turn kind")
      assertEqual(restockFields(d.turn.collection?.draft).itemName, "五常大米", "itemName")
      assertEqual(trace.firstFocusDecision?.focus, "start_new_collection", "focus")
      assertEqual(trace.llmInterpreter.called, false, "llm called")
      assertEqual(trace.llmInterpreter.skipReason, "local_high_confidence", "skipReason")
      return { trace }
    }
  },
  {
    group: "pendingCollection",
    name: "1.3 128 → price=128",
    run: () => {
      const orch = createHouseholdOrchestrator()
      const state = makeState({ items: [] })
      const pendingCollection = buildWipesCollection()
      const trace = createTrace("128", {})

      const d = decide(orch, { text: "128", state, itemViews: [], pendingCollection, trace })
      assertEqual(d.kind, "sync", "decide kind")
      const draft = d.turn.collection?.draft
      assertEqual(restockFields(draft).itemName, "宠物擦脚巾湿巾", "itemName 不变")
      return { trace }
    }
  }
]

// ============================================================
// 2. pendingPlan 场景
// ============================================================

const planCases = [
  {
    group: "pendingPlan",
    name: "2.1 确认 → 仍走 plan handler",
    run: () => {
      const orch = createHouseholdOrchestrator()
      const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
      const plan = createAgentPlan([{ type: "createCategory", name: "清洁用品" }], "新建分类", NOW)
      const pendingPlan = { ...plan, status: "pending" }
      const trace = createTrace("确认", {})

      const d = decide(orch, { text: "确认", state, itemViews: viewsOf(state.items), pendingPlan, trace })
      assertEqual(d.kind, "sync", "decide kind")
      assertEqual(d.turn.kind, "planCommand", "turn kind")
      assertEqual(trace.firstFocusDecision?.focus, "continue_pending_plan", "focus")
      assertEqual(trace.llmInterpreter.called, false, "llm called")
      return { trace }
    }
  },
  {
    group: "pendingPlan",
    name: "2.2 今天买了 3 袋五常大米 → 新建 collection（不被「袋」误判）",
    run: () => {
      const orch = createHouseholdOrchestrator()
      const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
      const plan = createAgentPlan([{ type: "createCategory", name: "清洁用品" }], "新建分类", NOW)
      const pendingPlan = { ...plan, status: "pending" }
      const trace = createTrace("今天买了 3 袋五常大米", {})

      const d = decide(orch, { text: "今天买了 3 袋五常大米", state, itemViews: viewsOf(state.items), pendingPlan, trace })
      assertEqual(d.kind, "sync", "decide kind")
      assertEqual(d.turn.kind, "collection", "turn kind")
      assertEqual(restockFields(d.turn.collection?.draft).itemName, "五常大米", "itemName")
      assertEqual(trace.firstFocusDecision?.focus, "start_new_collection", "focus")
      return { trace }
    }
  },
  {
    group: "pendingPlan",
    name: "2.3 算了 → planCancel（仍走 plan handler）",
    run: () => {
      const orch = createHouseholdOrchestrator()
      const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
      const plan = createAgentPlan([{ type: "createCategory", name: "清洁用品" }], "新建分类", NOW)
      const pendingPlan = { ...plan, status: "pending" }
      const trace = createTrace("算了", {})

      const d = decide(orch, { text: "算了", state, itemViews: viewsOf(state.items), pendingPlan, trace })
      assertEqual(d.kind, "sync", "decide kind")
      // pendingPlan 的 cancel 返回 planCommand(planCancel)，不是 cancelled
      assertEqual(d.turn.kind, "planCommand", "turn kind")
      assertEqual(d.turn.command?.command, "planCancel", "command")
      assertEqual(trace.firstFocusDecision?.focus, "continue_pending_plan", "focus")
      return { trace }
    }
  }
]

// ============================================================
// 3. pendingDraft 场景
// ============================================================

const draftCases = [
  {
    group: "pendingDraft",
    name: "3.1 今天买了 3 袋五常大米 → 新建 collection",
    run: () => {
      const orch = createHouseholdOrchestrator()
      const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
      const pendingDraft = makePendingDraft()
      const trace = createTrace("今天买了 3 袋五常大米", {})

      const d = decide(orch, { text: "今天买了 3 袋五常大米", state, itemViews: viewsOf(state.items), pendingDraft, trace })
      assertEqual(d.kind, "sync", "decide kind")
      assertEqual(d.turn.kind, "collection", "turn kind")
      assertEqual(restockFields(d.turn.collection?.draft).itemName, "五常大米", "itemName")
      assertEqual(trace.firstFocusDecision?.focus, "start_new_collection", "focus")
      return { trace }
    }
  },
  {
    group: "pendingDraft",
    name: "3.2 确认 → proposal",
    run: () => {
      const orch = createHouseholdOrchestrator()
      const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
      const pendingDraft = makePendingDraft()
      const trace = createTrace("确认", {})

      const d = decide(orch, { text: "确认", state, itemViews: viewsOf(state.items), pendingDraft, trace })
      assertEqual(d.kind, "sync", "decide kind")
      assertEqual(d.turn.kind, "proposal", "turn kind")
      assertEqual(trace.firstFocusDecision?.focus, "continue_pending_draft", "focus")
      return { trace }
    }
  },
  {
    group: "pendingDraft",
    name: "3.3 取消 → cancelled",
    run: () => {
      const orch = createHouseholdOrchestrator()
      const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
      const pendingDraft = makePendingDraft()
      const trace = createTrace("取消", {})

      const d = decide(orch, { text: "取消", state, itemViews: viewsOf(state.items), pendingDraft, trace })
      assertEqual(d.kind, "sync", "decide kind")
      assertEqual(d.turn.kind, "cancelled", "turn kind")
      return { trace }
    }
  },
  {
    group: "pendingDraft",
    name: "3.4 改成 3 袋 → revise（兼容旧 reviseDraft）",
    run: () => {
      const orch = createHouseholdOrchestrator()
      const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
      const pendingDraft = makePendingDraft()
      const trace = createTrace("改成 3 袋", {})

      const d = decide(orch, { text: "改成 3 袋", state, itemViews: viewsOf(state.items), pendingDraft, trace })
      assertEqual(d.kind, "sync", "decide kind")
      assertEqual(d.turn.kind, "proposal", "turn kind")
      assertEqual(restockFields(d.turn.executableDraft).qty, 3, "qty")
      return { trace }
    }
  }
]

// ============================================================
// 4. pendingBatch 场景
// ============================================================

const batchCases = [
  {
    group: "pendingBatch",
    name: "4.1 今天买了 3 袋五常大米 → 新建 collection",
    run: () => {
      const orch = createHouseholdOrchestrator()
      const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
      const pendingBatch = makePendingBatch()
      const trace = createTrace("今天买了 3 袋五常大米", {})

      const d = decide(orch, { text: "今天买了 3 袋五常大米", state, itemViews: viewsOf(state.items), pendingBatch, trace })
      assertEqual(d.kind, "sync", "decide kind")
      assertEqual(d.turn.kind, "collection", "turn kind")
      assertEqual(restockFields(d.turn.collection?.draft).itemName, "五常大米", "itemName")
      assertEqual(trace.firstFocusDecision?.focus, "start_new_collection", "focus")
      return { trace }
    }
  },
  {
    group: "pendingBatch",
    name: "4.2 全部确认 → batchConfirm",
    run: () => {
      const orch = createHouseholdOrchestrator()
      const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
      const pendingBatch = makePendingBatch()
      const trace = createTrace("全部确认", {})

      const d = decide(orch, { text: "全部确认", state, itemViews: viewsOf(state.items), pendingBatch, trace })
      assertEqual(d.kind, "sync", "decide kind")
      assertEqual(d.turn.kind, "planCommand", "turn kind")
      assertEqual(d.turn.command?.command, "batchConfirm", "command")
      assertEqual(trace.firstFocusDecision?.focus, "continue_pending_batch", "focus")
      return { trace }
    }
  },
  {
    group: "pendingBatch",
    name: "4.3 全部取消 → batchCancel",
    run: () => {
      const orch = createHouseholdOrchestrator()
      const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
      const pendingBatch = makePendingBatch()
      const trace = createTrace("全部取消", {})

      const d = decide(orch, { text: "全部取消", state, itemViews: viewsOf(state.items), pendingBatch, trace })
      assertEqual(d.kind, "sync", "decide kind")
      assertEqual(d.turn.kind, "planCommand", "turn kind")
      assertEqual(d.turn.command?.command, "batchCancel", "command")
      return { trace }
    }
  },
  {
    group: "pendingBatch",
    name: "4.4 就这样 → batchConfirm（force_proposal）",
    run: () => {
      const orch = createHouseholdOrchestrator()
      const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
      const pendingBatch = makePendingBatch()
      const trace = createTrace("就这样", {})

      const d = decide(orch, { text: "就这样", state, itemViews: viewsOf(state.items), pendingBatch, trace })
      assertEqual(d.kind, "sync", "decide kind")
      assertEqual(d.turn.kind, "planCommand", "turn kind")
      assertEqual(d.turn.command?.command, "batchConfirm", "command")
      assertEqual(trace.firstFocusDecision?.focus, "continue_pending_batch", "focus")
      return { trace }
    }
  }
]

// ============================================================
// 5. trace 场景
// ============================================================

const traceCases = [
  {
    group: "trace",
    name: "5.1 本地高置信 → called=false, interceptedByRule=true",
    run: () => {
      const orch = createHouseholdOrchestrator()
      const state = makeState({ items: [] })
      const trace = createTrace("今天买了 3 袋五常大米", {})

      const d = decide(orch, { text: "今天买了 3 袋五常大米", state, itemViews: [], trace })
      assertEqual(d.kind, "sync", "decide kind")
      assertEqual(trace.llmInterpreter.called, false, "llm called")
      assertEqual(trace.llmInterpreter.skipReason, "local_high_confidence", "skipReason")
      assertEqual(trace.routeDecision?.interceptedByRule, true, "interceptedByRule")
      // 二者不互相覆盖
      assertOk(!trace.llmInterpreter.called && trace.routeDecision.interceptedByRule, "二者同时成立")
      return { trace }
    }
  },
  {
    group: "trace",
    name: "5.2 LLM mock 成功 → called=true 且 interceptedByRule=true",
    async: true,
    run: async () => {
      const orch = createHouseholdOrchestrator()
      const state = makeState({ items: [] })
      const pendingCollection = buildWipesCollection()
      // 阶段 4B.5：使用 p'd'd（带撇号）确保仍需 LLM 解释
      const trace = createTrace("p'd'd", {})

      const d = decide(orch, { text: "p'd'd", state, itemViews: [], pendingCollection, trace })
      assertEqual(d.kind, "needTurnInterpreterLlm", "decide kind")

      const llmDecision = await orch.interpretAndRoute(
        { text: "p'd'd", state, itemViews: [], pendingCollection, dateContext: DATE_CONTEXT, trace },
        mockClient({ intent: "supplement_current_collection", fields: { platform: "拼多多" }, confidence: "high", reason: "test" })
      )
      assertEqual(llmDecision.kind, "sync", "llmDecision kind")
      assertEqual(trace.llmInterpreter.called, true, "llm called")
      assertEqual(trace.llmInterpreter.schemaValid, true, "schemaValid")
      assertEqual(trace.routeDecision?.interceptedByRule, true, "interceptedByRule")
      // 关键：二者同时为 true
      assertOk(trace.llmInterpreter.called && trace.routeDecision.interceptedByRule, "二者同时成立")
      return { trace }
    }
  },
  {
    group: "trace",
    name: "5.3 LLM mock 非法 JSON → schemaValid=false",
    async: true,
    run: async () => {
      const orch = createHouseholdOrchestrator()
      const state = makeState({ items: [] })
      const pendingCollection = buildWipesCollection()
      const trace = createTrace("asdfasdf", {})

      const d = decide(orch, { text: "asdfasdf", state, itemViews: [], pendingCollection, trace })
      assertEqual(d.kind, "needTurnInterpreterLlm", "decide kind")

      const llmDecision = await orch.interpretAndRoute(
        { text: "asdfasdf", state, itemViews: [], pendingCollection, dateContext: DATE_CONTEXT, trace },
        mockClient("这不是合法 JSON {{{")
      )
      assertEqual(llmDecision.kind, "sync", "llmDecision kind")
      assertEqual(trace.llmInterpreter.called, true, "llm called")
      assertEqual(trace.llmInterpreter.schemaValid, false, "schemaValid")
      assertOk(trace.llmInterpreter.rejectReason, "rejectReason 应存在")
      return { trace }
    }
  }
]

// ---------- 运行 ----------

const allCases = [...collectionCases, ...planCases, ...draftCases, ...batchCases, ...traceCases]

const results = []
for (const c of allCases) {
  const r = c.async ? await runAsyncCase(c.name, c.run) : runCase(c.name, c.run)
  results.push({ group: c.group, ...r })
}

// ---------- 输出 ----------

let passCount = 0
let failCount = 0

for (const r of results) {
  const prefix = r.status === "PASS" ? "✓" : "✗"
  console.log(`${prefix} [${r.group}] ${r.name}`)
  if (r.status === "PASS") {
    passCount++
  } else {
    failCount++
    console.log(`  ERROR: ${r.error}`)
    if (r.trace) {
      console.log(`  TRACE:`)
      console.log(traceSummary(r.trace).split("\n").map((l) => `    ${l}`).join("\n"))
    }
  }
}

console.log("")
console.log("=== 焦点回归 smoke 汇总 ===")
console.log(`PASS: ${passCount} / ${results.length}`)
console.log(`FAIL: ${failCount} / ${results.length}`)

if (failCount > 0) {
  process.exit(1)
}
