// Vercel Function: /api/ocr
//
// 订单截图识别服务端代理。从服务端环境变量读取 API Key 和模型，
// 浏览器不接触 API Key。
//
// 安全要求：
// - API Key 只存在于 Vercel 服务端环境变量
// - 不在服务端日志中输出 API Key、完整图片或完整家庭数据
// - 限制图片 Data URL 大小
// - Web 客户端不能自由指定任意模型，服务端只允许预设模型
// - 单 IP 短时间高频请求返回友好提示

/// <reference types="node" />

const OCR_ENDPOINT = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
const OCR_TIMEOUT_MS = 60 * 1000
const MAX_IMAGE_SIZE = 8 * 1024 * 1024 // 8MB

// 轻量 IP 频率限制：单 IP 60 秒内最多 5 次 OCR 请求（图片识别开销大）
const RATE_LIMIT_WINDOW_MS = 60 * 1000
const RATE_LIMIT_MAX_REQUESTS = 5

type OcrDiagnostics = {
  elapsedSeconds?: number
  promptTokens?: number
  completionTokens?: number
  hasReasoning?: boolean
}

type OcrResult =
  | { ok: true; content: string; diagnostics?: OcrDiagnostics }
  | { ok: false; error: string }

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

function jsonResponse(data: OcrResult, status = 200): Response {
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

  let body: { imageDataUrl?: unknown; prompt?: unknown; model?: unknown }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ ok: false, error: "请求格式无效，请重试。" })
  }

  const imageDataUrl = typeof body.imageDataUrl === "string" ? body.imageDataUrl : ""
  if (!imageDataUrl.startsWith("data:image/")) {
    return jsonResponse({ ok: false, error: "图片数据无效，请重新选择截图。" })
  }

  // 限制图片大小
  if (imageDataUrl.length > MAX_IMAGE_SIZE) {
    return jsonResponse({ ok: false, error: "图片过大，请压缩后重试。" })
  }

  const prompt = typeof body.prompt === "string" ? body.prompt : ""
  if (!prompt.trim()) {
    return jsonResponse({ ok: false, error: "识别指令无效。" })
  }

  // 服务端使用预设模型，忽略客户端传入的 model
  const resolvedModel = process.env.DASHSCOPE_OCR_MODEL || "qwen3-vl-plus"

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS)
  const startedAt = Date.now()

  try {
    const basePayload = {
      model: resolvedModel,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageDataUrl } },
            { type: "text", text: prompt }
          ]
        }
      ],
      // 提取任务不需要思维链：关闭思考模式可大幅降低延迟
      enable_thinking: false,
      max_tokens: 1280,
      temperature: 0.1
    }

    const doRequest = (payload: Record<string, unknown>) => fetch(OCR_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey.trim()}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    })

    let response = await doRequest(basePayload)
    // 个别模型不接受 enable_thinking 参数：报参数错误时去掉该字段重试一次
    if (response.status === 400) {
      const errText = await response.clone().text().catch(() => "")
      if (/enable_thinking/i.test(errText)) {
        const { enable_thinking: _removed, ...fallbackPayload } = basePayload
        response = await doRequest(fallbackPayload)
      }
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return jsonResponse({ ok: false, error: "比赛体验服务暂时不可用，请稍后重试。" })
      }
      if (response.status === 429) {
        return jsonResponse({ ok: false, error: "识别服务请求过于频繁，请稍后重试。" })
      }
      let detail = ""
      try {
        const errBody = await response.json() as { error?: { message?: string }; message?: string }
        detail = errBody?.error?.message || errBody?.message || ""
      } catch { /* ignore */ }
      return jsonResponse({
        ok: false,
        error: `识别服务返回错误（${response.status}）${detail ? `：${detail.slice(0, 200)}` : "，请稍后重试。"}`
      })
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const message = data?.choices?.[0]?.message
    const content = message?.content
    const usage = data?.usage || {}
    const hasReasoning = typeof message?.reasoning_content === "string" && message.reasoning_content.length > 0
    const elapsedSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(1))

    if (typeof content !== "string" || !content.trim()) {
      return jsonResponse({
        ok: false,
        error: hasReasoning
          ? "模型只输出了思考过程没有给出结果，请在服务端确认使用的是非思考型视觉模型。"
          : "识别服务没有返回内容，请换一张更清晰的截图重试。"
      })
    }

    return jsonResponse({
      ok: true,
      content,
      diagnostics: {
        elapsedSeconds,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        hasReasoning
      }
    })
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return jsonResponse({ ok: false, error: "识别超时，请检查网络后重试。" })
    }
    // 不记录完整错误以避免泄露敏感信息
    return jsonResponse({ ok: false, error: "无法连接识别服务，请检查网络后重试。" })
  } finally {
    clearTimeout(timeout)
  }
}
