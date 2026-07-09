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
  state: AppState
  itemViews: HouseholdChatItemView[]
  dateContext: ChatDateContext
  /** 可注入的 LLM 客户端；单测传 mock，真实运行时由内部构造 */
  client?: TurnInterpreterLlmClient
}

/** LLM 允许返回的 intent 子集（比本地 TurnIntent 窄，去除 force_proposal 等）。 */
export type LlmTurnIntent =
  | "supplement_current_collection"
  | "correct_current_collection"
  | "new_restock_record"
  | "confirm_current_task"
  | "cancel_current_task"
  | "query_inventory"
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
  "smalltalk",
  "unknown"
])

/**
 * 调用 LLM 解释当前这一轮输入，返回结构化 TurnInterpretation 或 null。
 *
 * 返回 null 的情况（调用方应转 clarification）：
 *   - LLM 调用失败
 *   - JSON 解析失败
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
  const client = input.client ?? createDesktopTurnInterpreterLlmClient(input.state)
  if (!client) return null

  const prompt = buildInterpreterPrompt(input)
  let raw: string
  try {
    raw = await client.complete(prompt)
  } catch {
    return null
  }

  const parsed = parseLlmTurnInterpretation(raw)
  if (!parsed) return null

  // 低置信 / unknown / 空字段 supplement → 转 null（调用方走 clarification）
  if (parsed.confidence === "low") return null
  if (parsed.intent === "unknown") return null
  if (
    parsed.intent === "supplement_current_collection" &&
    Object.keys(parsed.fields).length === 0
  ) {
    return null
  }

  return normalizeLlmInterpretation(parsed)
}

/**
 * 构造给 LLM 的解释 prompt。明确告诉模型：你在解释用户这一轮输入，不是在聊天回复。
 */
function buildInterpreterPrompt(input: AskTurnInterpreterLlmInput): string {
  const { text, pendingCollection, state, itemViews, dateContext } = input
  const lines: string[] = []

  lines.push("你是一个家庭补货记录采集助手。你不是在聊天回复用户，而是在解释用户这一轮输入的真实意图。")
  lines.push("只输出一个 JSON 对象，不要输出任何解释性文字、不要用 markdown 代码块包裹。")
  lines.push("")

  lines.push("【任务】")
  lines.push("结合当前正在采集的补货记录，判断用户这一轮输入属于以下哪一类：")
  lines.push("- supplement_current_collection：补当前草稿字段（平台/价格/评价/数量/日期等）")
  lines.push("- correct_current_collection：修正当前草稿（如「不是 X，是 Y」改物品名）")
  lines.push("- new_restock_record：开启一条全新的补货记录（物品名与当前不同）")
  lines.push("- confirm_current_task：确认保存当前记录")
  lines.push("- cancel_current_task：取消当前记录")
  lines.push("- query_inventory：查询库存/还能用多久")
  lines.push("- smalltalk：闲聊/寒暄/身份问题")
  lines.push("- unknown：确实无法判断")
  lines.push("")

  lines.push("【平台别名归一化规则】")
  lines.push("如果用户输入是平台或平台别名，把 platform 归一为标准名：")
  lines.push("- 拼夕夕 / pdd / p'd'd / 多多 → 拼多多")
  lines.push("- 狗东 / 东哥 → 京东")
  lines.push("- 淘系 / 某宝 → 淘宝")
  lines.push("- 天猫 / tmall → 天猫")
  lines.push("注意：不要只依赖这几条示例，遇到其他平台别名也尽量归一。")
  lines.push("")

  lines.push("【指代消解规则】")
  lines.push("- 「上次那个平台 / 还是上次买的那个 / 就之前那家」→ 取该物品历史中最近一次的平台")
  lines.push("- 「比上次便宜 / 这次贵了点」→ 仍是 supplement_current_collection，reason 说明价格对比意图")
  lines.push("")

  lines.push("【输出 JSON schema】")
  lines.push('{')
  lines.push('  "intent": "supplement_current_collection | correct_current_collection | new_restock_record | confirm_current_task | cancel_current_task | query_inventory | smalltalk | unknown",')
  lines.push('  "fields": {')
  lines.push('    "itemName": "可选，物品名",')
  lines.push('    "quantity": "可选，数字",')
  lines.push('    "unit": "可选，单位",')
  lines.push('    "date": "可选，日期",')
  lines.push('    "price": "可选，数字",')
  lines.push('    "platform": "可选，归一后的标准平台名",')
  lines.push('    "review": "可选，评价原文"')
  lines.push('  },')
  lines.push('  "confidence": "high | medium | low",')
  lines.push('  "reason": "一句话说明判断依据"')
  lines.push('}')
  lines.push("只填入能确定的字段，不确定的字段不要硬编造。")
  lines.push("")

  lines.push("【当前时间】")
  lines.push(`今天是 ${dateContext.todayLabel}，当前时间 ${dateContext.timestampLabel}，时区 ${dateContext.timezone}。`)
  lines.push("")

  lines.push("【当前正在采集的补货记录】")
  if (pendingCollection) {
    const f = describeCollectionDraft(pendingCollection)
    lines.push(`物品名：${f.itemName ?? "（未定）"}`)
    if (f.qty !== undefined) lines.push(`数量：${f.qty}${f.unit ?? ""}`)
    if (f.platform) lines.push(`平台：${f.platform}`)
    if (f.price !== undefined) lines.push(`价格：${f.price}`)
    if (f.review) lines.push(`评价：${f.review}`)
    const missing = [...pendingCollection.requiredMissingSlots, ...pendingCollection.qualityMissingSlots]
    lines.push(`当前缺失字段：${missing.length > 0 ? missing.join("、") : "（无）"}`)
  } else {
    lines.push("（无正在采集的记录）")
  }
  lines.push("")

  lines.push("【该物品的历史补货平台（用于指代消解）】")
  const historyPlatforms = collectHistoryPlatforms(pendingCollection, state, itemViews)
  if (historyPlatforms.length > 0) {
    lines.push(historyPlatforms.join("、"))
  } else {
    lines.push("（无历史平台记录）")
  }
  lines.push("")

  lines.push("【用户这一轮输入】")
  lines.push(text)

  return lines.join("\n")
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

/** 校验解析后的对象是否符合 schema。 */
function validateLlmTurnInterpretation(obj: unknown): LlmTurnInterpretation | null {
  if (!obj || typeof obj !== "object") return null
  const o = obj as Record<string, unknown>

  const intent = o.intent
  if (typeof intent !== "string" || !VALID_LLM_INTENTS.has(intent as LlmTurnIntent)) {
    return null
  }

  const fieldsRaw = o.fields
  if (!fieldsRaw || typeof fieldsRaw !== "object") return null
  const f = fieldsRaw as Record<string, unknown>
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

  const confidence = o.confidence
  if (confidence !== "high" && confidence !== "medium" && confidence !== "low") return null

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
 * 构造真实运行时的 LLM 客户端（接 window.desktop.chatComplete）。
 * 仅在浏览器/Electron 主世界有 desktop bridge 时可用；否则返回 null。
 *
 * 注意：本函数不导入 householdChat 的 askHouseholdAssistant——那个函数用对话式 prompt，
 * 这里需要纯 JSON 输出，因此独立构造请求。
 */
function createDesktopTurnInterpreterLlmClient(state: AppState): TurnInterpreterLlmClient | null {
  const apiKey = state.settings?.aiApiKey
  const model = (state.settings?.aiChatModel ?? state.settings?.aiModel)?.trim()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const desktop = (globalThis as any).window?.desktop
  if (!desktop?.chatComplete || !apiKey) return null

  return {
    async complete(prompt: string): Promise<string> {
      const result = await desktop.chatComplete({
        apiKey,
        model: model || "gpt-4o-mini",
        messages: [{ role: "system", content: prompt }]
      })
      if (!result?.ok) {
        throw new Error(typeof result?.error === "string" ? result.error : "llm failed")
      }
      return result.content
    }
  }
}
