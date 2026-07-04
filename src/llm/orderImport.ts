import type { PurchaseOption, ReplenishmentItem } from "../types"
import { PLATFORM_OPTIONS } from "../types"

/**
 * 默认识别模型。需要通用视觉理解模型（VLM）而非 OCR 特化模型：
 * 平台判断、价格语义定位、截断商品名补全、与商品库的语义匹配都依赖推理能力。
 * 可在设置中覆盖为 DashScope 上更新的模型 ID。
 */
export const DEFAULT_ORDER_MODEL = "qwen3-vl-plus"
export const FAST_ORDER_MODEL = "qwen-vl-plus-latest"
export type OrderRecognitionMode = "accurate" | "fast"

/** 传给模型的消耗品目录：物品名 + 其常购商品名列表 */
export type OrderCatalogEntry = {
  name: string
  options: string[]
}

/** 截图中识别出的单个商品条目（原始识别结果） */
export type ExtractedOrderLine = {
  /** 截图中的完整商品标题 */
  productName: string
  /** 去掉促销前缀后的品牌+产品名（如“皇家猫粮 L40”） */
  brandName?: string
  /** 用于家庭补货展示和匹配的核心商品名（如“米家免洗扫拖机器配件”） */
  coreName?: string
  /** 购买数量，识别不出时为 1 */
  qty: number
  /** 该条目实付总价（元），识别不出为 undefined */
  price?: number
  /** 单件商品含量数值（从标题规格提取，如 2kg → 2） */
  measureAmount?: number
  /** 含量单位（如 kg、ml、抽） */
  measureUnit?: string
  /** 模型判断的最匹配消耗品名称（来自用户目录），无匹配为 undefined */
  matchedItemName?: string
  /** 模型判断的最匹配常购商品名称（来自该消耗品的常购商品列表） */
  matchedOptionName?: string
  /** 该商品对应的通用消耗品名称（如“猫粮”），用于新建物品 */
  genericName?: string
}

export type ExtractedOrder = {
  platform?: string
  /** 订单日期时间戳（当天 00:00），识别不出为 undefined */
  orderDate?: number
  lines: ExtractedOrderLine[]
}

export function buildOrderExtractPrompt(catalog: OrderCatalogEntry[]): string {
  const compactCatalog = catalog
    .filter((entry) => entry.name.trim())
    .slice(0, 50)
    .map((entry) => ({ ...entry, options: entry.options.filter(Boolean).slice(0, 4) }))
  const catalogText = compactCatalog.length
    ? compactCatalog.map((entry) => entry.options.length
        ? `- ${entry.name}（常购：${entry.options.join("、")}）`
        : `- ${entry.name}`
      ).join("\n")
    : "（暂无）"
  return [
    "从订单/购物小票/支付记录截图中提取商品条目，只输出 JSON，不要解释或代码块。",
    "",
    "用户消耗品目录（括号内为常购商品候选，仅用于匹配）：",
    catalogText,
    "",
    "JSON：",
    "{",
    '  "platform": 购买平台，只能取 ["拼多多","淘宝","京东","抖音","1688","美团外卖","其他"] 之一，判断不出则 null,',
    '  "orderDate": 下单或支付日期，格式 "YYYY-MM-DD"，识别不出则 null,',
    '  "items": [',
    "    {",
    '      "productName": 截图中的完整商品标题原文（字符串，不要自行截断）,',
    '      "brandName": 去掉促销前缀后的品牌+产品名，如"皇家猫粮L40"（字符串）,',
    '      "coreName": 去掉店铺名、副厂品牌、营销词和冗余适配前缀后的核心商品名，如"米家免洗扫拖机器配件"（字符串）,',
    '      "qty": 购买数量（正整数，识别不出填 1）,',
    '      "price": 该条目实付总价，单位元（数字），识别不出则 null,',
    '      "measureAmount": 单件商品的含量数值，从商品标题的规格中提取，如"2kg"→2、"500ml"→500、"100抽"→100，识别不出则 null,',
    '      "measureUnit": 含量单位，如"kg"、"g"、"L"、"ml"、"抽"、"片"、"卷"，识别不出则 null,',
    '      "matchedItem": 目录中语义最匹配的消耗品名称；没有合适的则 null,',
    '      "matchedOption": matchedItem 对应常购商品列表中最匹配的一个名称；没有则 null,',
    '      "genericName": 该商品对应的通用消耗品名称，如"卫生纸"、"洗衣液"、"猫粮"（字符串）',
    "    }",
    "  ]",
    "}",
    "",
    "规则：",
    "1. productName 保留截图完整标题；brandName 去掉促销别名，保留品牌+产品名；",
    "2. coreName 用于家庭记录，要短，去掉店铺名、副厂品牌、促销词、冗余适配前缀；保留品牌、型号、设备对象、品类和关键规格；",
    "3. “适配 XX 的 YY 配件”输出为“XX YY 配件”或“XX 配件”。例：“奥兰斯适配小米米家免洗扫拖机器配件”→“米家免洗扫拖机器配件”；",
    "4. coreName 通常 4 到 14 个中文字；型号重要时保留，如“皇家猫粮 L40”；不要把完整标题原样复制到 coreName；",
    "5. 标题被截断时可按常识补全，不要保留省略号；",
    "6. platform 按页面线索判断；不确定填 null；",
    "7. price 取该商品自身实付价；不要把订单合计、运费、配送费、优惠券当商品价格；",
    "8. 忽略运费、配送费、打包费、优惠券、红包、税费、隐私信息；同商品多行要合并；",
    "9. matchedItem 必须严格来自目录物品名；matchedOption 必须严格来自该物品常购列表；宁可 null，不要编造。"
  ].join("\n")
}

function asCleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function asPositiveNumber(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function parseOrderDate(value: unknown): number | undefined {
  const text = asCleanString(value)
  if (!text) return undefined
  const match = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (!match) return undefined
  const [, year, month, day] = match.map(Number)
  const date = new Date(year, month - 1, day)
  date.setHours(0, 0, 0, 0)
  const timestamp = date.getTime()
  // 拒绝明显异常的日期（如识别错乱产生的 1970/2099）
  const now = Date.now()
  const fiveYearsMs = 5 * 365 * 24 * 60 * 60 * 1000
  if (!Number.isFinite(timestamp) || timestamp > now + 24 * 60 * 60 * 1000 || timestamp < now - fiveYearsMs) return undefined
  return timestamp
}

function normalizePlatform(value: unknown): string | undefined {
  const text = asCleanString(value)
  if (!text) return undefined
  return PLATFORM_OPTIONS.includes(text) ? text : "其他"
}

/** 本地模糊匹配兜底：模型没给 matchedItem 时，用包含关系再试一次。 */
export function fuzzyMatchItem(texts: Array<string | undefined>, items: ReplenishmentItem[]): ReplenishmentItem | undefined {
  const haystacks = texts.filter((text): text is string => Boolean(text))
  for (const item of items) {
    const needle = item.name.trim()
    if (!needle) continue
    if (haystacks.some((text) => text.includes(needle))) return item
  }
  return undefined
}

/** 常购商品层的模糊匹配：商品名与识别文本互相包含即视为命中。 */
export function fuzzyMatchOption(item: ReplenishmentItem, texts: Array<string | undefined>): PurchaseOption | undefined {
  const haystacks = texts.filter((text): text is string => Boolean(text))
  for (const option of item.purchaseOptions || []) {
    const needle = option.productName.trim()
    if (!needle) continue
    if (haystacks.some((text) => text.includes(needle) || needle.includes(text))) return option
  }
  return undefined
}

/**
 * 读取图片文件并压缩为 JPEG data URL：
 * 长边超过 maxEdge 时等比缩小，控制上传体积与识别成本；小图直接原样返回。
 */
export function fileToCompressedDataUrl(file: File, maxEdge = 1280, quality = 0.78): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error("图片读取失败"))
    reader.onload = () => {
      const original = String(reader.result || "")
      if (!original.startsWith("data:image/")) {
        reject(new Error("不是有效的图片文件"))
        return
      }
      const image = new Image()
      image.onerror = () => reject(new Error("图片解码失败"))
      image.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(image.width, image.height))
        if (scale >= 1 && file.size < 450 * 1024) {
          resolve(original)
          return
        }
        const canvas = document.createElement("canvas")
        canvas.width = Math.max(1, Math.round(image.width * scale))
        canvas.height = Math.max(1, Math.round(image.height * scale))
        const context = canvas.getContext("2d")
        if (!context) {
          resolve(original)
          return
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL("image/jpeg", quality))
      }
      image.src = original
    }
    reader.readAsDataURL(file)
  })
}

/**
 * 调用识别服务并解析结果。优先走 Electron 主进程代理（无 CORS 限制）；
 * 浏览器预览模式下直接请求 DashScope，可能受 CORS 限制。
 */
export async function extractOrderFromImage(
  apiKey: string,
  imageDataUrl: string,
  catalog: OrderCatalogEntry[],
  model?: string,
  mode: OrderRecognitionMode = "accurate"
): Promise<{ ok: true; order: ExtractedOrder } | { ok: false; error: string }> {
  const prompt = buildOrderExtractPrompt(catalog)
  const resolvedModel = model?.trim() || (mode === "fast" ? FAST_ORDER_MODEL : DEFAULT_ORDER_MODEL)
  let content: string
  if (window.desktop?.ocrExtract) {
    const result = await window.desktop.ocrExtract({ apiKey, model: resolvedModel, imageDataUrl, prompt })
    if (!result.ok) return { ok: false, error: result.error }
    if (result.diagnostics) {
      console.log(`[orderImport] model=${resolvedModel} elapsed=${result.diagnostics.elapsedSeconds}s completion_tokens=${result.diagnostics.completionTokens} reasoning=${result.diagnostics.hasReasoning}`)
    }
    content = result.content
  } else {
    try {
      const response = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: resolvedModel,
          messages: [{
            role: "user",
            content: [
              { type: "image_url", image_url: { url: imageDataUrl } },
              { type: "text", text: prompt }
            ]
          }],
          // 提取任务不需要思维链：关闭思考模式可大幅降低延迟
          enable_thinking: false,
          max_tokens: 2048,
          temperature: 0.1
        })
      })
      if (!response.ok) {
        return { ok: false, error: `识别服务返回错误（${response.status}），请稍后重试。` }
      }
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
      const raw = data?.choices?.[0]?.message?.content
      if (typeof raw !== "string" || !raw.trim()) {
        return { ok: false, error: "识别服务没有返回内容，请换一张更清晰的截图重试。" }
      }
      content = raw
    } catch {
      return { ok: false, error: "无法连接识别服务（浏览器预览模式可能受跨域限制，请在桌面应用中使用）。" }
    }
  }
  const order = parseOrderExtractResponse(content)
  if (!order) {
    return { ok: false, error: "没有从截图中识别出商品条目，请确认是订单或购物明细截图后重试。" }
  }
  return { ok: true, order }
}

/**
 * 解析模型返回内容。容错：
 * - 剥掉 ```json 围栏；
 * - 内容前后混入解释文字时，截取第一个 { 到最后一个 }；
 * - 单条 item 非法则丢弃，不影响其余。
 */
export function parseOrderExtractResponse(content: string): ExtractedOrder | null {
  let text = content.trim()
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) text = fenceMatch[1].trim()
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
  const raw = parsed as Record<string, unknown>
  const rawItems = Array.isArray(raw.items) ? raw.items : []
  const lines = rawItems.flatMap((entry): ExtractedOrderLine[] => {
    if (typeof entry !== "object" || entry === null) return []
    const record = entry as Record<string, unknown>
    const productName = asCleanString(record.productName)
    if (!productName) return []
    const qtyRaw = asPositiveNumber(record.qty)
    return [{
      productName,
      brandName: asCleanString(record.brandName),
      coreName: asCleanString(record.coreName),
      qty: qtyRaw ? Math.round(qtyRaw) : 1,
      price: asPositiveNumber(record.price),
      measureAmount: asPositiveNumber(record.measureAmount),
      measureUnit: asCleanString(record.measureUnit),
      matchedItemName: asCleanString(record.matchedItem),
      matchedOptionName: asCleanString(record.matchedOption),
      genericName: asCleanString(record.genericName)
    }]
  })
  if (!lines.length) return null
  return {
    platform: normalizePlatform(raw.platform),
    orderDate: parseOrderDate(raw.orderDate),
    lines
  }
}
