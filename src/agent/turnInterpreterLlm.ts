/**
 * LLM Turn Interpreter（阶段 2C）
 *
 * 当本地 turnInterpretation 无法高置信解释用户输入（intent=unknown、低置信、
 * 平台别名如「拼夕夕/pdd/p'd'd」、指代如「上次那个平台」等）时，调用本模块让大模型
 * 结合当前 pendingCollection 重新做一次结构化理解。
 *
 * 关键约束：
 *   1. 只返回结构化 TurnInterpretation，不返回对话文案、不 commit、不生成 proposal、
 *      不执行 action。所有写入仍走 DraftCollection / Proposal / Confirm / Executor。
 *   2. 删除类二次确认不允许被 LLM 绕过（本模块不处理 pendingPlan 高风险删除）。
 *   3. 低置信 / 解析失败 / 与 pendingCollection 冲突但 reason 不清时，返回 null，
 *      由调用方转 clarification，禁止直接写入 collection。
 *
 * 本模块通过注入 TurnInterpreterLlmClient 实现：单测传入 mock client，
 * 真实运行时由 createDesktopTurnInterpreterLlmClient 接 window.desktop.chatComplete。
 */

import type { AppState } from "../types"
import type { ChatDateContext, HouseholdChatItemView } from "../llm/householdChat"
import type { AgentDraft } from "./drafts"
import type { DraftCollection } from "./draftCollection"
import type { AgentPlan } from "./actions"
import type { TurnInterpretation, TurnIntent } from "./turnInterpretation"
import type { AgentDecisionTrace } from "./agentDecisionTrace"

/**
 * LLM 客户端抽象。complete(prompt) 返回原始文本（应是 JSON）。
 * 单测传入 mock；真实运行时由 createDesktopTurnInterpreterLlmClient 构造。
 */
export type TurnInterpreterLlmClient = {
  complete(prompt: string): Promise<string>
}

/** askTurnInterpreterLlm 的输入。 */
export type AskTurnInterpreterLlmInput = {
  text: string
  pendingCollection?: DraftCollection
  pendingDraft?: AgentDraft
  pendingPlan?: AgentPlan
  pendingBatch?: AgentDraft[]
  state: AppState
  itemViews: HouseholdChatItemView[]
  dateContext: ChatDateContext
  /** 可注入的 LLM 客户端；单测传 mock，真实运行时由内部构造 */
  client?: TurnInterpreterLlmClient
  /** dev-only trace：记录调用过程，便于诊断真实链路断点 */
  trace?: AgentDecisionTrace
}

/** LLM 允许返回的 intent 子集（比本地 TurnIntent 窄，去除 force_proposal 等）。 */
export type LlmTurnIntent =
  | "supplement_current_collection"
  | "correct_current_collection"
  | "new_restock_record"
  | "confirm_current_task"
  | "cancel_current_task"
  | "query_inventory"
  | "query_current_pending"
  | "smalltalk"
  | "unknown"

/** LLM 返回的 JSON 结构。 */
export type LlmTurnInterpretation = {
  intent: LlmTurnIntent
  fields: {
    itemName?: string
    quantity?: number
    unit?: string
    date?: string
    price?: number
    platform?: string
    review?: string
    /** 阶段 4B.6：query_current_pending 时，用户想查的字段 */
    targetField?: "price" | "platform" | "qty" | "status" | "date" | "summary"
  }
  confidence: "high" | "medium" | "low"
  reason: string
}

const VALID_LLM_INTENTS: ReadonlySet<LlmTurnIntent> = new Set([
  "supplement_current_collection",
  "correct_current_collection",
  "new_restock_record",
  "confirm_current_task",
  "cancel_current_task",
  "query_inventory",
  "query_current_pending",
  "smalltalk",
  "unknown"
])

/**
 * 解析 Turn Interpreter 应使用的模型。
 *
 * 规则：
 *   1. 优先使用 aiChatModel（明确的文本对话模型）
 *   2. aiChatModel 为空时，若 aiModel 不含视觉模型关键词（vl/vision/视觉），可用 aiModel
 *   3. 否则默认 qwen-plus
 *
 * 关键修复：aiModel 可能是视觉模型（如 qwen3-vl-plus），视觉模型做纯文本 JSON interpreter
 * 表现不稳定，不允许作为 turnInterpreter model。
 */
export function resolveTurnInterpreterModel(settings?: {
  aiChatModel?: string
  aiModel?: string
}): string {
  const chatModel = settings?.aiChatModel?.trim()
  if (chatModel) return chatModel

  const fallback = settings?.aiModel?.trim()
  if (fallback && !/vl|vision|视觉/i.test(fallback)) return fallback

  return "qwen-plus"
}

/**
 * 调用 LLM 解释当前这一轮输入，返回结构化 TurnInterpretation 或 null。
 *
 * 返回 null 的情况（调用方应转 clarification）：
 *   - LLM 调用失败
 *   - JSON 解析失败（含一次 repair retry 后仍失败）
 *   - intent 不合法
 *   - confidence = "low"
 *   - intent = unknown
 *   - intent = supplement_current_collection 但 fields 为空
 *
 * 不返回 null 时，结果已 normalize 为 TurnInterpretation（含 signals/reason），
 * 可直接交给 resolveConversationFocus 二次路由。
 */
export async function askTurnInterpreterLlm(
  input: AskTurnInterpreterLlmInput
): Promise<TurnInterpretation | null> {
  const trace = input.trace
  const apiKey = input.state.settings?.aiApiKey?.trim()
  const model = resolveTurnInterpreterModel(input.state.settings)
  // provider：mock client（测试注入）→ "mock"；desktop bridge → "desktop"
  const provider = input.client ? "mock" : "desktop"

  // 填充 trace.llmInterpreter 起始状态
  if (trace) {
    trace.llmInterpreter = {
      shouldCall: true,
      called: false,
      hasApiKey: Boolean(apiKey),
      model: model || "(default qwen-plus)",
      provider
    }
  }

  const client = input.client ?? createDesktopTurnInterpreterLlmClient(input.state, model)
  if (!client) {
    if (trace) {
      trace.llmInterpreter!.called = false
      trace.llmInterpreter!.rejected = true
      // 阶段 3B.1：同时记录 skipReason（明确未调用原因）和 rejectReason（业务拒绝）
      const skipReason = !apiKey ? "no_api_key" : "no_desktop_bridge"
      trace.llmInterpreter!.skipReason = skipReason
      trace.llmInterpreter!.rejectReason = skipReason
    }
    return null
  }

  const prompt = buildInterpreterPrompt(input)
  if (trace) {
    trace.llmInterpreter!.promptPreview = prompt.slice(0, 500)
    trace.llmInterpreter!.called = true
    // 进入真实调用，清除 skipReason
    trace.llmInterpreter!.skipReason = undefined
  }

  const startTime = Date.now()
  let raw: string
  try {
    raw = await client.complete(prompt)
  } catch (err) {
    if (trace) {
      const errMsg = err instanceof Error ? err.message : String(err)
      trace.llmInterpreter!.durationMs = Date.now() - startTime
      trace.llmInterpreter!.rejected = true
      // 阶段 3B.1：error 是 client 抛异常；rejectReason 是业务拒绝（保持兼容）
      trace.llmInterpreter!.error = errMsg
      trace.llmInterpreter!.rejectReason = `client_exception: ${errMsg}`
    }
    return null
  }

  if (trace) {
    trace.llmInterpreter!.durationMs = Date.now() - startTime
    trace.llmInterpreter!.rawResponse = typeof raw === "string" ? raw.slice(0, 2000) : String(raw).slice(0, 2000)
  }

  // 第一次解析 + 校验
  const firstAttempt = parseAndValidateTurnInterpretation(raw, trace)
  if (trace) {
    // schemaValid：JSON 解析 + schema 校验是否通过
    trace.llmInterpreter!.schemaValid = firstAttempt.parsed !== null
  }
  if (firstAttempt.parsed) {
    const rejected = rejectIfNeeded(firstAttempt.parsed, trace)
    if (!rejected) {
      const normalized = normalizeLlmInterpretation(firstAttempt.parsed)
      if (trace) {
        trace.llmInterpreter!.normalizedInterpretation = normalized
        trace.llmInterpreter!.rejected = false
      }
      return normalized
    }
    // rejected（low / unknown / empty_fields）→ 不再 repair，直接 null
    return null
  }

  // 第一次解析失败 → 尝试一次 repair retry
  const repairable = isRepairable(firstAttempt.rejectReason)
  if (!repairable) {
    if (trace) {
      trace.llmInterpreter!.rejected = true
      trace.llmInterpreter!.rejectReason = firstAttempt.rejectReason
    }
    return null
  }

  if (trace) {
    trace.llmInterpreter!.repairAttempted = true
  }

  let repairRaw: string
  try {
    repairRaw = await client.complete(buildRepairPrompt(raw, firstAttempt.rejectReason ?? "json_parse_failed", input))
  } catch (err) {
    if (trace) {
      const errMsg = err instanceof Error ? err.message : String(err)
      trace.llmInterpreter!.rejected = true
      trace.llmInterpreter!.error = `repair: ${errMsg}`
      trace.llmInterpreter!.rejectReason = `repair_client_exception: ${errMsg}`
      trace.llmInterpreter!.repairRejectReason = `client_exception`
    }
    return null
  }

  if (trace) {
    trace.llmInterpreter!.repairRawResponse = typeof repairRaw === "string" ? repairRaw.slice(0, 2000) : String(repairRaw).slice(0, 2000)
  }

  const repairAttempt = parseAndValidateTurnInterpretation(repairRaw, trace)
  if (trace) {
    trace.llmInterpreter!.repairParsed = repairAttempt.parsed
    // repair 成功则 schemaValid 更新为 true
    if (repairAttempt.parsed) {
      trace.llmInterpreter!.schemaValid = true
    }
  }
  if (!repairAttempt.parsed) {
    if (trace) {
      trace.llmInterpreter!.rejected = true
      trace.llmInterpreter!.rejectReason = repairAttempt.rejectReason
      trace.llmInterpreter!.repairRejectReason = repairAttempt.rejectReason
    }
    return null
  }

  // repair 成功解析，再做一次 reject 检查
  const repairRejected = rejectIfNeeded(repairAttempt.parsed, trace)
  if (repairRejected) {
    if (trace) {
      trace.llmInterpreter!.repairRejectReason = trace.llmInterpreter!.rejectReason
    }
    return null
  }

  const normalized = normalizeLlmInterpretation(repairAttempt.parsed)
  if (trace) {
    trace.llmInterpreter!.normalizedInterpretation = normalized
    trace.llmInterpreter!.rejected = false
  }
  return normalized
}

/**
 * 解析 + 校验 LLM 返回，返回 { parsed, rejectReason }。
 * rejectReason 表示「解析/校验失败的原因」，不包含 low/unknown/empty_fields 等业务拒绝（那些由 rejectIfNeeded 处理）。
 */
function parseAndValidateTurnInterpretation(
  raw: string,
  trace: AgentDecisionTrace | undefined
): { parsed: LlmTurnInterpretation | null; rejectReason?: string } {
  const parsed = parseLlmTurnInterpretation(raw)
  if (!parsed) return { parsed: null, rejectReason: "json_parse_failed" }

  // validator 已在 parseLlmTurnInterpretation 内放宽：fields 缺失→{}，confidence 缺失→medium
  // 这里只记录 warning（如果有的话）
  if (trace && trace.llmInterpreter && !trace.llmInterpreter.validationWarning) {
    // parseLlmTurnInterpretation 不直接返回 warning，通过检查 raw 是否缺 confidence 来推断
    // 简化：validateLlmTurnInterpretation 已在内部处理，这里不重复推断
  }
  return { parsed }
}

/**
 * 业务拒绝检查：low confidence / unknown / supplement 空 fields。
 * 返回 true 表示被拒绝（trace 已记录 rejectReason）。
 */
function rejectIfNeeded(
  parsed: LlmTurnInterpretation,
  trace: AgentDecisionTrace | undefined
): boolean {
  if (parsed.confidence === "low") {
    if (trace) {
      trace.llmInterpreter!.rejected = true
      trace.llmInterpreter!.rejectReason = "confidence_low"
    }
    return true
  }
  if (parsed.intent === "unknown") {
    if (trace) {
      trace.llmInterpreter!.rejected = true
      trace.llmInterpreter!.rejectReason = "intent_unknown"
    }
    return true
  }
  if (
    parsed.intent === "supplement_current_collection" &&
    Object.keys(parsed.fields).length === 0
  ) {
    if (trace) {
      trace.llmInterpreter!.rejected = true
      trace.llmInterpreter!.rejectReason = "supplement_with_empty_fields"
    }
    return true
  }
  return false
}

/** 判断 rejectReason 是否允许 repair retry。 */
function isRepairable(rejectReason: string | undefined): boolean {
  if (!rejectReason) return false
  return [
    "json_parse_failed",
    "invalid_schema",
    "missing_fields_object",
    "confidence_missing"
  ].includes(rejectReason)
  // 注意：supplement_with_empty_fields 不在可 repair 列表——空 fields 是业务判断，repair 也不会变
}

/**
 * 构造 repair prompt：告知模型上一次输出无法解析，要求只输出合法 JSON。
 */
function buildRepairPrompt(
  rawResponse: string,
  rejectReason: string,
  input: AskTurnInterpreterLlmInput
): string {
  const lines: string[] = []
  lines.push("你上一轮的输出无法被系统解析，需要重新输出。")
  lines.push("")
  lines.push("【上一次输出】")
  lines.push(rawResponse.slice(0, 1000))
  lines.push("")
  lines.push("【失败原因】")
  lines.push(rejectReason)
  lines.push("")
  lines.push("【合法 JSON schema】")
  lines.push('{')
  lines.push('  "intent": "supplement_current_collection | correct_current_collection | new_restock_record | confirm_current_task | cancel_current_task | query_current_pending | query_inventory | smalltalk | unknown",')
  lines.push('  "fields": {')
  lines.push('    "itemName": "可选",')
  lines.push('    "quantity": "可选，数字",')
  lines.push('    "unit": "可选",')
  lines.push('    "date": "可选",')
  lines.push('    "price": "可选，数字",')
  lines.push('    "platform": "可选，归一后的标准平台名",')
  lines.push('    "review": "可选",')
  lines.push('    "targetField": "可选，query_current_pending 时填：price | platform | qty | status | date | summary"')
  lines.push('  },')
  lines.push('  "confidence": "high | medium | low",')
  lines.push('  "reason": "一句话说明"')
  lines.push('}')
  lines.push("")
  lines.push("【绝对规则】")
  lines.push("1. 只输出一个 JSON 对象，不要输出任何其他文字。")
  lines.push("2. 不要用 markdown 代码块包裹。")
  lines.push("3. 第一个字符必须是 `{`，最后一个字符必须是 `}`。")
  lines.push("")
  lines.push("【当前正在采集的补货记录】")
  if (input.pendingCollection) {
    const f = describeCollectionDraft(input.pendingCollection)
    lines.push(`物品名：${f.itemName ?? "（未定）"}`)
    const missing = [...input.pendingCollection.requiredMissingSlots, ...input.pendingCollection.qualityMissingSlots]
    lines.push(`当前缺失字段：${missing.length > 0 ? missing.join("、") : "（无）"}`)
  } else {
    lines.push("（无）")
  }
  lines.push("")
  lines.push("【用户这一轮输入】")
  lines.push(input.text)
  lines.push("")
  lines.push("只输出 JSON 对象。")
  return lines.join("\n")
}

/**
 * 构造给 LLM 的解释 prompt。明确告诉模型：你在解释用户这一轮输入，不是在聊天回复。
 *
 * Prompt 分两段：
 *   1. system 段：任务定义 + JSON 输出绝对规则 + 别名归一化规则 + JSON schema
 *   2. user 段：当前 pendingCollection 上下文 + 用户这一轮输入
 *
 * system 段在 buildSystemPrompt()，user 段在 buildUserPrompt()。
 * 实际发送给 client 时合并为一条 prompt 字符串（client 实现决定如何分消息）。
 */
function buildInterpreterPrompt(input: AskTurnInterpreterLlmInput): string {
  const systemPrompt = buildSystemPrompt(input)
  const userPrompt = buildUserPrompt(input)
  return `${systemPrompt}\n\n=== 用户输入与上下文 ===\n${userPrompt}`
}

/** system 段：固定规则。 */
function buildSystemPrompt(input: AskTurnInterpreterLlmInput): string {
  const lines: string[] = []

  lines.push("你是一个家庭补货记录采集助手。你不是在聊天回复用户，而是在解释用户这一轮输入的真实意图。")
  lines.push("")

  // 绝对 JSON 输出规则——必须放在最显眼位置，qwen-plus 等模型容易忽略
  lines.push("【绝对规则】")
  lines.push("1. 只输出一个 JSON 对象。")
  lines.push("2. 不要输出任何其他文字：不要解释、不要问候、不要寒暄、不要说「好的」「这是结果」。")
  lines.push("3. 不要用 markdown 代码块包裹（不要写 ```json 或 ```）。")
  lines.push("4. 第一个字符必须是 `{`，最后一个字符必须是 `}`。")
  lines.push("5. 违反以上规则的输出将被系统丢弃，导致用户看到追问而不是结果。")
  lines.push("")

  lines.push("【任务】")
  lines.push("结合当前正在采集的补货记录，判断用户这一轮输入属于以下哪一类：")
  lines.push("- supplement_current_collection：补当前草稿字段（平台/价格/评价/数量/日期等）")
  lines.push("- correct_current_collection：修正当前草稿（如「不是 X，是 Y」改物品名）")
  lines.push("- new_restock_record：开启一条全新的补货记录（物品名与当前不同，且含「又买了/另外买了」等新增信号）")
  lines.push("- confirm_current_task：确认保存当前记录")
  lines.push("- cancel_current_task：取消当前记录")
  lines.push("- query_current_pending：问当前待确认草稿的字段（如「花了多少钱」「哪个平台」「几袋」「记了没」）")
  lines.push("- query_inventory：查询库存/还能用多久（与当前草稿无关的库存查询）")
  lines.push("- smalltalk：闲聊/寒暄/身份问题")
  lines.push("- unknown：确实无法判断")
  lines.push("")

  lines.push("【query_current_pending 判定规则】")
  lines.push("当存在待确认草稿时，以下输入应判为 query_current_pending（不是 new_restock_record）：")
  lines.push("- 「我花了多少钱买的这 5 袋猫砂」→ targetField=price")
  lines.push("- 「这 5 袋猫砂哪个平台买的」→ targetField=platform")
  lines.push("- 「你记的是几袋猫砂」→ targetField=qty")
  lines.push("- 「猫砂那条还没记上吗」→ targetField=status")
  lines.push("- 「刚才那条猫砂多少钱来着」→ targetField=price")
  lines.push("关键：含疑问词（多少钱/哪个/几袋/来着/记了没）+ 指代当前草稿物品 → query_current_pending")
  lines.push("只有明确说「又买了/另外买了/今天买了 X」且物品不同时才判 new_restock_record。")
  lines.push("")

  lines.push("【平台别名归一化规则】")
  lines.push("如果用户输入是平台或平台别名，把 platform 归一为标准名：")
  lines.push("- 拼夕夕 / pdd / p'd'd / 多多 / PDD / Pdd → 拼多多")
  lines.push("- 狗东 / 东哥 / jd / JD → 京东")
  lines.push("- 淘系 / 某宝 / tb → 淘宝")
  lines.push("- 天猫 / tmall → 天猫")
  lines.push("注意：不要只依赖这几条示例，遇到其他平台别名也尽量归一。")
  lines.push("")

  lines.push("【指代消解规则】")
  lines.push("- 「上次那个平台 / 还是上次买的那个 / 就之前那家」→ 取该物品历史中最近一次的平台")
  lines.push("- 「比上次便宜 / 这次贵了点」→ 仍是 supplement_current_collection，reason 说明价格对比意图")
  lines.push("")

  lines.push("【输出 JSON schema】")
  lines.push("第一个字符必须是 `{`，最后一个字符必须是 `}`。schema：")
  lines.push('{')
  lines.push('  "intent": "supplement_current_collection | correct_current_collection | new_restock_record | confirm_current_task | cancel_current_task | query_current_pending | query_inventory | smalltalk | unknown",')
  lines.push('  "fields": {')
  lines.push('    "itemName": "可选，物品名",')
  lines.push('    "quantity": "可选，数字",')
  lines.push('    "unit": "可选，单位",')
  lines.push('    "date": "可选，日期",')
  lines.push('    "price": "可选，数字",')
  lines.push('    "platform": "可选，归一后的标准平台名",')
  lines.push('    "review": "可选，评价原文",')
  lines.push('    "targetField": "可选，query_current_pending 时填：price | platform | qty | status | date | summary"')
  lines.push('  },')
  lines.push('  "confidence": "high | medium | low",')
  lines.push('  "reason": "一句话说明判断依据"')
  lines.push('}')
  lines.push("只填入能确定的字段，不确定的字段不要硬编造。")
  lines.push("")

  return lines.join("\n")
}

/** user 段：当前上下文 + 用户输入。 */
function buildUserPrompt(input: AskTurnInterpreterLlmInput): string {
  const { text, pendingCollection, pendingDraft, pendingPlan, pendingBatch, state, itemViews, dateContext } = input
  const lines: string[] = []

  lines.push("【当前时间】")
  lines.push(`今天是 ${dateContext.todayLabel}，当前时间 ${dateContext.timestampLabel}，时区 ${dateContext.timezone}。`)
  lines.push("")

  // 阶段 4B.6：统一展示所有 active pending 上下文
  const hasAnyPending = pendingCollection || pendingDraft || (pendingBatch && pendingBatch.length > 0) ||
    (pendingPlan && (pendingPlan.status === "pending" || pendingPlan.status === "awaitingSecondConfirm"))

  if (hasAnyPending) {
    lines.push("【当前待确认的记录（尚未正式写入）】")

    if (pendingDraft) {
      const f = describeDraftFields(pendingDraft)
      lines.push(`- 待确认草稿：${f.itemName ?? "（未定）"}`)
      if (f.qty !== undefined) lines.push(`  数量：${f.qty}${f.unit ?? ""}`)
      if (f.platform) lines.push(`  平台：${f.platform}`)
      if (f.price !== undefined) lines.push(`  价格：¥${f.price}`)
      if (f.restockDate !== undefined) lines.push(`  日期：${formatTimestamp(f.restockDate, dateContext)}`)
      lines.push(`  状态：待确认，尚未正式保存`)
    }

    if (pendingCollection) {
      const f = describeCollectionDraft(pendingCollection)
      lines.push(`- 采集中的记录：${f.itemName ?? "（未定）"}`)
      if (f.qty !== undefined) lines.push(`  数量：${f.qty}${f.unit ?? ""}`)
      if (f.platform) lines.push(`  平台：${f.platform}`)
      if (f.price !== undefined) lines.push(`  价格：¥${f.price}`)
      if (f.review) lines.push(`  评价：${f.review}`)
      const missing = [...pendingCollection.requiredMissingSlots, ...pendingCollection.qualityMissingSlots]
      lines.push(`  当前缺失字段：${missing.length > 0 ? missing.join("、") : "（无）"}`)
    }

    if (pendingBatch && pendingBatch.length > 0) {
      lines.push(`- 批量待确认：${pendingBatch.length} 条草稿`)
    }

    if (pendingPlan && (pendingPlan.status === "pending" || pendingPlan.status === "awaitingSecondConfirm")) {
      lines.push(`- 待确认计划：${pendingPlan.actions.length} 个动作（${pendingPlan.sourceText.slice(0, 30)}）`)
    }
  } else {
    lines.push("【当前待确认的记录】")
    lines.push("（无正在采集或待确认的记录）")
  }
  lines.push("")

  lines.push("【该物品的历史补货平台（用于指代消解）】")
  const historyPlatforms = collectHistoryPlatforms(pendingCollection ?? (pendingDraft ? toDraftCollection(pendingDraft) : undefined), state, itemViews)
  if (historyPlatforms.length > 0) {
    lines.push(historyPlatforms.join("、"))
  } else {
    lines.push("（无历史平台记录）")
  }
  lines.push("")

  lines.push("【用户这一轮输入】")
  lines.push(text)
  lines.push("")
  lines.push("只输出 JSON 对象，第一个字符是 `{`，最后一个字符是 `}`。")

  return lines.join("\n")
}

/** 阶段 4B.6：把 pendingDraft 包装成 DraftCollection 供 collectHistoryPlatforms 复用。 */
function toDraftCollection(draft: AgentDraft): DraftCollection | undefined {
  const itemName = draft.kind === "restock" ? draft.itemName : draft.kind === "createItemWithRestock" ? draft.item.itemName : undefined
  if (!itemName) return undefined
  // 只需 draft 字段供 collectHistoryPlatforms 提取 itemName
  return { kind: "draftCollection", draft, requiredMissingSlots: [], qualityMissingSlots: [], inferredSuggestions: [], turns: 0, completeness: "readyToConfirm", updatedAt: 0 }
}

/** 阶段 4B.6：把时间戳格式化为可读日期。 */
function formatTimestamp(ts: number, dateContext: ChatDateContext): string {
  if (dateContext.now && Math.abs(ts - dateContext.now) < 24 * 60 * 60 * 1000) return "今天"
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

/** 从 collection draft 中取出可读字段。 */
function describeCollectionDraft(collection: DraftCollection): {
  itemName?: string
  qty?: number
  unit?: string
  platform?: string
  price?: number
  review?: string
} {
  const draft = collection.draft
  if (draft.kind === "restock") {
    return {
      itemName: draft.itemName,
      qty: draft.qty,
      unit: draft.unit,
      platform: draft.platform,
      price: draft.price,
      review: draft.review
    }
  }
  if (draft.kind === "createItemWithRestock") {
    return {
      itemName: draft.item.itemName,
      qty: draft.restock.qty,
      unit: draft.restock.unit,
      platform: draft.restock.platform,
      price: draft.restock.price,
      review: draft.restock.review
    }
  }
  return {}
}

/** 收集当前 collection 物品的历史平台，供 LLM 指代消解。 */
function collectHistoryPlatforms(
  collection: DraftCollection | undefined,
  state: AppState,
  itemViews: HouseholdChatItemView[]
): string[] {
  const draft = collection?.draft
  let itemName: string | undefined
  if (draft?.kind === "restock") itemName = draft.itemName
  else if (draft?.kind === "createItemWithRestock") itemName = draft.item.itemName

  const platforms: string[] = []
  const seen = new Set<string>()
  // 先从 itemViews 找匹配物品的历史
  for (const view of itemViews) {
    if (itemName && view.item.name !== itemName) continue
    for (const event of view.item.history ?? []) {
      if (event.platform && !seen.has(event.platform)) {
        seen.add(event.platform)
        platforms.push(event.platform)
      }
    }
  }
  // 兜底从 state.items 找
  if (platforms.length === 0) {
    for (const item of state.items ?? []) {
      if (itemName && item.name !== itemName) continue
      for (const event of item.history ?? []) {
        if (event.platform && !seen.has(event.platform)) {
          seen.add(event.platform)
          platforms.push(event.platform)
        }
      }
    }
  }
  return platforms
}

/**
 * 解析 LLM 返回的原始文本为 LlmTurnInterpretation。
 * 容忍前后多余文字、markdown 代码块包裹；提取第一个 { ... } JSON 对象。
 * 解析失败或字段不合法返回 null。
 *
 * 放宽规则（阶段 2C 真实链路修复）：
 *   - fields 缺失或不是对象时，默认 {}，不再直接返回 null
 *   - confidence 缺失时，默认 "medium"，不再直接返回 null（但 parseResult 会记录 warning）
 *   - intent 不合法仍返回 null（不可放宽）
 */
export function parseLlmTurnInterpretation(raw: string): LlmTurnInterpretation | null {
  if (!raw || typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null

  // 提取第一个 JSON 对象（容忍 ```json ... ``` 包裹或前后说明文字）
  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start < 0 || end <= start) return null

  let jsonStr: string
  try {
    jsonStr = trimmed.slice(start, end + 1)
    const obj = JSON.parse(jsonStr)
    return validateLlmTurnInterpretation(obj)
  } catch {
    return null
  }
}

/**
 * 校验解析后的对象是否符合 schema。
 * 放宽：fields 缺失→{}，confidence 缺失→medium。
 * 严格：intent 必须合法。
 */
function validateLlmTurnInterpretation(obj: unknown): LlmTurnInterpretation | null {
  if (!obj || typeof obj !== "object") return null
  const o = obj as Record<string, unknown>

  const intent = o.intent
  if (typeof intent !== "string" || !VALID_LLM_INTENTS.has(intent as LlmTurnIntent)) {
    return null
  }

  // 放宽：fields 缺失或不是对象时默认 {}，不再返回 null
  const fieldsRaw = o.fields
  const f = (fieldsRaw && typeof fieldsRaw === "object") ? fieldsRaw as Record<string, unknown> : {}
  const fields: LlmTurnInterpretation["fields"] = {}
  if (typeof f.itemName === "string" && f.itemName.trim()) fields.itemName = f.itemName.trim()
  if (typeof f.quantity === "number" && Number.isFinite(f.quantity)) fields.quantity = f.quantity
  else if (typeof f.quantity === "string" && /^\d+$/.test(f.quantity.trim())) fields.quantity = Number(f.quantity)
  if (typeof f.unit === "string" && f.unit.trim()) fields.unit = f.unit.trim()
  if (typeof f.date === "string" && f.date.trim()) fields.date = f.date.trim()
  if (typeof f.price === "number" && Number.isFinite(f.price)) fields.price = f.price
  else if (typeof f.price === "string" && /^\d+(\.\d+)?$/.test(f.price.trim())) fields.price = Number(f.price)
  if (typeof f.platform === "string" && f.platform.trim()) fields.platform = f.platform.trim()
  if (typeof f.review === "string" && f.review.trim()) fields.review = f.review.trim()
  // 阶段 4B.6：targetField（query_current_pending 时用户想查的字段）
  if (typeof f.targetField === "string") {
    const validTargets = ["price", "platform", "qty", "status", "date", "summary"]
    if (validTargets.includes(f.targetField)) {
      fields.targetField = f.targetField as LlmTurnInterpretation["fields"]["targetField"]
    }
  }

  // 放宽：confidence 缺失时默认 "medium"，不再返回 null
  const confidenceRaw = o.confidence
  const confidence: "high" | "medium" | "low" =
    confidenceRaw === "high" || confidenceRaw === "medium" || confidenceRaw === "low"
      ? confidenceRaw
      : "medium"

  const reason = typeof o.reason === "string" ? o.reason : ""

  return { intent: intent as LlmTurnIntent, fields, confidence, reason }
}

/**
 * 把 LlmTurnInterpretation normalize 为本地 TurnInterpretation，供 resolveConversationFocus 二次路由。
 * signals 根据 intent 和 fields 推导；confidence/reason 直接继承。
 *
 * 注意：LLM 的 fields.date 是字符串（如「今天」），但 TurnInterpretation.fields.date 是 number（时间戳）。
 * 日期归一由本地 parseNaturalDate 负责，LLM 不直接产出时间戳。因此这里丢弃 LLM 的 date 字段，
 * 日期补充仍走本地高置信路径（turnInterpretation.detectShortField 的日期分支）。
 */
function normalizeLlmInterpretation(parsed: LlmTurnInterpretation): TurnInterpretation {
  const intent = parsed.intent as TurnIntent
  const signals: TurnInterpretation["signals"] = {
    hasPurchaseVerb: intent === "new_restock_record",
    hasExplicitCorrection: intent === "correct_current_collection",
    hasConfirmSignal: intent === "confirm_current_task",
    hasCancelSignal: intent === "cancel_current_task",
    hasDeleteSignal: false,
    hasOnlyShortField: intent === "supplement_current_collection"
  }
  // 丢弃 date：类型不兼容（string vs number），日期补充走本地解析
  const { date: _omit, ...restFields } = parsed.fields
  return {
    intent,
    fields: { ...restFields },
    signals,
    confidence: parsed.confidence,
    reason: parsed.reason || `LLM 解释为 ${intent}`
  }
}

/**
 * 阶段 4B.6：从 pendingDraft 中提取可读字段摘要，供 buildUserPrompt 使用。
 */
function describeDraftFields(draft: AgentDraft): {
  itemName?: string
  qty?: number
  unit?: string
  platform?: string
  price?: number
  review?: string
  restockDate?: number
} {
  if (draft.kind === "restock") {
    return {
      itemName: draft.itemName,
      qty: draft.qty,
      unit: draft.unit,
      platform: draft.platform,
      price: draft.price,
      review: draft.review,
      restockDate: draft.restockDate
    }
  }
  if (draft.kind === "createItemWithRestock") {
    return {
      itemName: draft.item.itemName,
      qty: draft.restock.qty,
      unit: draft.restock.unit,
      platform: draft.restock.platform,
      price: draft.restock.price,
      review: draft.restock.review,
      restockDate: draft.restock.restockDate
    }
  }
  return {}
}

/**
 * 构造真实运行时的 LLM 客户端（接 window.desktop.chatComplete）。
 * 仅在浏览器/Electron 主世界有 desktop bridge 时可用；否则返回 null。
 *
 * 注意：
 *   1. 使用 `window.desktop?.chatComplete`（typed global），而非 `(globalThis as any).window`。
 *      后者在某些打包配置下可能拿不到真实 window。
 *   2. system + user 双消息结构：system 段是固定规则，user 段是上下文 + 用户输入。
 *      qwen-plus 等模型对「system 规则 + user 输入」结构比纯 system 更可靠地输出 JSON。
 *   3. 模型由 resolveTurnInterpreterModel 决定，避免视觉模型做纯文本 JSON interpreter。
 */
function createDesktopTurnInterpreterLlmClient(state: AppState, model: string): TurnInterpreterLlmClient | null {
  const apiKey = state.settings?.aiApiKey
  // 优先用 typed window（与 askHouseholdAssistant 一致），避免 globalThis.window 在某些环境拿不到
  const desktop = typeof window !== "undefined" ? window.desktop : undefined
  if (!desktop?.chatComplete || !apiKey) return null

  return {
    async complete(prompt: string): Promise<string> {
      // prompt 已是 system + user 合并串，这里拆分发送：
      // 找到 "=== 用户输入与上下文 ===" 分隔符，前段作 system，后段作 user。
      // repair prompt 没有该分隔符，整体作为 user 消息。
      const separator = "=== 用户输入与上下文 ==="
      const sepIndex = prompt.indexOf(separator)
      let messages: { role: "system" | "user"; content: string }[]
      if (sepIndex >= 0) {
        const systemContent = prompt.slice(0, sepIndex).trim()
        const userContent = prompt.slice(sepIndex + separator.length).trim()
        messages = userContent
          ? [
              { role: "system" as const, content: systemContent },
              { role: "user" as const, content: userContent }
            ]
          : [{ role: "system" as const, content: systemContent }]
      } else {
        // repair prompt 或无分隔符的 prompt：整体作为 user 消息
        messages = [{ role: "user" as const, content: prompt }]
      }

      const result = await desktop.chatComplete!({
        apiKey,
        model: model || "qwen-plus",
        messages
      })
      if (!result?.ok) {
        throw new Error(typeof result?.error === "string" ? result.error : "llm failed")
      }
      return result.content
    }
  }
}
