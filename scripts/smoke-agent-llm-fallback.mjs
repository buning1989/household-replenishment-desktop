#!/usr/bin/env node
// 阶段 2C 真实链路自动验收 smoke 脚本
// 运行方式：npm run smoke:agent-llm
//
// 不要求用户手动打开 DevTools。脚本走和 App dispatch 尽量一致的路径：
//   1. 构造真实 AppState + pendingCollection
//   2. 调用 orchestrator.decide(...)
//   3. 若 needTurnInterpreterLlm，调用 orchestrator.interpretAndRoute(...)（mock client）
//   4. 每个 case 输出 trace 摘要并对关键结果断言
//
// 8 个 case：
//   1. 拼夕夕 → platform=拼多多
//   2. PDD → platform=拼多多
//   3. p'd'd → platform=拼多多
//   4. asdfasdf → clarification
//   5. 猫砂还能用多久 → 不修改 collection
//   6. 今天买了 3 袋五常大米 → 新建 collection
//   7. 45块 → 本地 price=45
//   8. 这款猫砂品质不错，不起灰 → review 含「不起灰」
//
// 真实 API 模式（smoke:agent-llm:real）：尝试用真实 desktop bridge，
// 若 CLI 环境无 bridge，报告 REAL_LLM_SMOKE_SKIPPED 而非 passed。

import { registerHooks } from "node:module"

// 允许 import .ts 文件（与 tests/*.mjs 一致的 hook）
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

// 真实模式标志：smoke:agent-llm:real 传入
const USE_REAL_LLM = process.env.SMOKE_REAL_LLM === "1"

// ---------- 测试夹具 ----------

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

/** 从 AgentDraft 统一取出补货字段（兼容 restock / createItemWithRestock） */
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

/** 构造「宠物擦脚巾湿巾」采集态（state 无此物品 → createItemWithRestock，缺 platform/price） */
function buildWipesCollection() {
  const state = makeState({ items: [] })
  const draft = buildLocalDraftFromText("今天买了 5 包宠物擦脚巾湿巾", state)
  if (!draft) throw new Error("夹具构造失败：宠物擦脚巾湿巾 draft 为空")
  return createDraftCollection(draft, [], NOW)
}

/** 构造「猫砂」采集态（state 有此物品 → restock，缺 platform/price） */
function buildCatSandCollection() {
  const state = makeState({ items: [makeItem("i1", "猫砂", "宠物用品")] })
  const draft = buildLocalDraftFromText("今天买了 5 袋猫砂", state)
  if (!draft) throw new Error("夹具构造失败：猫砂 draft 为空")
  return createDraftCollection(draft, [], NOW)
}

// ---------- mock LLM client ----------

/** 平台别名集合 → 返回 platform=拼多多 */
const PDD_ALIASES = ["拼夕夕", "PDD", "pdd", "p'd'd", "多多", "拼西西", "pin duo duo"]

/** mock client：平台别名归一为拼多多；asdfasdf 等返回 unknown low */
function createMockClient() {
  return {
    async complete(prompt) {
      // 从 prompt 中提取用户输入（【用户这一轮输入】之后的段落）
      const userLine = prompt.match(/【用户这一轮输入】\n(.+)/s)
      const userInput = userLine ? userLine[1].trim() : prompt

      // 平台别名 → 拼多多
      if (PDD_ALIASES.some((alias) => userInput.toLowerCase().includes(alias.toLowerCase()))) {
        return JSON.stringify({
          intent: "supplement_current_collection",
          fields: { platform: "拼多多" },
          confidence: "high",
          reason: "这是拼多多的常见别名或缩写"
        })
      }

      // 无法理解
      if (/asdf|xxx|\?/.test(userInput)) {
        return JSON.stringify({
          intent: "unknown",
          fields: {},
          confidence: "low",
          reason: "无法判断用户要补充哪个字段"
        })
      }

      // 默认：unknown
      return JSON.stringify({
        intent: "unknown",
        fields: {},
        confidence: "low",
        reason: "mock client 默认无法理解"
      })
    }
  }
}

/** 真实 desktop bridge client：仅在 Electron 主世界可用 */
function createRealClient(state) {
  if (typeof window === "undefined" || !window.desktop?.chatComplete) return null
  const apiKey = state.settings?.aiApiKey
  if (!apiKey) return null
  return {
    async complete(prompt) {
      const separator = "=== 用户输入与上下文 ==="
      const sepIndex = prompt.indexOf(separator)
      const systemContent = sepIndex >= 0 ? prompt.slice(0, sepIndex).trim() : prompt
      const userContent = sepIndex >= 0 ? prompt.slice(sepIndex + separator.length).trim() : ""
      const messages = userContent
        ? [
            { role: "system", content: systemContent },
            { role: "user", content: userContent }
          ]
        : [{ role: "system", content: systemContent }]
      const result = await window.desktop.chatComplete({
        apiKey,
        model: state.settings?.aiChatModel || "qwen-plus",
        messages
      })
      if (!result?.ok) {
        throw new Error(typeof result?.error === "string" ? result.error : "real llm failed")
      }
      return result.content
    }
  }
}

// ---------- 单 case 执行 ----------

/**
 * 执行一个 smoke case，返回 { name, pass, summary, trace }。
 * summary 是按指定格式格式化的 trace 摘要。
 */
async function runCase(name, { text, state, itemViews, pendingCollection, expect }) {
  resetLastTraceForTest()

  const trace = createTrace(text, {
    collectionItemName: pendingCollection
      ? restockFields(pendingCollection.draft).itemName
      : undefined,
    collectionStatus: pendingCollection ? "pending" : undefined,
    missingFields: pendingCollection
      ? [...pendingCollection.requiredMissingSlots, ...pendingCollection.qualityMissingSlots]
      : undefined
  })

  const orch = createHouseholdOrchestrator()
  let decision = orch.decide({
    text,
    state,
    itemViews: itemViews ?? [],
    pendingCollection,
    dateContext: DATE_CONTEXT,
    trace
  })

  let llmCalled = false
  let llmClientMode = "none"

  if (decision.kind === "needTurnInterpreterLlm") {
    const client = USE_REAL_LLM ? createRealClient(state) : createMockClient()
    if (USE_REAL_LLM && !client) {
      // 真实模式但无 desktop bridge：跳过，不算 pass
      return {
        name,
        pass: null, // skipped
        summary: `CASE: ${name}\nresult: SKIP\nreason: REAL_LLM_SMOKE_SKIPPED: no desktop bridge`,
        trace
      }
    }
    llmCalled = true
    llmClientMode = USE_REAL_LLM ? "real" : "mock"
    const llmDecision = await orch.interpretAndRoute(
      {
        text,
        state,
        itemViews: itemViews ?? [],
        pendingCollection,
        dateContext: DATE_CONTEXT,
        trace
      },
      client
    )
    if (llmDecision.kind === "sync") {
      decision = llmDecision
    } else {
      decision = { kind: "needLlm", reason: llmDecision.reason }
    }
  }

  commitTrace(trace)

  // 评估 expect
  const errors = []
  try {
    expect({ decision, trace, restockFields })
  } catch (err) {
    errors.push(err.message)
  }

  const pass = errors.length === 0
  const summary = formatSummary(name, decision, trace, llmCalled, llmClientMode, errors)

  return { name, pass, summary, trace }
}

function formatSummary(name, decision, trace, llmCalled, llmClientMode, errors) {
  const lines = []
  lines.push(`CASE: ${name}`)
  lines.push(`result: ${errors.length === 0 ? "PASS" : "FAIL"}`)
  lines.push(`firstDecision: ${trace.decisionBeforeAppDispatch ?? "(未记录)"}`)
  lines.push(`localIntent: ${trace.localInterpretation?.intent ?? "(未记录)"}`)
  lines.push(`firstFocus: ${trace.firstFocusDecision?.focus ?? "(未记录)"}`)
  lines.push(`collectionFallbackTried: ${trace.collectionFallback?.tried ?? false}`)
  lines.push(`collectionFallbackProducedTurn: ${trace.collectionFallback?.producedTurn ?? false}`)
  lines.push(`llmCalled: ${llmCalled}`)
  lines.push(`llmClientMode: ${llmClientMode}`)
  if (trace.llmInterpreter) {
    lines.push(`llmRejected: ${trace.llmInterpreter.rejected ?? false}`)
    lines.push(`llmRejectReason: ${trace.llmInterpreter.rejectReason ?? "(无)"}`)
    const raw = trace.llmInterpreter.rawResponse
    lines.push(`rawResponse: ${raw ? raw.slice(0, 200) : "(未调用)"}`)
    lines.push(`normalizedIntent: ${trace.llmInterpreter.normalizedInterpretation?.intent ?? "(被拒绝或未解析)"}`)
    const fields = trace.llmInterpreter.normalizedInterpretation?.fields
    lines.push(`normalizedFields: ${fields ? JSON.stringify(fields) : "(无)"}`)
  }
  lines.push(`secondFocus: ${trace.secondFocusDecision?.focus ?? "(未进入二次路由)"}`)
  lines.push(`synthesizedInput: ${trace.synthesizedInput ?? "(无)"}`)
  const finalKind = decision.kind
  const finalTurnKind = decision.kind === "sync" ? decision.turn.kind : "(非 sync)"
  lines.push(`finalDecision: ${finalKind}`)
  lines.push(`finalTurn: ${finalTurnKind}`)
  const finalMessage =
    decision.kind === "sync" && "message" in decision.turn
      ? decision.turn.message.slice(0, 200)
      : "(无 message)"
  lines.push(`finalMessage: ${finalMessage}`)
  if (errors.length > 0) {
    lines.push(`errors:`)
    for (const e of errors) lines.push(`  - ${e}`)
  }
  return lines.join("\n")
}

// ---------- 8 个 case 定义 ----------

const cases = [
  {
    name: "拼夕夕",
    build: () => {
      const state = makeState({ items: [] })
      return { state, itemViews: [], pendingCollection: buildWipesCollection() }
    },
    expect: ({ decision, trace, restockFields: rf }) => {
      assertEqual(trace.decisionBeforeAppDispatch, "needTurnInterpreterLlm", "first decision")
      assertEqual(trace.llmInterpreter?.called, true, "llm called")
      assertEqual(trace.llmInterpreter?.rejected, false, "llm not rejected")
      assertEqual(
        trace.llmInterpreter?.normalizedInterpretation?.fields?.platform,
        "拼多多",
        "normalized platform"
      )
      assertEqual(trace.synthesizedInput, "拼多多", "synthesized input")
      assertEqual(decision.kind, "sync", "final decision kind")
      assertOk(
        decision.turn.kind === "collection" || decision.turn.kind === "proposal",
        `final turn kind 应为 collection/proposal, 实际: ${decision.turn.kind}`
      )
      const draft =
        decision.turn.kind === "collection"
          ? decision.turn.collection.draft
          : decision.turn.executableDraft
      assertEqual(rf(draft).platform, "拼多多", "draft.platform")
      assertOk(
        !decision.turn.message.includes("超出家务范围"),
        `message 不应包含「超出家务范围」, 实际: ${decision.turn.message}`
      )
    }
  },
  {
    name: "PDD",
    build: () => {
      const state = makeState({ items: [] })
      return { state, itemViews: [], pendingCollection: buildWipesCollection() }
    },
    expect: ({ decision, trace, restockFields: rf }) => {
      assertEqual(trace.llmInterpreter?.called, true, "llm called")
      assertEqual(trace.llmInterpreter?.rejected, false, "llm not rejected")
      assertEqual(
        trace.llmInterpreter?.normalizedInterpretation?.fields?.platform,
        "拼多多",
        "normalized platform"
      )
      assertEqual(decision.kind, "sync", "final decision kind")
      const draft =
        decision.turn.kind === "collection"
          ? decision.turn.collection.draft
          : decision.turn.executableDraft
      assertEqual(rf(draft).platform, "拼多多", "draft.platform")
    }
  },
  {
    name: "p'd'd",
    build: () => {
      const state = makeState({ items: [] })
      return { state, itemViews: [], pendingCollection: buildWipesCollection() }
    },
    expect: ({ decision, trace, restockFields: rf }) => {
      assertEqual(trace.llmInterpreter?.called, true, "llm called")
      assertEqual(trace.llmInterpreter?.rejected, false, "llm not rejected")
      assertEqual(
        trace.llmInterpreter?.normalizedInterpretation?.fields?.platform,
        "拼多多",
        "normalized platform"
      )
      assertEqual(decision.kind, "sync", "final decision kind")
      const draft =
        decision.turn.kind === "collection"
          ? decision.turn.collection.draft
          : decision.turn.executableDraft
      assertEqual(rf(draft).platform, "拼多多", "draft.platform")
    }
  },
  {
    name: "asdfasdf",
    build: () => {
      const state = makeState({ items: [] })
      return { state, itemViews: [], pendingCollection: buildWipesCollection() }
    },
    expect: ({ decision, trace }) => {
      assertEqual(trace.llmInterpreter?.called, true, "llm called")
      assertOk(
        trace.llmInterpreter?.rejected === true ||
          trace.llmInterpreter?.normalizedInterpretation?.intent === "unknown",
        "应被拒绝或 intent=unknown"
      )
      assertEqual(decision.kind, "sync", "final decision kind")
      assertEqual(decision.turn.kind, "clarification", "final turn kind")
      assertOk(
        !decision.turn.message.includes("超出家务范围"),
        `message 不应包含「超出家务范围」, 实际: ${decision.turn.message}`
      )
      assertOk(
        decision.turn.message.includes("宠物擦脚巾湿巾") || decision.turn.message.includes("记录"),
        `clarification 应询问是否补当前记录, 实际: ${decision.turn.message}`
      )
    }
  },
  {
    name: "猫砂还能用多久",
    build: () => {
      const catSand = makeItem("i1", "猫砂", "宠物用品")
      const state = makeState({ items: [catSand] })
      return {
        state,
        itemViews: viewsOf([catSand]),
        pendingCollection: buildCatSandCollection()
      }
    },
    expect: ({ decision, trace }) => {
      assertNotEqual(
        trace.firstFocusDecision?.focus,
        "route_to_llm",
        "查询不应进入 route_to_llm"
      )
      assertNotEqual(decision.kind, "needTurnInterpreterLlm", "查询不应进入 LLM interpreter")
      // 关键：不修改 collection（即不返回 sync collection/proposal 写入 platform/price/review）
      if (decision.kind === "sync") {
        assertOk(
          decision.turn.kind !== "collection" || decision.turn.collection === undefined,
          "查询不应产生新 collection"
        )
      }
    }
  },
  {
    name: "今天买了 3 袋五常大米",
    build: () => {
      const state = makeState({ items: [] })
      return { state, itemViews: [], pendingCollection: buildWipesCollection() }
    },
    expect: ({ decision, trace, restockFields: rf }) => {
      assertEqual(trace.firstFocusDecision?.focus, "start_new_collection", "focus")
      assertEqual(decision.kind, "sync", "decision kind")
      assertEqual(decision.turn.kind, "collection", "turn kind")
      const draft = decision.turn.collection.draft
      assertEqual(rf(draft).itemName, "五常大米", "itemName")
      assertOk(
        !decision.turn.message.includes("宠物擦脚巾湿巾"),
        `message 不应包含旧物品名, 实际: ${decision.turn.message}`
      )
    }
  },
  {
    name: "45块",
    build: () => {
      const state = makeState({ items: [] })
      return { state, itemViews: [], pendingCollection: buildWipesCollection() }
    },
    expect: ({ decision, trace, restockFields: rf }) => {
      assertNotEqual(trace.firstFocusDecision?.focus, "route_to_llm", "45块 不应 route_to_llm")
      // 阶段 3B.1：createTrace 默认初始化 llmInterpreter（called=false, skipReason=local_high_confidence）
      assertEqual(trace.llmInterpreter?.called, false, "45块 不应调用 LLM (called=false)")
      assertEqual(trace.llmInterpreter?.skipReason, "local_high_confidence", "45块 skipReason=local_high_confidence")
      assertEqual(decision.kind, "sync", "decision kind")
      const draft =
        decision.turn.kind === "collection"
          ? decision.turn.collection.draft
          : decision.turn.executableDraft
      assertEqual(rf(draft).price, 45, "price")
      assertEqual(rf(draft).itemName, "宠物擦脚巾湿巾", "itemName 不应变")
    }
  },
  {
    name: "这款猫砂品质不错，不起灰",
    build: () => {
      const catSand = makeItem("i1", "猫砂", "宠物用品")
      const state = makeState({ items: [catSand] })
      return {
        state,
        itemViews: viewsOf([catSand]),
        pendingCollection: buildCatSandCollection()
      }
    },
    expect: ({ decision, trace, restockFields: rf }) => {
      assertNotEqual(trace.firstFocusDecision?.focus, "route_to_llm", "长评价不应 route_to_llm")
      // 阶段 3B.1：createTrace 默认初始化 llmInterpreter（called=false, skipReason=local_high_confidence）
      assertEqual(trace.llmInterpreter?.called, false, "长评价不应调用 LLM (called=false)")
      assertEqual(trace.llmInterpreter?.skipReason, "local_high_confidence", "长评价 skipReason=local_high_confidence")
      assertEqual(decision.kind, "sync", "decision kind")
      const draft =
        decision.turn.kind === "collection"
          ? decision.turn.collection.draft
          : decision.turn.executableDraft
      const review = rf(draft).review
      assertOk(review, "review 不应为空")
      assertOk(
        review.includes("不起灰"),
        `review 应包含「不起灰」, 实际: ${review}`
      )
    }
  }
]

// ---------- 断言工具 ----------

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`[${label}] 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)}`)
  }
}

function assertNotEqual(actual, unexpected, label) {
  if (actual === unexpected) {
    throw new Error(`[${label}] 不应等于 ${JSON.stringify(unexpected)}, 但实际相等`)
  }
}

function assertOk(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

// ---------- 主流程 ----------

async function main() {
  console.log("=== Agent LLM Fallback Smoke (阶段 2C 真实链路自动验收) ===")
  console.log(`LLM 模式: ${USE_REAL_LLM ? "real" : "mock"}`)
  console.log(`时间: ${new Date().toISOString()}`)
  console.log("")

  let passCount = 0
  let failCount = 0
  let skipCount = 0
  const failures = []

  for (const c of cases) {
    try {
      const { state, itemViews, pendingCollection } = c.build()
      const result = await runCase(c.name, {
        text: c.name,
        state,
        itemViews,
        pendingCollection,
        expect: c.expect
      })
      console.log(result.summary)
      console.log("")
      if (result.pass === true) {
        passCount++
      } else if (result.pass === null) {
        skipCount++
      } else {
        failCount++
        failures.push({ name: c.name, trace: result.trace })
      }
    } catch (err) {
      failCount++
      console.log(`CASE: ${c.name}`)
      console.log(`result: FAIL (执行异常)`)
      console.log(`error: ${err.message}`)
      console.log("")
      failures.push({ name: c.name, trace: peekLastTrace() })
    }
  }

  console.log("=== 汇总 ===")
  console.log(`PASS: ${passCount} / ${cases.length}`)
  console.log(`FAIL: ${failCount} / ${cases.length}`)
  console.log(`SKIP: ${skipCount} / ${cases.length}`)

  if (failures.length > 0) {
    console.log("")
    console.log("=== 失败 case 完整 trace ===")
    for (const f of failures) {
      console.log(`\n--- ${f.name} ---`)
      console.log(JSON.stringify(f.trace, null, 2))
    }
  }

  process.exit(failCount > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error("smoke 脚本执行失败:", err)
  process.exit(2)
})
