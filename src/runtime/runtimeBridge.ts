// Runtime Bridge: 统一 Electron 桌面端与 Web 端的 LLM / OCR / 外链调用差异。
//
// Electron 环境 → window.desktop IPC
// Web 环境 → /api/chat 和 /api/ocr（Vercel Functions），API Key 由服务端环境变量管理
//
// 行为要求：
// - Electron 和 Web API 返回值使用同一种结构
// - 保持当前错误文案与超时降级逻辑
// - Web 模式不发送 apiKey 到服务端（服务端使用 env var）

/** 是否处于 Electron 桌面运行时 */
export const isDesktopRuntime: boolean = Boolean(
  typeof window !== "undefined" && (window as { desktop?: unknown }).desktop
)

/** 是否处于 Web（浏览器）运行时 */
export const isWebRuntime: boolean = !isDesktopRuntime

type ChatMessagePayload = {
  role: "system" | "user" | "assistant"
  content: string
}

type ChatCompletePayload = {
  apiKey: string
  model?: string
  messages: ChatMessagePayload[]
}

type OcrExtractDiagnostics = {
  elapsedSeconds?: number
  promptTokens?: number
  completionTokens?: number
  hasReasoning?: boolean
}

type ChatCompleteResult = { ok: true; content: string } | { ok: false; error: string }

type OcrExtractPayload = {
  apiKey: string
  model?: string
  imageDataUrl: string
  prompt: string
}

type OcrExtractResult =
  | { ok: true; content: string; diagnostics?: OcrExtractDiagnostics }
  | { ok: false; error: string }

/**
 * 对话补全：Electron 走 IPC，Web 走 /api/chat。
 * Web 模式不发送 apiKey（服务端使用 DASHSCOPE_API_KEY 环境变量）。
 */
export async function chatComplete(payload: ChatCompletePayload): Promise<ChatCompleteResult> {
  if (isDesktopRuntime) {
    if (window.desktop?.chatComplete) {
      return window.desktop.chatComplete({
        apiKey: payload.apiKey,
        model: payload.model?.trim() || undefined,
        messages: payload.messages
      })
    }
    // Desktop runtime 但 chatComplete 未就绪（preload 未注入）
    return { ok: false, error: "当前窗口还没有加载家庭问答服务，请关闭并重新启动 403家庭管家后再试。" }
  }

  // Web 模式：调用 Vercel Function，不传 apiKey
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: payload.messages,
        model: payload.model?.trim() || undefined
      })
    })
    if (!response.ok) {
      return { ok: false, error: `对话服务返回错误（${response.status}），请稍后重试。` }
    }
    const data = (await response.json()) as ChatCompleteResult
    return data
  } catch {
    return { ok: false, error: "无法连接对话服务，请检查网络后重试。" }
  }
}

/**
 * 图片识别：Electron 走 IPC，Web 走 /api/ocr。
 * Web 模式不发送 apiKey（服务端使用 DASHSCOPE_API_KEY 环境变量）。
 */
export async function ocrExtract(payload: OcrExtractPayload): Promise<OcrExtractResult> {
  if (isDesktopRuntime) {
    if (window.desktop?.ocrExtract) {
      return window.desktop.ocrExtract({
        apiKey: payload.apiKey,
        model: payload.model?.trim() || undefined,
        imageDataUrl: payload.imageDataUrl,
        prompt: payload.prompt
      })
    }
    // Desktop runtime 但 ocrExtract 未就绪（preload 未注入）
    return { ok: false, error: "当前窗口还没有加载识别服务，请关闭并重新启动 403家庭管家后再试。" }
  }

  // Web 模式：调用 Vercel Function，不传 apiKey
  try {
    const response = await fetch("/api/ocr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageDataUrl: payload.imageDataUrl,
        prompt: payload.prompt,
        model: payload.model?.trim() || undefined
      })
    })
    if (!response.ok) {
      return { ok: false, error: `识别服务返回错误（${response.status}），请稍后重试。` }
    }
    const data = (await response.json()) as OcrExtractResult
    return data
  } catch {
    return { ok: false, error: "无法连接识别服务，请检查网络后重试。" }
  }
}

/**
 * 打开外部链接：Electron 走 shell.openExternal，Web 用 window.open。
 */
export async function openExternal(url: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (isDesktopRuntime) {
    if (window.desktop?.openExternal) {
      await window.desktop.openExternal(url)
      return { ok: true }
    }
    return { ok: false, error: "当前窗口还没有加载外链服务，请关闭并重新启动 403家庭管家后再试。" }
  }

  // Web 模式：安全地在新标签页打开
  try {
    const target = new URL(url)
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return { ok: false, error: "仅支持 http 和 https 链接" }
    }
    window.open(target.toString(), "_blank", "noopener,noreferrer")
    return { ok: true }
  } catch {
    return { ok: false, error: "Invalid URL" }
  }
}

/**
 * 判断当前运行时是否有可用的对话服务。
 * Desktop：需要 window.desktop.chatComplete
 * Web：始终可用（服务端配置了 API Key）
 */
export function hasChatService(): boolean {
  if (isDesktopRuntime) {
    return Boolean(window.desktop?.chatComplete)
  }
  return true
}

/**
 * 判断当前运行时是否需要用户在设置中填写 API Key。
 * Desktop：需要用户填写
 * Web：不需要（服务端管理）
 */
export function requiresUserApiKey(): boolean {
  return isDesktopRuntime
}
