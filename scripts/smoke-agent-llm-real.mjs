#!/usr/bin/env node
/**
 * 真实 LLM CLI smoke：验证 turnInterpreterLlm 真实链路（prompt / JSON / validator / repair）。
 *
 * 运行方式：npm run smoke:agent-llm:real
 *
 * 不依赖 Electron desktop bridge，直接 Node fetch 调用 DashScope 兼容接口。
 * 走 askTurnInterpreterLlm / interpretAndRoute 的真实 clientOverride，不重新写一套 prompt。
 *
 * API key 读取优先级：
 *   1. DASHSCOPE_API_KEY
 *   2. AI_API_KEY
 *   3. OPENAI_API_KEY
 *
 * 模型默认 qwen-plus，可通过 AI_CHAT_MODEL 覆盖。
 * 无 key 时输出 REAL_LLM_SMOKE_SKIPPED: no api key 并以非失败方式退出。
 */

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
const { resolveTurnInterpreterModel } = await import("../src/agent/turnInterpreterLlm.ts")
const {
  createTrace,
  commitTrace,
  resetLastTraceForTest
} = await import("../src/agent/agentDecisionTrace.ts")

const NOW = Date.UTC(2026, 6, 9) // 2026-07-09
const DATE_CONTEXT = buildChatDateContext(NOW)
const DASHSCOPE_ENDPOINT = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"

// ---------- 环境变量 ----------

function resolveApiKey() {
  return (
    process.env.DASHSCOPE_API_KEY?.trim() ||
    process.env.AI_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    ""
  )
}

function resolveModel() {
  // 优先用 AI_CHAT_MODEL 环境变量；否则用 resolveTurnInterpreterModel 逻辑
  const envModel = process.env.AI_CHAT_MODEL?.trim()
  if (envModel) return envModel
  return resolveTurnInterpreterModel({
    aiChatModel: undefined,
    aiModel: undefined
  })
}

// ---------- 真实 LLM client（Node fetch 直连 DashScope） ----------

function createRealFetchClient(apiKey, model) {
  return {
    async complete(prompt) {
      // 与 desktop client 一致：按 "=== 用户输入与上下文 ===" 拆分 system/user
      // repair prompt 无分隔符，整体作为 user 消息
      const separator = "=== 用户输入与上下文 ==="
      const sepIndex = prompt.indexOf(separator)
      let messages
      if (sepIndex >= 0) {
        const systemContent = prompt.slice(0, sepIndex).trim()
        const userContent = prompt.slice(sepIndex + separator.length).trim()
        messages = userContent
          ? [
              { role: "system", content: systemContent },
              { role: "user", content: userContent }
            ]
          : [{ role: "system", content: systemContent }]
      } else {
        messages = [{ role: "user", content: prompt }]
      }

      const response = await fetch(DASHSCOPE_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model || "qwen-plus",
          messages,
          temperature: 0.2
        })
      })

      if (!response.ok) {
        let detail = ""
        try {
          const errBody = await response.json()
          detail = errBody?.error?.message || errBody?.message || ""
        } catch { /* ignore */ }
        throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`)
      }

      const data = await response.json()
      const content = data?.choices?.[0]?.message?.content
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("LLM 返回空内容")
      }
      return content
    }
  }
}

// ---------- 测试夹具 ----------

function makeState(apiKey, model) {
  return {
    version: 3,
    categories: ["宠物用品", "卫生间", "其他"],
    items: [],
    settings: { aiApiKey: apiKey, aiChatModel: model },
    householdProfile: null,
    updatedAt: 1
  }
}

/** 构造「宠物擦脚巾湿巾」采集态（state 无此物品 → createItemWithRestock，缺 platform/price） */
function buildWipesCollection() {
  const state = makeState("", "")
  const draft = buildLocalDraftFromText("今天买了 5 包宠物擦脚巾湿巾", state)
  if (!draft) throw new Error("夹具构造失败：宠物擦脚巾湿巾 draft 为空")
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

// ---------- 单 case 执行 ----------

async function runCase(name, text, state, pendingCollection, client) {
  resetLastTraceForTest()

  const trace = createTrace(text, {
    collectionItemName: restockFields(pendingCollection.draft).itemName,
    collectionStatus: "pending",
    missingFields: [...pendingCollection.requiredMissingSlots, ...pendingCollection.qualityMissingSlots]
  })

  const orch = createHouseholdOrchestrator()
  let decision = orch.decide({
    text,
    state,
    itemViews: [],
    pendingCollection,
    dateContext: DATE_CONTEXT,
    trace
  })

  if (decision.kind !== "needTurnInterpreterLlm") {
    // 本地已决策（不应发生在 platform 别名场景，但兜底处理）
    commitTrace(trace)
    return { name, pass: false, summary: formatSummary(name, decision, trace, false), trace }
  }

  const llmDecision = await orch.interpretAndRoute(
    {
      text,
      state,
      itemViews: [],
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

  commitTrace(trace)
  return { name, pass: null, summary: formatSummary(name, decision, trace, true), trace, decision }
}

function formatSummary(name, decision, trace, llmCalled) {
  const lines = []
  lines.push(`CASE: ${name}`)
  lines.push(`result: ${decision.kind === "sync" ? "RESOLVED" : "NEED_LLM"}`)
  lines.push(`model: ${trace.llmInterpreter?.model ?? "(未记录)"}`)
  lines.push(`firstDecision: ${trace.decisionBeforeAppDispatch ?? "(未记录)"}`)
  lines.push(`localIntent: ${trace.localInterpretation?.intent ?? "(未记录)"}`)
  lines.push(`firstFocus: ${trace.firstFocusDecision?.focus ?? "(未记录)"}`)
  lines.push(`llmCalled: ${llmCalled}`)
  lines.push(`llmRejected: ${trace.llmInterpreter?.rejected ?? false}`)
  lines.push(`rejectReason: ${trace.llmInterpreter?.rejectReason ?? "(无)"}`)
  lines.push(`repairAttempted: ${trace.llmInterpreter?.repairAttempted ?? false}`)
  const raw = trace.llmInterpreter?.rawResponse
  lines.push(`rawResponse: ${raw ? raw.slice(0, 300) : "(未调用)"}`)
  const repairRaw = trace.llmInterpreter?.repairRawResponse
  lines.push(`repairRawResponse: ${repairRaw ? repairRaw.slice(0, 300) : "(未尝试)"}`)
  lines.push(`repairRejectReason: ${trace.llmInterpreter?.repairRejectReason ?? "(无)"}`)
  lines.push(`normalizedIntent: ${trace.llmInterpreter?.normalizedInterpretation?.intent ?? "(被拒绝或未解析)"}`)
  const fields = trace.llmInterpreter?.normalizedInterpretation?.fields
  lines.push(`normalizedFields: ${fields ? JSON.stringify(fields) : "(无)"}`)
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
  return lines.join("\n")
}

// ---------- 判定 ----------

function judge(name, decision, trace) {
  const llm = trace.llmInterpreter
  const errors = []

  if (!llm?.called) {
    errors.push("llmInterpreter.called 应为 true")
  }

  // Case 1-3：拼夕夕 / PDD / p'd'd
  if (["拼夕夕", "PDD", "p'd'd"].includes(name)) {
    if (llm?.normalizedInterpretation?.intent !== "supplement_current_collection") {
      errors.push(`normalizedIntent 应为 supplement_current_collection, 实际: ${llm?.normalizedInterpretation?.intent}`)
    }
    if (llm?.normalizedInterpretation?.fields?.platform !== "拼多多") {
      errors.push(`normalizedFields.platform 应为 拼多多, 实际: ${llm?.normalizedInterpretation?.fields?.platform}`)
    }
    if (trace.synthesizedInput !== "拼多多") {
      errors.push(`synthesizedInput 应为 拼多多, 实际: ${trace.synthesizedInput}`)
    }
    if (decision.kind === "sync") {
      const draft =
        decision.turn.kind === "collection"
          ? decision.turn.collection?.draft
          : decision.turn.executableDraft
      if (draft && restockFields(draft).platform !== "拼多多") {
        errors.push(`final draft.platform 应为 拼多多, 实际: ${restockFields(draft).platform}`)
      }
      if (decision.turn.message?.includes("超出家务范围")) {
        errors.push("final message 不应包含「超出家务范围」")
      }
    } else {
      errors.push(`final decision 应为 sync, 实际: ${decision.kind}`)
    }
  }

  // Case 4-5：你知道 p'd'd / 你知道拼夕夕么
  if (["你知道 p'd'd", "你知道拼夕夕么"].includes(name)) {
    if (decision.kind !== "sync") {
      errors.push(`final decision 应为 sync, 实际: ${decision.kind}`)
    } else {
      if (decision.turn.message?.includes("超出家务范围")) {
        errors.push("final message 不应包含「超出家务范围」")
      }
    }
    // 可接受：高置信 platform=拼多多，或中置信 clarification
    // 不接受：llmInterpreter.called = false
    if (!llm?.called) {
      errors.push("llmInterpreter.called 应为 true")
    }
  }

  // Case 6：asdfasdf
  if (name === "asdfasdf") {
    if (!llm?.called) {
      errors.push("llmInterpreter.called 应为 true")
    }
    if (decision.kind !== "sync" || decision.turn.kind !== "clarification") {
      errors.push(`final turn 应为 clarification, 实际: ${decision.kind === "sync" ? decision.turn.kind : decision.kind}`)
    }
    if (decision.kind === "sync" && decision.turn.message?.includes("超出家务范围")) {
      errors.push("final message 不应包含「超出家务范围」")
    }
    // 应有 rejectReason 或 intent=unknown
    const hasReject = Boolean(llm?.rejectReason)
    const isUnknown = llm?.normalizedInterpretation?.intent === "unknown"
    if (!hasReject && !isUnknown) {
      errors.push("应有 rejectReason 或 normalizedIntent=unknown")
    }
  }

  return errors
}

// ---------- 主流程 ----------

async function main() {
  const apiKey = resolveApiKey()
  const model = resolveModel()

  console.log("=== Agent LLM Real Smoke（真实链路验收）===")
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`model: ${model}`)

  if (!apiKey) {
    console.log("")
    console.log("REAL_LLM_SMOKE_SKIPPED: no api key")
    console.log("请设置 DASHSCOPE_API_KEY / AI_API_KEY / OPENAI_API_KEY 环境变量后重试。")
    process.exit(0)
  }

  console.log(`apiKey: ${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`)
  console.log("")

  const client = createRealFetchClient(apiKey, model)
  const state = makeState(apiKey, model)
  const pendingCollection = buildWipesCollection()

  const cases = [
    "拼夕夕",
    "PDD",
    "p'd'd",
    "你知道 p'd'd",
    "你知道拼夕夕么",
    "asdfasdf"
  ]

  let passCount = 0
  let failCount = 0
  const results = []

  for (const text of cases) {
    try {
      const { summary, trace, decision } = await runCase(text, text, state, pendingCollection, client)
      const errors = judge(text, decision, trace)
      const pass = errors.length === 0
      if (pass) {
        passCount++
      } else {
        failCount++
      }
      // 在 summary 顶部替换 result 行
      const judgedSummary = summary.replace(
        /^CASE: .+\nresult: .+$/,
        `CASE: ${text}\nresult: ${pass ? "PASS" : "FAIL"}`
      )
      const fullSummary = pass
        ? judgedSummary
        : `${judgedSummary}\nerrors:\n${errors.map((e) => `  - ${e}`).join("\n")}`
      console.log(fullSummary)
      console.log("")
      results.push({ name: text, pass, summary: fullSummary, trace })
    } catch (err) {
      failCount++
      console.log(`CASE: ${text}`)
      console.log(`result: FAIL (执行异常)`)
      console.log(`error: ${err.message}`)
      console.log("")
      results.push({ name: text, pass: false, summary: `error: ${err.message}`, trace: null })
    }
  }

  console.log("=== 汇总 ===")
  console.log(`PASS: ${passCount} / ${cases.length}`)
  console.log(`FAIL: ${failCount} / ${cases.length}`)
  console.log(`model: ${model}`)

  if (failCount > 0) {
    console.log("")
    console.log("=== 失败 case 完整 trace ===")
    for (const r of results) {
      if (!r.pass && r.trace) {
        console.log(`\n--- ${r.name} ---`)
        console.log(JSON.stringify(r.trace, null, 2))
      }
    }
  }

  process.exit(failCount > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error("smoke 脚本执行失败:", err)
  process.exit(2)
})
