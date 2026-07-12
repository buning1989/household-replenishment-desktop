import type { AppState } from "./types"
import type { AgentDecisionTrace } from "./agent/agentDecisionTrace"

type NotificationAction = {
  action: "open" | "restock" | "snooze" | "openChat"
  itemIds: string[]
}

type OcrExtractPayload = {
  apiKey: string
  model?: string
  imageDataUrl: string
  prompt: string
}

type OcrExtractDiagnostics = {
  elapsedSeconds?: number
  promptTokens?: number
  completionTokens?: number
  hasReasoning?: boolean
}

type OcrExtractResult = { ok: true; content: string; diagnostics?: OcrExtractDiagnostics } | { ok: false; error: string }

type ChatMessagePayload = {
  role: "system" | "user" | "assistant"
  content: string
}

type ChatCompletePayload = {
  apiKey: string
  model?: string
  messages: ChatMessagePayload[]
}

type ChatCompleteResult = { ok: true; content: string } | { ok: false; error: string }

declare global {
  interface Window {
    desktop?: {
      syncState: (state: AppState) => Promise<{ ok: boolean; error?: string }>
      loadState: () => Promise<AppState | null>
      resetToDemoState: (currentState: AppState) => Promise<{ ok: true; state: AppState; backupPath: string } | { ok: false; error: string; rolledBack?: boolean }>
      ocrExtract: (payload: OcrExtractPayload) => Promise<OcrExtractResult>
      chatComplete: (payload: ChatCompletePayload) => Promise<ChatCompleteResult>
      openExternal: (url: string) => Promise<void>
      showWindow: () => void
      onNotificationAction: (callback: (payload: NotificationAction) => void) => () => void
    }
    /**
     * dev-only Agent 决策追踪。始终暴露（含生产环境），便于现场调试；
     * console 输出仅在 isTraceEnabled() 为 true 时执行。
     */
    __agentLastTrace?: AgentDecisionTrace
    /** 返回最近一条 trace 的可复制纯文本（9 个字段完整版） */
    __copyAgentTrace?: () => string
    /** 最近 20 条 trace 历史（最旧在前） */
    __agentTraceHistory?: AgentDecisionTrace[]
  }
}

declare module "*.png" {
  const value: string
  export default value
}

declare module "*.jpg" {
  const value: string
  export default value
}

declare module "*.svg" {
  const value: string
  export default value
}

export {}
