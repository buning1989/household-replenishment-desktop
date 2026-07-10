/**
 * AgentDecisionTrace：dev-only 决策追踪（贯穿 decide → interpretAndRoute → askTurnInterpreterLlm / askHouseholdAssistant）。
 *
 * 每条用户输入对应一条 trace，记录 9 个字段：
 *   1. userInput          用户原始输入
 *   2. currentState       当前会话 pending 上下文（pendingPlan / pendingDraft / pendingCollection / pendingBatch）
 *   3. routeDecision      命中的 handler / 规则 / 是否被本地规则提前拦截 / 是否走向 route_to_llm
 *   4. llmRequest         发给 LLM 的核心 prompt 与上下文摘要
 *   5. llmResponse        LLM 原始返回文本
 *   6. parseResult        LLM 输出解析后的结构化结果
 *   7. validationResult   validator 是否通过；失败时给出 rejectReason
 *   8. finalDecision      最终采取的动作（answer / confirm / writeDraft / fallback / needLlm ...）
 *   9. finalMessage       最终展示给用户的回复（不截断，便于复制给 reviewer）
 *
 * 设计原则：
 *   1. 纯数据结构，不依赖 React / DOM。orchestrator / App.tsx / askHouseholdAssistant 填充字段。
 *   2. 不影响正式生产 UI，不改变用户界面。仅 dev 环境或 localStorage.agentDebug="1" 时 console 输出。
 *   3. window.__agentLastTrace 始终暴露最近一条 trace（生产环境也暴露，便于现场调试）。
 *   4. window.__copyAgentTrace() 返回可复制的完整文本；window.__agentTraceHistory 保留最近 20 条。
 *   5. 不写入 state，不写入持久化存储，不发送网络请求。
 */

import type { TurnInterpretation } from "./turnInterpretation"
import type { FocusDecision } from "./focusResolver"
import type { AgentPlan } from "./actions"
import type { AgentDraft } from "./drafts"
import type { DraftCollection } from "./draftCollection"

// ---------- 2. currentState ----------

/** 当前会话 pending 上下文快照（只读，不修改 state）。 */
export type TraceCurrentState = {
  hasPendingPlan?: boolean
  pendingPlanStatus?: string
  pendingPlanRisk?: string
  /** 形如 "2 actions: deleteItem(猫砂), deleteCategory(卫生间)" */
  pendingPlanSummary?: string
  hasPendingDraft?: boolean
  pendingDraftSummary?: string
  hasPendingCollection?: boolean
  pendingCollectionSummary?: string
  hasPendingBatch?: boolean
  pendingBatchCount?: number
}

// ---------- 3. routeDecision ----------

/** 路由决策：命中哪个 handler / 是否被规则提前拦截 / 是否走向 route_to_llm。 */
export type TraceRouteDecision = {
  /** pendingPlan / pendingCollection / pendingBatch / pendingDraft / writeDraft / boundary / needLlm / needTurnInterpreterLlm */
  handler: string
  /** 命中的具体规则或分支，如 "awaitingSecondConfirm.isSecondConfirmMatch" / "boundary.casual" / "planner.planOnly" / "focus.route_to_llm" */
  rule?: string
  /**
   * true 表示最终被某个本地路由规则接住（无论是否调用过 LLM）。
   * 注意：interceptedByRule 只能表示「最终被路由规则接住」，
   * 不能表示「没有调用 LLM」。LLM 是否调用请看 llmInterpreter.called。
   * 二者可以同时为 true：LLM 解释成功后被本地 route rule 接住继续路由。
   */
  interceptedByRule?: boolean
  /** true 表示最终走向 route_to_llm（needLlm / needTurnInterpreterLlm） */
  routeToLlm?: boolean
  /** needLlm / needTurnInterpreterLlm 时给出的原因 */
  reason?: string
}

// ---------- 4. llmRequest ----------

/** 发给 LLM 的请求摘要。区分常规 answer LLM 与 turn interpreter。 */
export type TraceLlmRequest = {
  /** answerLlm：常规 askHouseholdAssistant；turnInterpreter：askTurnInterpreterLlm */
  kind: "answerLlm" | "turnInterpreter"
  model?: string
  /** 系统提示预览（前 1500 字符） */
  systemPromptPreview?: string
  /** 压缩后传入 LLM 的最近对话条数 */
  recentMessageCount?: number
  /** 相关业务事实摘要（前 800 字符） */
  relevantFactsPreview?: string
  /** 当前对话焦点 */
  activeFocus?: string
  /** 允许的动作 */
  allowedActions?: string[]
}

// ---------- 5. llmResponse ----------

/** LLM 原始返回（不截断 content，便于复制给 reviewer 定位问题）。 */
export type TraceLlmResponse = {
  ok: boolean
  content?: string
  error?: string
  elapsedMs?: number
}

// ---------- 6. parseResult ----------

/** parseAgentResponse 解析后的结构化结果。 */
export type TraceParseResult = {
  ok: boolean
  /** 解析出的 kind：queryAnswer / clarification / draft */
  kind?: string
  /** 解析失败原因 */
  error?: string
}

// ---------- 7. validationResult ----------

/** normalizeLlmResponse 是否通过。 */
export type TraceValidationResult = {
  passed: boolean
  /** 失败原因：normalize_returned_null / parse_failed */
  rejectReason?: string
  /** normalize 后的 turn kind */
  turnKind?: string
}

/** 完整决策 trace。每条用户输入对应一条。 */
export type AgentDecisionTrace = {
  /** 唯一 id（uuid 风格，便于 console 中定位） */
  id: string
  /** 创建时间戳 */
  createdAt: number
  /** 1. 用户这一轮输入原文 */
  userText: string

  /** 2. 当前 pending 上下文快照（只读，不修改 state） */
  currentState?: TraceCurrentState

  /** @deprecated 旧字段，仅保留 pendingCollection 子集；新代码请用 currentState。测试仍依赖。 */
  pending: {
    collectionItemName?: string
    collectionStatus?: string
    missingFields?: string[]
  }

  /** 3. 路由决策 */
  routeDecision?: TraceRouteDecision

  /** 本地 turnInterpretation 解释结果（pendingCollection 路径下填充） */
  localInterpretation?: TurnInterpretation

  /** 第一次 focusResolver 决策（基于本地解释） */
  firstFocusDecision?: FocusDecision

  /** handlePendingCollectionIntent 兜底尝试结果 */
  collectionFallback?: {
    tried: boolean
    producedTurn: boolean
    turnKind?: string
  }

  /** decideSync 返回的 decision.kind（在 App.tsx dispatch 之前） */
  decisionBeforeAppDispatch?: string

  /** 4. 发给常规 answer LLM 的请求摘要（区别于 llmInterpreter） */
  llmRequest?: TraceLlmRequest

  /** 5. 常规 answer LLM 的原始返回 */
  llmResponse?: TraceLlmResponse

  /** 6. parseAgentResponse 解析结果 */
  parseResult?: TraceParseResult

  /** 7. normalizeLlmResponse 校验结果 */
  validationResult?: TraceValidationResult

  /** LLM Turn Interpreter 调用详情（pendingCollection 下本地低置信时触发） */
  llmInterpreter?: {
    /** 是否应该调用（即 decideSync 返回 needTurnInterpreterLlm） */
    shouldCall: boolean
    /** 是否真实调用了 askTurnInterpreterLlm。本地高置信路径默认 false。 */
    called: boolean
    /**
     * 未调用的原因（shouldCall=false 或 called=false 时填写）。
     * 取值如：
     *   - "local_high_confidence"：本地高置信规则直接处理，未进入 interpretAndRoute
     *   - "not_entered"：未进入 interpretAndRouteSync（createTrace 默认值）
     *   - "no_pendingCollection"：interpretAndRouteSync 入口检查失败
     *   - "no_api_key"：无 API Key
     *   - "no_desktop_bridge"：无 desktop bridge
     */
    skipReason?: string
    /** 未调用的旧字段（兼容；新代码请用 skipReason）。取值如 noApiKey / noDesktopBridge / notNeeded */
    reason?: string
    /** 是否检测到 API Key */
    hasApiKey?: boolean
    /** 使用的模型名 */
    model?: string
    /** LLM 提供方（如 dashscope / openai / mock） */
    provider?: string
    /** 发给 LLM 的 prompt 预览（前 500 字符） */
    promptPreview?: string
    /** LLM 原始返回文本（前 2000 字符） */
    rawResponse?: string
    /** parseLlmTurnInterpretation 解析结果（可能为 null） */
    parsed?: unknown
    /** JSON 解析 + schema 校验是否通过。false 表示非合法 JSON 或 schema 不符合。 */
    schemaValid?: boolean
    /** normalize 后的 TurnInterpretation（若通过校验） */
    normalizedInterpretation?: TurnInterpretation
    /** 是否被拒绝（低置信 / unknown / 空字段 / 解析失败） */
    rejected?: boolean
    /** 拒绝原因 */
    rejectReason?: string
    /** LLM 调用异常（区别于 rejectReason：rejectReason 是业务拒绝，error 是 client 抛异常） */
    error?: string
    /** LLM 调用耗时（毫秒） */
    durationMs?: number
    /** validator 放宽后的 warning（如 confidence 缺失默认 medium） */
    validationWarning?: string
    /** 是否尝试过一次 JSON repair retry */
    repairAttempted?: boolean
    /** repair retry 的 LLM 原始返回文本（前 2000 字符） */
    repairRawResponse?: string
    /** repair retry 的 parse 结果（可能为 null） */
    repairParsed?: unknown
    /** repair retry 仍被拒绝时的 rejectReason；undefined 表示 repair 成功或未尝试 */
    repairRejectReason?: string
  }

  /** 第二次 focusResolver 决策（基于 LLM 解释） */
  secondFocusDecision?: FocusDecision

  /** 合成输入（如「拼多多」），供 handlePendingCollectionIntent 复用 */
  synthesizedInput?: string

  /** 8. 最终 decision */
  finalDecision?: {
    kind: string
    turnKind?: string
    /** 最终 turn 的 message 预览（前 300 字符），向后兼容用；完整文本见 finalMessage */
    message?: string
  }

  /** 9. 最终展示给用户的完整回复（不截断，便于复制给 reviewer） */
  finalMessage?: string
}

/** trace 历史上限（window.__agentTraceHistory） */
const TRACE_HISTORY_LIMIT = 20

/**
 * 判断 trace 是否应该输出到 console。
 * 开发环境（import.meta.env.DEV）或 localStorage.agentDebug === "1" 时输出。
 */
export function isTraceEnabled(): boolean {
  try {
    // Vite dev 环境
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (import.meta as any).env
    if (meta?.DEV) return true
    // 显式开关
    if (typeof localStorage !== "undefined" && localStorage.getItem("agentDebug") === "1") {
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * 创建一条新的 trace。仅初始化 id / createdAt / userText / pending / currentState，
 * 其他字段由 orchestrator / App.tsx / askHouseholdAssistant 在执行过程中逐步填充。
 *
 * currentState 为可选第三参；不传时仅保留旧 pending 子集（向后兼容现有测试）。
 */
export function createTrace(
  userText: string,
  pending: AgentDecisionTrace["pending"],
  currentState?: TraceCurrentState
): AgentDecisionTrace {
  return {
    id: generateTraceId(),
    createdAt: Date.now(),
    userText,
    pending,
    currentState,
    // 阶段 3B.1：默认初始化 llmInterpreter 为 called=false，
    // 让所有本地高置信路径自动有 called=false + skipReason。
    // 进入 interpretAndRouteSync 时由调用方覆盖 shouldCall=true / skipReason=undefined。
    llmInterpreter: {
      shouldCall: false,
      called: false,
      skipReason: "local_high_confidence"
    }
  }
}

/** 生成短 id（不依赖 crypto，避免在测试环境出问题）。 */
function generateTraceId(): string {
  return `trace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 从当前 pending 对象构建 currentState 快照（纯函数，不修改入参）。
 * App.tsx 在调用 createTrace 前用本函数把 pendingPlan/Draft/Collection/Batch 转成可读摘要。
 */
export function buildTraceCurrentState(params: {
  pendingPlan?: AgentPlan | null
  pendingDraft?: AgentDraft | null
  pendingCollection?: DraftCollection | null
  pendingBatch?: AgentDraft[] | null
}): TraceCurrentState {
  const state: TraceCurrentState = {}
  if (params.pendingPlan) {
    state.hasPendingPlan = true
    state.pendingPlanStatus = params.pendingPlan.status
    state.pendingPlanRisk = params.pendingPlan.risk
    state.pendingPlanSummary = summarizePendingPlan(params.pendingPlan)
  }
  if (params.pendingDraft) {
    state.hasPendingDraft = true
    state.pendingDraftSummary = summarizePendingDraft(params.pendingDraft)
  }
  if (params.pendingCollection) {
    state.hasPendingCollection = true
    state.pendingCollectionSummary = summarizePendingCollection(params.pendingCollection)
  }
  if (params.pendingBatch && params.pendingBatch.length > 0) {
    state.hasPendingBatch = true
    state.pendingBatchCount = params.pendingBatch.length
  }
  return state
}

/** pendingPlan 摘要：动作数 + 每条动作简述。 */
function summarizePendingPlan(plan: AgentPlan): string {
  const actions = plan.actions.map((a) => summarizeActionType(a))
  return `${actions.length} actions: ${actions.join(", ")}`
}

function summarizeActionType(action: import("./actions").AgentAction): string {
  switch (action.type) {
    case "createCategory": return `createCategory(${action.name})`
    case "createItem": return `createItem(${action.name})`
    case "updateItem": return `updateItem(${action.itemName || action.itemId})`
    case "addPurchaseOption": return `addPurchaseOption(${action.productName})`
    case "recordRestock": return `recordRestock(${action.itemName})`
    case "updateRestockRecord": return `updateRestockRecord(${action.itemId})`
    case "setMonthlyBudget": return `setMonthlyBudget(¥${action.amount})`
    case "renameCategory": return `renameCategory(${action.oldName}→${action.newName})`
    case "moveItem": return `moveItem(${action.itemName || action.itemId}→${action.targetCategory})`
    case "updateItemUnit": return `updateItemUnit(${action.itemName || action.itemId}→${action.unit})`
    case "updateItemReminder": return `updateItemReminder(${action.itemName || action.itemId},${action.bufferDays}d)`
    case "updatePurchaseOption": return `updatePurchaseOption(${action.productName || action.optionId})`
    case "setDefaultPurchaseOption": return `setDefaultPurchaseOption(${action.productName || action.optionId})`
    case "deletePurchaseOption": return `deletePurchaseOption(${action.productName || action.optionId})`
    case "deleteRestockRecord": return `deleteRestockRecord(${action.itemName})`
    case "deleteItem": return `deleteItem(${action.itemName})`
    case "deleteCategory": return `deleteCategory(${action.categoryName})`
    default: return "(unknown)"
  }
}

/** pendingDraft 摘要：kind + 物品名 + 关键字段。 */
function summarizePendingDraft(draft: AgentDraft): string {
  if (draft.kind === "restock") {
    return `restock(${draft.itemName}, qty=${draft.qty ?? "?"}${draft.unit ? draft.unit : ""}${draft.platform ? `, ${draft.platform}` : ""}${draft.price !== undefined ? `, ¥${draft.price}` : ""})`
  }
  if (draft.kind === "createItem") {
    return `createItem(${draft.itemName}, ${draft.category})`
  }
  if (draft.kind === "createItemWithRestock") {
    return `createItemWithRestock(${draft.item.itemName}, ${draft.item.category})`
  }
  if (draft.kind === "addPurchaseOption") {
    return `addPurchaseOption(${draft.productName})`
  }
  return "unknown"
}

/** pendingCollection 摘要：物品名 + 缺失字段。 */
function summarizePendingCollection(collection: DraftCollection): string {
  const draft = collection.draft
  let itemName: string | undefined
  if (draft.kind === "restock") itemName = draft.itemName
  else if (draft.kind === "createItemWithRestock") itemName = draft.item.itemName
  const missing = [...collection.requiredMissingSlots, ...collection.qualityMissingSlots]
  return `${itemName ?? "?"}, completeness=${collection.completeness}, missing=[${missing.join(",") || "none"}]`
}

/**
 * 在 orchestrator 各决策点设置 routeDecision。trace 为 undefined 时安全跳过。
 */
export function setRouteDecision(
  trace: AgentDecisionTrace | undefined,
  handler: string,
  opts?: { rule?: string; interceptedByRule?: boolean; routeToLlm?: boolean; reason?: string }
): void {
  if (!trace) return
  trace.routeDecision = {
    handler,
    rule: opts?.rule,
    interceptedByRule: opts?.interceptedByRule,
    routeToLlm: opts?.routeToLlm,
    reason: opts?.reason
  }
}

/**
 * 设置最终 decision 与完整 finalMessage（集中处理，避免散落 slice(0,300)）。
 * finalDecision.message 保留 300 字符预览以兼容旧测试；finalMessage 保留完整文本。
 */
export function setFinalDecision(
  trace: AgentDecisionTrace | undefined,
  opts: {
    kind: string
    turnKind?: string
    /** 完整最终消息（不截断） */
    message?: string
  }
): void {
  if (!trace) return
  trace.finalDecision = {
    kind: opts.kind,
    turnKind: opts.turnKind,
    message: opts.message ? opts.message.slice(0, 300) : undefined
  }
  if (opts.message !== undefined) {
    trace.finalMessage = opts.message
  }
}

/**
 * 把 trace 暴露到 window.__agentLastTrace，并追加到 __agentTraceHistory（上限 20），
 * 同时注册 window.__copyAgentTrace。dev 环境下 console 输出可复制的完整 trace。
 *
 * 注意：window.__agentLastTrace / __copyAgentTrace / __agentTraceHistory 始终暴露（即使生产环境），
 * 便于现场调试。console 输出仅在 isTraceEnabled() 为 true 时执行，避免污染生产 console。
 */
export function commitTrace(trace: AgentDecisionTrace): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = (globalThis as any)
    const target = g?.window ?? g
    if (target) {
      target.__agentLastTrace = trace
      target.__copyAgentTrace = () => formatTraceForCopy(trace)
      // 追加到历史（上限 TRACE_HISTORY_LIMIT）
      if (!Array.isArray(target.__agentTraceHistory)) {
        target.__agentTraceHistory = []
      }
      target.__agentTraceHistory.push(trace)
      if (target.__agentTraceHistory.length > TRACE_HISTORY_LIMIT) {
        target.__agentTraceHistory.splice(0, target.__agentTraceHistory.length - TRACE_HISTORY_LIMIT)
      }
    }
  } catch {
    // 忽略：暴露失败不应影响主流程
  }

  if (isTraceEnabled()) {
    // eslint-disable-next-line no-console
    console.info("[agentDecisionTrace]", summarizeTrace(trace), "\n— 完整可复制 trace：调用 copy(__agentLastTrace) 或 __copyAgentTrace()")
  }
}

/**
 * 把 trace 压缩成可读的 console 摘要（避免输出超长 raw response）。
 */
function summarizeTrace(trace: AgentDecisionTrace): {
  id: string
  userText: string
  pendingItem?: string
  currentState?: TraceCurrentState
  routeHandler?: string
  routeRule?: string
  localIntent?: string
  firstFocus?: string
  decisionBeforeDispatch?: string
  llmRequestKind?: string
  llmResponseOk?: boolean
  parseOk?: boolean
  validationPassed?: boolean
  llmCalled?: boolean
  llmSkipReason?: string
  llmSchemaValid?: boolean
  llmRejected?: boolean
  llmRejectReason?: string
  llmError?: string
  secondFocus?: string
  synthesizedInput?: string
  finalKind?: string
  finalTurnKind?: string
} {
  return {
    id: trace.id,
    userText: trace.userText,
    pendingItem: trace.pending.collectionItemName,
    currentState: trace.currentState,
    routeHandler: trace.routeDecision?.handler,
    routeRule: trace.routeDecision?.rule,
    localIntent: trace.localInterpretation?.intent,
    firstFocus: trace.firstFocusDecision?.focus,
    decisionBeforeDispatch: trace.decisionBeforeAppDispatch,
    llmRequestKind: trace.llmRequest?.kind,
    llmResponseOk: trace.llmResponse?.ok,
    parseOk: trace.parseResult?.ok,
    validationPassed: trace.validationResult?.passed,
    llmCalled: trace.llmInterpreter?.called,
    llmSkipReason: trace.llmInterpreter?.skipReason,
    llmSchemaValid: trace.llmInterpreter?.schemaValid,
    llmRejected: trace.llmInterpreter?.rejected,
    llmRejectReason: trace.llmInterpreter?.rejectReason,
    llmError: trace.llmInterpreter?.error,
    secondFocus: trace.secondFocusDecision?.focus,
    synthesizedInput: trace.synthesizedInput,
    finalKind: trace.finalDecision?.kind,
    finalTurnKind: trace.finalDecision?.turnKind
  }
}

/**
 * 把 trace 格式化成可复制的纯文本（含全部 9 个字段），供外部 reviewer 判断问题出在
 * route / LLM / validator / state 残留。
 */
export function formatTraceForCopy(trace: AgentDecisionTrace): string {
  const lines: string[] = []
  lines.push("==================== AGENT DECISION TRACE ====================")
  lines.push(`id: ${trace.id}`)
  lines.push(`createdAt: ${new Date(trace.createdAt).toISOString()} (${trace.createdAt})`)
  lines.push("")
  lines.push("【1. userInput】")
  lines.push(trace.userText)
  lines.push("")
  lines.push("【2. currentState】")
  if (trace.currentState) {
    const cs = trace.currentState
    const parts: string[] = []
    if (cs.hasPendingPlan) parts.push(`pendingPlan(status=${cs.pendingPlanStatus ?? "?"}, risk=${cs.pendingPlanRisk ?? "?"}, ${cs.pendingPlanSummary ?? ""})`)
    if (cs.hasPendingDraft) parts.push(`pendingDraft(${cs.pendingDraftSummary ?? "?"})`)
    if (cs.hasPendingCollection) parts.push(`pendingCollection(${cs.pendingCollectionSummary ?? "?"})`)
    if (cs.hasPendingBatch) parts.push(`pendingBatch(count=${cs.pendingBatchCount ?? "?"})`)
    if (parts.length === 0) parts.push("(no pending)")
    lines.push(parts.join(" | "))
  } else {
    lines.push("(not captured)")
  }
  // 兼容旧 pending 字段
  if (trace.pending && (trace.pending.collectionItemName || trace.pending.missingFields)) {
    lines.push(`  [legacy pending] item=${trace.pending.collectionItemName ?? "-"}, status=${trace.pending.collectionStatus ?? "-"}, missing=[${trace.pending.missingFields?.join(",") ?? ""}]`)
  }
  lines.push("")
  lines.push("【3. routeDecision】")
  if (trace.routeDecision) {
    const rd = trace.routeDecision
    lines.push(`handler=${rd.handler}`)
    if (rd.rule) lines.push(`rule=${rd.rule}`)
    if (rd.interceptedByRule !== undefined) {
      lines.push(`interceptedByRule=${rd.interceptedByRule}`)
      // 阶段 3B.1：明确提示 interceptedByRule 不等于「未调用 LLM」
      if (rd.interceptedByRule) {
        const llmCalled = trace.llmInterpreter?.called === true
        lines.push(`  # 注意：interceptedByRule=true 只表示「最终被路由规则接住」，不代表「未调用 LLM」`)
        lines.push(`  # LLM Turn Interpreter called = ${llmCalled ? "true" : "false"}${!llmCalled && trace.llmInterpreter?.skipReason ? ` (skipReason=${trace.llmInterpreter.skipReason})` : ""}`)
      }
    }
    if (rd.routeToLlm !== undefined) lines.push(`routeToLlm=${rd.routeToLlm}`)
    if (rd.reason) lines.push(`reason=${rd.reason}`)
  } else {
    lines.push("(not captured)")
  }
  if (trace.decisionBeforeAppDispatch) {
    lines.push(`decisionBeforeAppDispatch=${trace.decisionBeforeAppDispatch}`)
  }
  lines.push("")
  lines.push("【3b. localInterpretation / focus (pendingPlan / pendingCollection / pendingDraft 路径)】")
  if (trace.localInterpretation) {
    lines.push(`localInterpretation.intent=${trace.localInterpretation.intent}`)
    lines.push(`localInterpretation.fields=${JSON.stringify(trace.localInterpretation.fields)}`)
    lines.push(`localInterpretation.confidence=${trace.localInterpretation.confidence ?? "?"}`)
  } else {
    lines.push("localInterpretation=(none)")
  }
  if (trace.firstFocusDecision) {
    lines.push(`firstFocus=${trace.firstFocusDecision.focus}${trace.firstFocusDecision.reason ? ` (${trace.firstFocusDecision.reason})` : ""}`)
  }
  if (trace.collectionFallback) {
    lines.push(`collectionFallback={tried=${trace.collectionFallback.tried}, producedTurn=${trace.collectionFallback.producedTurn}, turnKind=${trace.collectionFallback.turnKind ?? "?"}}`)
  }
  lines.push("")
  lines.push("【4. llmRequest】")
  if (trace.llmRequest) {
    const r = trace.llmRequest
    lines.push(`kind=${r.kind}`)
    if (r.model) lines.push(`model=${r.model}`)
    if (r.activeFocus) lines.push(`activeFocus=${r.activeFocus}`)
    if (r.recentMessageCount !== undefined) lines.push(`recentMessageCount=${r.recentMessageCount}`)
    if (r.allowedActions) lines.push(`allowedActions=[${r.allowedActions.join(", ")}]`)
    if (r.relevantFactsPreview) {
      lines.push("relevantFactsPreview:")
      lines.push(indent(r.relevantFactsPreview))
    }
    if (r.systemPromptPreview) {
      lines.push("systemPromptPreview:")
      lines.push(indent(r.systemPromptPreview))
    }
  } else if (trace.llmInterpreter) {
    const li = trace.llmInterpreter
    lines.push(`(turnInterpreter) shouldCall=${li.shouldCall}, called=${li.called}`)
    if (li.provider) lines.push(`provider=${li.provider}`)
    if (li.model) lines.push(`model=${li.model}`)
    if (!li.called && li.skipReason) {
      lines.push(`skipReason=${li.skipReason}`)
    }
    if (li.called && li.durationMs !== undefined) {
      lines.push(`durationMs=${li.durationMs}`)
    }
    if (li.promptPreview) {
      lines.push("promptPreview:")
      lines.push(indent(li.promptPreview))
    }
  } else {
    lines.push("(no LLM call)")
  }
  lines.push("")
  lines.push("【5. llmResponse】")
  if (trace.llmResponse) {
    const r = trace.llmResponse
    lines.push(`ok=${r.ok}, elapsedMs=${r.elapsedMs ?? "?"}`)
    if (r.error) lines.push(`error=${r.error}`)
    if (r.content !== undefined) {
      lines.push("content:")
      lines.push(indent(r.content))
    }
  } else if (trace.llmInterpreter?.called) {
    lines.push(`(turnInterpreter) called=true, rawResponse:`)
    lines.push(indent(trace.llmInterpreter.rawResponse ?? "(empty)"))
    if (trace.llmInterpreter.error) {
      lines.push(`error=${trace.llmInterpreter.error}`)
    }
  } else {
    const skipReason = trace.llmInterpreter?.skipReason ?? "not_entered"
    lines.push(`(no LLM response; llmInterpreter.called=false, skipReason=${skipReason})`)
  }
  lines.push("")
  lines.push("【6. parseResult】")
  if (trace.parseResult) {
    lines.push(`ok=${trace.parseResult.ok}, kind=${trace.parseResult.kind ?? "?"}`)
    if (trace.parseResult.error) lines.push(`error=${trace.parseResult.error}`)
  } else if (trace.llmInterpreter?.called) {
    const li = trace.llmInterpreter
    lines.push(`(turnInterpreter) parsed=${li.parsed ? JSON.stringify(li.parsed) : "null"}, schemaValid=${li.schemaValid ?? "?"}`)
    if (li.normalizedInterpretation) {
      lines.push(`normalizedInterpretation=${JSON.stringify(li.normalizedInterpretation)}`)
    }
  } else {
    lines.push("(not captured; LLM not called)")
  }
  lines.push("")
  lines.push("【7. validationResult】")
  if (trace.validationResult) {
    lines.push(`passed=${trace.validationResult.passed}, turnKind=${trace.validationResult.turnKind ?? "?"}`)
    if (trace.validationResult.rejectReason) lines.push(`rejectReason=${trace.validationResult.rejectReason}`)
  } else if (trace.llmInterpreter?.called) {
    const li = trace.llmInterpreter
    lines.push(`(turnInterpreter) rejected=${li.rejected}, rejectReason=${li.rejectReason ?? "?"}`)
    if (li.error) lines.push(`error=${li.error}`)
    if (li.schemaValid === false) lines.push(`schemaValid=false (JSON 解析或 schema 校验失败)`)
  } else {
    lines.push("(not captured; LLM not called)")
  }
  if (trace.llmInterpreter?.rejected) {
    lines.push(`llmInterpreter.rejectReason=${trace.llmInterpreter.rejectReason}`)
  }
  if (trace.secondFocusDecision) {
    lines.push(`secondFocus=${trace.secondFocusDecision.focus}${trace.secondFocusDecision.reason ? ` (${trace.secondFocusDecision.reason})` : ""}`)
  }
  if (trace.synthesizedInput) {
    lines.push(`synthesizedInput=${trace.synthesizedInput}`)
  }
  lines.push("")
  lines.push("【8. finalDecision】")
  if (trace.finalDecision) {
    lines.push(`kind=${trace.finalDecision.kind}, turnKind=${trace.finalDecision.turnKind ?? "?"}`)
  } else {
    lines.push("(not captured)")
  }
  lines.push("")
  lines.push("【9. finalMessage】")
  if (trace.finalMessage !== undefined) {
    lines.push(trace.finalMessage)
  } else {
    lines.push("(not captured; preview: " + (trace.finalDecision?.message ?? "none") + ")")
  }
  lines.push("==================== END TRACE ====================")
  return lines.join("\n")
}

/** 缩进辅助：每行前加 2 个空格。 */
function indent(text: string): string {
  return text.split("\n").map((l) => `  ${l}`).join("\n")
}

/** 读取最近一条 trace（用于测试断言）。 */
export function peekLastTrace(): AgentDecisionTrace | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = (globalThis as any)
    return (g?.window?.__agentLastTrace ?? g?.__agentLastTrace ?? null) as AgentDecisionTrace | null
  } catch {
    return null
  }
}

/** 读取 trace 历史（最近 TRACE_HISTORY_LIMIT 条）。 */
export function peekTraceHistory(): AgentDecisionTrace[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = (globalThis as any)
    const target = g?.window ?? g
    return Array.isArray(target?.__agentTraceHistory) ? target.__agentTraceHistory as AgentDecisionTrace[] : []
  } catch {
    return []
  }
}

/** 仅测试用：清空 lastTrace 与 history。 */
export function resetLastTraceForTest(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = (globalThis as any)
    if (g?.window) {
      delete g.window.__agentLastTrace
      delete g.window.__copyAgentTrace
      delete g.window.__agentTraceHistory
    }
    delete g.__agentLastTrace
    delete g.__copyAgentTrace
    delete g.__agentTraceHistory
  } catch {
    // ignore
  }
}
