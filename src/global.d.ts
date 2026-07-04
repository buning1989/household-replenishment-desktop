import type { AppState } from "./types"

type NotificationAction = {
  action: "open" | "restock" | "snooze"
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
      ocrExtract: (payload: OcrExtractPayload) => Promise<OcrExtractResult>
      chatComplete: (payload: ChatCompletePayload) => Promise<ChatCompleteResult>
      openExternal: (url: string) => Promise<void>
      showWindow: () => void
      onNotificationAction: (callback: (payload: NotificationAction) => void) => () => void
    }
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
