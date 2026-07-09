/**
 * AgentDecisionTrace：dev-only 决策追踪（阶段 2C 复盘）
 *
 * 真实窗口中 pendingCollection 下输入「拼夕夕 / PDD / p'd'd」未被识别为平台补充，
 * mock 测试却通过。本模块记录 decideSync → interpretAndRoute → askTurnInterpreterLlm
 * 全链路中间状态，便于人工验收时在 console / window.__agentLastTrace 中定位断点。
 *
 * 设计原则：
 *   1. 纯数据结构，不依赖 React / DOM。orchestrator 填充字段，App.tsx 读取并暴露。
 *   2. 不影响正式生产 UI，不改变用户界面。仅 dev 环境或 localStorage.agentDebug="1" 时 console.info。
 *   3. window.__agentLastTrace 始终暴露最近一条 trace（生产环境也暴露，便于现场调试）。
 *   4. 不写入 state，不写入持久化存储，不发送网络请求。
 */

import type { TurnInterpretation } from "./turnInterpretation"
import type { FocusDecision } from "./focusResolver"

/** 完整决策 trace。每条用户输入对应一条。 */
export type AgentDecisionTrace = {
  /** 唯一 id（uuid 风格，便于 console 中定位） */
  id: string
  /** 创建时间戳 */
  createdAt: number
  /** 用户这一轮输入原文 */
  userText: string

  /** 当前 pending 上下文快照（只读，不修改 state） */
  pending: {
    collectionItemName?: string
    collectionStatus?: string
    missingFields?: string[]
  }

  /** 本地 turnInterpretation 解释结果 */
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

  /** LLM Turn Interpreter 调用详情 */
  llmInterpreter?: {
    /** 是否应该调用（即 decideSync 返回 needTurnInterpreterLlm） */
    shouldCall: boolean
    /** 是否真实调用了 askTurnInterpreterLlm */
    called: boolean
    /** 未调用的原因（如 noApiKey / noDesktopBridge / notNeeded） */
    reason?: string
    /** 是否检测到 API Key */
    hasApiKey?: boolean
    /** 使用的模型名 */
    model?: string
    /** 发给 LLM 的 prompt 预览（前 500 字符） */
    promptPreview?: string
    /** LLM 原始返回文本（前 2000 字符） */
    rawResponse?: string
    /** parseLlmTurnInterpretation 解析结果（可能为 null） */
    parsed?: unknown
    /** normalize 后的 TurnInterpretation（若通过校验） */
    normalizedInterpretation?: TurnInterpretation
    /** 是否被拒绝（低置信 / unknown / 空字段 / 解析失败） */
    rejected?: boolean
    /** 拒绝原因 */
    rejectReason?: string
  }

  /** 第二次 focusResolver 决策（基于 LLM 解释） */
  secondFocusDecision?: FocusDecision

  /** 合成输入（如「拼多多」），供 handlePendingCollectionIntent 复用 */
  synthesizedInput?: string

  /** 最终 decision */
  finalDecision?: {
    kind: string
    turnKind?: string
    /** 最终 turn 的 message 预览（前 300 字符） */
    message?: string
  }
}

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
 * 创建一条新的 trace。仅初始化 id / createdAt / userText / pending，
 * 其他字段由 orchestrator 在执行过程中逐步填充。
 */
export function createTrace(
  userText: string,
  pending: AgentDecisionTrace["pending"]
): AgentDecisionTrace {
  return {
    id: generateTraceId(),
    createdAt: Date.now(),
    userText,
    pending
  }
}

/** 生成短 id（不依赖 crypto，避免在测试环境出问题）。 */
function generateTraceId(): string {
  return `trace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 把 trace 暴露到 window.__agentLastTrace，并在 dev 环境下 console.info。
 *
 * 注意：window.__agentLastTrace 始终暴露（即使生产环境），便于现场调试。
 * console.info 仅在 isTraceEnabled() 为 true 时输出，避免污染生产 console。
 */
export function commitTrace(trace: AgentDecisionTrace): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = (globalThis as any)
    if (g?.window) {
      g.window.__agentLastTrace = trace
    } else {
      // Node 测试环境：暴露到 globalThis，便于测试读取
      g.__agentLastTrace = trace
    }
  } catch {
    // 忽略：暴露失败不应影响主流程
  }

  if (isTraceEnabled()) {
    // eslint-disable-next-line no-console
    console.info("[agentDecisionTrace]", summarizeTrace(trace))
  }
}

/**
 * 把 trace 压缩成可读的 console 摘要（避免输出超长 raw response）。
 */
function summarizeTrace(trace: AgentDecisionTrace): {
  id: string
  userText: string
  pendingItem?: string
  localIntent?: string
  firstFocus?: string
  decisionBeforeDispatch?: string
  llmCalled?: boolean
  llmRejected?: boolean
  llmRejectReason?: string
  secondFocus?: string
  synthesizedInput?: string
  finalKind?: string
  finalTurnKind?: string
} {
  return {
    id: trace.id,
    userText: trace.userText,
    pendingItem: trace.pending.collectionItemName,
    localIntent: trace.localInterpretation?.intent,
    firstFocus: trace.firstFocusDecision?.focus,
    decisionBeforeDispatch: trace.decisionBeforeAppDispatch,
    llmCalled: trace.llmInterpreter?.called,
    llmRejected: trace.llmInterpreter?.rejected,
    llmRejectReason: trace.llmInterpreter?.rejectReason,
    secondFocus: trace.secondFocusDecision?.focus,
    synthesizedInput: trace.synthesizedInput,
    finalKind: trace.finalDecision?.kind,
    finalTurnKind: trace.finalDecision?.turnKind
  }
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

/** 仅测试用：清空 lastTrace。 */
export function resetLastTraceForTest(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = (globalThis as any)
    if (g?.window) delete g.window.__agentLastTrace
    delete g.__agentLastTrace
  } catch {
    // ignore
  }
}
