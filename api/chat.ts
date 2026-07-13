// Vercel Function: /api/chat
//
// 对话补全服务端代理。从服务端环境变量读取 API Key 和模型，
// 浏览器不接触 API Key。
//
// 安全要求：
// - API Key 只存在于 Vercel 服务端环境变量
// - 不在服务端日志中输出 API Key 或完整对话内容
// - 限制消息数量和单条文本长度
// - Web 客户端不能自由指定任意模型，服务端只允许预设模型
// - 单 IP 短时间高频请求返回友好提示

/// <reference types="node" />

// 声明为 Edge Function：代码使用 Web Request/Response API，
// 必须显式声明 edge runtime，否则 Vercel 默认按 Node.js Function 调用会失败。
export const config = { runtime: "edge" }

const CHAT_ENDPOINT = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
const CHAT_TIMEOUT_MS = 45 * 1000
const MAX_MESSAGES = 20
const MAX_MESSAGE_LENGTH = 12000

// 轻量 IP 频率限制：单 IP 60 秒内最多 15 次请求
const RATE_LIMIT_WINDOW_MS = 60 * 1000
const RATE_LIMIT_MAX_REQUESTS = 15

type ChatMessage = {
  role: "system" | "user" | "assistant"
  content: string
}

type ChatResult = { ok: true; content: string } | { ok: false; error: string }

// 内存计数器（Serverless 实例级，非全局精确限流，仅做轻量保护）
const ipRequestMap = new Map<string, { count: number; resetAt: number }>()

function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")
  if (forwarded) return forwarded.split(",")[0].trim()
  const realIp = req.headers.get("x-real-ip")
  if (realIp) return realIp.trim()
  return "unknown"
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = ipRequestMap.get(ip)
  if (!entry || now > entry.resetAt) {
    ipRequestMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return true
  }
  entry.count++
  return entry.count <= RATE_LIMIT_MAX_REQUESTS
}

function jsonResponse(data: ChatResult, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  })
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "仅支持 POST 请求。" }, 405)
  }

  // 轻量 IP 频率限制
  const clientIp = getClientIp(req)
  if (!checkRateLimit(clientIp)) {
    return jsonResponse({ ok: false, error: "请求过于频繁，请稍等片刻再试。" }, 429)
  }

  const apiKey = process.env.DASHSCOPE_API_KEY
  if (!apiKey || !apiKey.trim()) {
    return jsonResponse({ ok: false, error: "比赛体验服务暂时不可用，请稍后重试。" })
  }

  let body: { messages?: unknown; model?: unknown }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ ok: false, error: "请求格式无效，请重试。" })
  }

  const rawMessages = Array.isArray(body.messages) ? body.messages : []
  if (rawMessages.length === 0) {
    return jsonResponse({ ok: false, error: "对话内容为空，请输入问题后重试。" })
  }

  // 限制消息数量和单条文本长度
  const sanitizedMessages: ChatMessage[] = rawMessages
    .slice(-MAX_MESSAGES)
    .map((message: unknown) => {
      const m = message as { role?: string; content?: string }
      return {
        role: m?.role === "assistant" || m?.role === "system" ? m.role : "user",
        content: typeof m?.content === "string" ? m.content.slice(0, MAX_MESSAGE_LENGTH) : ""
      } as ChatMessage
    })
    .filter((m) => m.content.trim())

  if (!sanitizedMessages.length) {
    return jsonResponse({ ok: false, error: "对话内容为空，请输入问题后重试。" })
  }

  // 服务端使用预设模型，忽略客户端传入的 model
  const resolvedModel = process.env.DASHSCOPE_CHAT_MODEL || "qwen-plus"

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS)

  try {
    const response = await fetch(CHAT_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey.trim()}`
      },
      body: JSON.stringify({
        model: resolvedModel,
        messages: sanitizedMessages,
        temperature: 0.2
      }),
      signal: controller.signal
    })

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return jsonResponse({ ok: false, error: "比赛体验服务暂时不可用，请稍后重试。" })
      }
      if (response.status === 429) {
        return jsonResponse({ ok: false, error: "对话服务请求过于频繁，请稍后重试。" })
      }
      let detail = ""
      try {
        const errBody = await response.json() as { error?: { message?: string }; message?: string }
        detail = errBody?.error?.message || errBody?.message || ""
      } catch { /* ignore */ }
      return jsonResponse({
        ok: false,
        error: `对话服务返回错误（${response.status}）${detail ? `：${detail.slice(0, 200)}` : "，请稍后重试。"}`
      })
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== "string" || !content.trim()) {
      return jsonResponse({ ok: false, error: "对话服务没有返回内容，请换个问法重试。" })
    }

    return jsonResponse({ ok: true, content })
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return jsonResponse({ ok: false, error: "对话超时（45 秒），请检查网络后重试。" })
    }
    // 不记录完整错误以避免泄露敏感信息
    return jsonResponse({ ok: false, error: "无法连接对话服务，请检查网络后重试。" })
  } finally {
    clearTimeout(timeout)
  }
}
