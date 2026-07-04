import { calculateConsumption, DEFAULT_CYCLES, estimateRemainingQty, formatDate, formatPrice } from "../domain"
import { calculateMonthlySpend } from "../pure-logic.mjs"
import type { AppState, ItemComputed, ReplenishmentItem } from "../types"
import { describeAgentDraft, type AgentDraft, type AgentDraftStatus } from "../agent/drafts"

const DEFAULT_CHAT_MODEL = "qwen-plus"

/** 管家在对话中提议的创建动作；由用户在确认清单里确认后才真正写入。 */
export type ChatProposedAction =
  | { type: "createCategory"; name: string }
  | { type: "createItem"; name: string; category: string; cycleDays: number; bufferDays: number; unit: string }
  | { type: "addPurchaseOption"; itemName: string; productName: string; unit: string }

/** 创建成功后消息里附带的跳转入口 */
export type ChatMessageLink = {
  label: string
  target: { kind: "item"; itemId: string } | { kind: "category"; category: string }
}

export type HouseholdChatMessage = {
  role: "user" | "assistant"
  content: string
  /** 该条管家消息附带的创建提案；undefined 表示纯文本消息 */
  actions?: ChatProposedAction[]
  /** pending：等待确认；confirmed / cancelled：已处理；superseded：被修订后的新清单替代 */
  actionStatus?: "pending" | "confirmed" | "cancelled" | "superseded"
  /** 创建结果消息里的跳转入口 */
  links?: ChatMessageLink[]
  /** 新版可确认 agent 草稿；只有本地确认后才写入。 */
  agentDraft?: AgentDraft
  draftStatus?: AgentDraftStatus
  /** 订单截图导入后的批量待确认草稿；每条独立标记 pending/confirmed/cancelled。批量确认前不写入 state。 */
  agentDraftBatch?: AgentDraft[]
  batchDraftStatuses?: AgentDraftStatus[]
  /** 批量草稿确认后的写入结果摘要与跳转入口 */
  batchResult?: { summary: string; links: ChatMessageLink[] }
}

/** 把待确认清单序列化进下一轮上下文，让模型知道自己在修订什么 */
export function describeActionLine(action: ChatProposedAction): string {
  if (action.type === "createCategory") return `- 分类：${action.name}`
  if (action.type === "createItem") return `- 消耗品：${action.name}，分类 ${action.category}，周期 ${action.cycleDays} 天，单位 ${action.unit}`
  return `- 常购商品：${action.productName}，挂到消耗品「${action.itemName}」`
}

type HouseholdChatItemView = {
  item: ReplenishmentItem
  computed: ItemComputed
}

function latestHistory(item: ReplenishmentItem) {
  return item.history[item.history.length - 1]
}

function averagePrice(item: ReplenishmentItem): number | null {
  const priced = item.history.filter((event) => Number.isFinite(event.price) && event.price! > 0)
  if (!priced.length) return null
  return priced.reduce((total, event) => total + event.price!, 0) / priced.length
}

function formatOptionalPrice(value: number | null | undefined): string {
  return Number.isFinite(value) && value! > 0 ? `¥${formatPrice(value!)}` : "未记录"
}

function buildItemLine({ item, computed }: HouseholdChatItemView): string {
  const latest = latestHistory(item)
  const consumption = calculateConsumption(item)
  const remainingQty = estimateRemainingQty(item)
  const defaultOption = item.purchaseOptions.find((option) => option.isDefault) || item.purchaseOptions[0]
  const latestProduct = latest?.purchaseProductName || defaultOption?.productName || "未记录"
  const latestPlatform = latest?.platform || item.platform || defaultOption?.platform || "未记录"
  const latestQty = latest?.qty ? `${latest.qty}${latest.purchaseUnit || item.unit || "件"}` : item.defaultQty ? `${item.defaultQty}${item.unit || "件"}` : "未记录"
  const latestReview = latest?.review || defaultOption?.review || "未记录"
  const rating = latest?.rating ? `${latest.rating}/3` : "未记录"
  const optionNames = item.purchaseOptions.map((option) => option.productName).filter(Boolean).slice(0, 4).join("；") || "未记录"

  return [
    `- ${item.name}`,
    `分类：${item.category || "未分类"}`,
    `状态：${computed.statusLabel}`,
    `余量：${computed.remainingText}${remainingQty ? `（${remainingQty}）` : ""}`,
    `补货周期：${item.cycleDays} 天，提前 ${item.bufferDays} 天提醒`,
    `上次补货：${item.lastRestockedAt ? formatDate(item.lastRestockedAt) : "未记录"}`,
    `上次购买：${latestProduct}`,
    `购买量：${latestQty}`,
    `平台/商家：${latestPlatform}`,
    `最近价格：${formatOptionalPrice(latest?.price ?? item.price)}`,
    `均价：${formatOptionalPrice(averagePrice(item))}`,
    `日均消耗：${consumption.dailyUseText}`,
    `评价：${rating}${latestReview !== "未记录" ? `，${latestReview}` : ""}`,
    `常购选项：${optionNames}`
  ].join("；")
}

function buildBudgetLine(state: AppState): string {
  const budget = state.settings.monthlyBudget
  const monthlySpend = calculateMonthlySpend(state.items)
  if (!budget || budget <= 0) {
    return `预算信息：每月预算未设置；本月已记录补货支出 ¥${formatPrice(monthlySpend)}。`
  }

  const percent = Math.round((monthlySpend / budget) * 100)
  const remaining = budget - monthlySpend
  const remainingText = remaining >= 0 ? `剩余额度 ¥${formatPrice(remaining)}` : `已超出 ¥${formatPrice(Math.abs(remaining))}`
  return `预算信息：每月预算 ¥${formatPrice(budget)}；本月已记录补货支出 ¥${formatPrice(monthlySpend)}；预算使用率 ${percent}%；${remainingText}。`
}

function selectContextItems(question: string, itemViews: HouseholdChatItemView[]): HouseholdChatItemView[] {
  const normalized = question.trim().toLocaleLowerCase("zh-CN")
  const urgentOrWarning = itemViews.filter(({ computed }) => computed.displayStatus === "urgent" || computed.displayStatus === "warning")
  if (/预算|还剩|花了|支出|超支/.test(normalized)) {
    return urgentOrWarning.slice(0, 12)
  }
  if (/价格|贵|便宜|异常|均价|多少钱/.test(normalized)) {
    return [...itemViews]
      .filter(({ item }) => item.history.some((event) => Number.isFinite(event.price) && event.price! > 0) || item.price)
      .sort((a, b) => b.item.updatedAt - a.item.updatedAt)
      .slice(0, 30)
  }
  if (/缺|没有|补全|信息|平台|评价/.test(normalized)) {
    return [...itemViews]
      .filter(({ item }) => {
        const latest = latestHistory(item)
        return !item.history.some((event) => Number.isFinite(event.price) && event.price! > 0) ||
          !(latest?.platform || item.platform || item.purchaseOptions.some((option) => option.platform)) ||
          !(latest?.review || item.purchaseOptions.some((option) => option.review))
      })
      .slice(0, 40)
  }
  if (/全部|所有|库存|清单|列表/.test(normalized)) {
    return [...urgentOrWarning, ...itemViews.filter(({ computed }) => computed.displayStatus === "normal").slice(0, 28)].slice(0, 40)
  }
  const mentioned = itemViews.filter(({ item }) => normalized.includes(item.name.toLocaleLowerCase("zh-CN")))
  if (mentioned.length) return mentioned.slice(0, 12)
  return [...urgentOrWarning, ...[...itemViews].sort((a, b) => a.computed.dueAt - b.computed.dueAt)].slice(0, 30)
}

function buildHouseholdContext(state: AppState, itemViews: HouseholdChatItemView[], question: string): string {
  const contextItems = selectContextItems(question, itemViews)
  const urgent = itemViews.filter(({ computed }) => computed.displayStatus === "urgent")
  const warning = itemViews.filter(({ computed }) => computed.displayStatus === "warning")
  const safe = itemViews.filter(({ computed }) => computed.displayStatus === "normal")
  const missingPrice = itemViews.filter(({ item }) => !item.history.some((event) => Number.isFinite(event.price) && event.price! > 0))
  const missingPlatform = itemViews.filter(({ item }) => {
    const latest = latestHistory(item)
    return !(latest?.platform || item.platform || item.purchaseOptions.some((option) => option.platform))
  })

  const orderedItems = [...contextItems]
    .sort((a, b) => a.computed.dueAt - b.computed.dueAt)
    .map(buildItemLine)
    .join("\n")

  return [
    "当前家庭消耗品数据如下。请只基于这些数据回答；不确定时直接说明还缺什么记录。",
    `总数：${itemViews.length} 项。急需补充：${urgent.length} 项。快用完：${warning.length} 项。充足：${safe.length} 项。`,
    `缺少价格记录：${missingPrice.map(({ item }) => item.name).slice(0, 12).join("、") || "无"}。`,
    `缺少平台/商家：${missingPlatform.map(({ item }) => item.name).slice(0, 12).join("、") || "无"}。`,
    `分类：${state.categories.join("、") || "无"}。`,
    buildBudgetLine(state),
    `物品明细（按当前问题筛选 ${contextItems.length} 项）：`,
    orderedItems || "暂无物品。"
  ].join("\n")
}

// ---------- 对话创建动作：解析与校验 ----------

const ACTION_BLOCK_PATTERN = /<\s*action\s*>([\s\S]*?)<\s*\/\s*action\s*>/i

function asCleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function normalizeAction(entry: unknown): ChatProposedAction | null {
  if (typeof entry !== "object" || entry === null) return null
  const record = entry as Record<string, unknown>
  if (record.type === "createCategory") {
    const name = asCleanString(record.name)
    return name ? { type: "createCategory", name } : null
  }
  if (record.type === "createItem") {
    const name = asCleanString(record.name)
    if (!name) return null
    const category = asCleanString(record.category) || "其他"
    const cycleRaw = Number(record.cycleDays)
    // 模型没给出合理周期时，先查内置的常见品类周期表，再兜底 30 天
    const matchedDefault = Object.entries(DEFAULT_CYCLES).find(([key]) => name.includes(key))
    const cycleDays = Number.isFinite(cycleRaw) && cycleRaw >= 1
      ? Math.round(cycleRaw)
      : (matchedDefault ? matchedDefault[1] : 30)
    const bufferRaw = Number(record.bufferDays)
    const maxBuffer = Math.max(0, cycleDays - 1)
    const bufferDays = Number.isFinite(bufferRaw) && bufferRaw >= 0
      ? Math.min(Math.round(bufferRaw), maxBuffer)
      : Math.min(2, maxBuffer)
    const unit = asCleanString(record.unit) || "件"
    return { type: "createItem", name, category, cycleDays, bufferDays, unit }
  }
  if (record.type === "addPurchaseOption") {
    const itemName = asCleanString(record.itemName)
    const productName = asCleanString(record.productName)
    if (!itemName || !productName) return null
    return { type: "addPurchaseOption", itemName, productName, unit: asCleanString(record.unit) || "" }
  }
  return null
}

/**
 * 品牌商品名必须来自用户原话（防止模型编造品牌）：
 * 剥掉物品名和规格字符后，品牌部分与用户消息做整体或双字比对。
 */
function isProductNameFromUser(productName: string, itemName: string, userText: string): boolean {
  const brandPart = productName.split(itemName).join("").trim()
  if (!brandPart) return false
  if (userText.includes(brandPart)) return true
  const cleaned = brandPart.replace(/[\d０-９a-zA-Z×xX*\/\s·．.\-]+/g, "")
  if (!cleaned) return false
  for (let i = 0; i + 2 <= cleaned.length; i++) {
    if (userText.includes(cleaned.slice(i, i + 2))) return true
  }
  return cleaned.length === 1 && userText.includes(cleaned)
}

function findJsonObjectEnd(source: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < source.length; index++) {
    const char = source[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === "\"") {
        inString = false
      }
      continue
    }
    if (char === "\"") {
      inString = true
    } else if (char === "{") {
      depth += 1
    } else if (char === "}") {
      depth -= 1
      if (depth === 0) return index
    }
  }

  return -1
}

function normalizeActionsFromParsed(parsed: unknown, userText?: string): ChatProposedAction[] {
  if (typeof parsed !== "object" || parsed === null) return []
  const entries = Array.isArray((parsed as Record<string, unknown>).actions)
    ? (parsed as { actions: unknown[] }).actions
    : []
  return entries
    .map(normalizeAction)
    .filter((action): action is ChatProposedAction => action !== null)
    .filter((action) =>
      action.type !== "addPurchaseOption"
      || userText === undefined
      || isProductNameFromUser(action.productName, action.itemName, userText)
    )
    .slice(0, 8)
}

function parseActionJson(raw: string, userText?: string): ChatProposedAction[] {
  let source = raw.trim()
  const fenceMatch = source.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) source = fenceMatch[1].trim()

  for (let start = source.indexOf("{"); start !== -1; start = source.indexOf("{", start + 1)) {
    const end = findJsonObjectEnd(source, start)
    if (end <= start) continue
    try {
      const actions = normalizeActionsFromParsed(JSON.parse(source.slice(start, end + 1)), userText)
      if (actions.length) return actions
    } catch {
      // Try the next object-like segment.
    }
  }

  return []
}

function findNakedActionJson(content: string, userText?: string): { raw: string; actions: ChatProposedAction[] } | null {
  for (let start = content.indexOf("{"); start !== -1; start = content.indexOf("{", start + 1)) {
    const end = findJsonObjectEnd(content, start)
    if (end <= start) continue
    const raw = content.slice(start, end + 1)
    try {
      const actions = normalizeActionsFromParsed(JSON.parse(raw), userText)
      if (actions.length) return { raw, actions }
    } catch {
      // Keep scanning; a normal answer may contain braces that are not action JSON.
    }
  }

  return null
}

/**
 * 从模型回复中分离正文与 <action> 动作块。
 * 动作块 JSON 非法或逐条校验后为空时，按纯文本消息降级处理，不阻塞对话。
 * 传入 userText（近几轮用户原话）时，会丢弃品牌名不是用户提过的常购商品动作。
 */
export function parseChatActions(content: string, userText?: string): { text: string; actions: ChatProposedAction[] } {
  const match = content.match(ACTION_BLOCK_PATTERN)
  if (match) {
    const text = content.replace(match[0], "").trim()
    return { text, actions: parseActionJson(match[1], userText) }
  }

  const naked = findNakedActionJson(content, userText)
  if (naked) return { text: content.replace(naked.raw, "").trim(), actions: naked.actions }
  return { text: content.trim(), actions: [] }
}

export function shouldRepairMissingActionBlock(content: string): boolean {
  const text = content.trim()
  if (!text) return false
  if (/取消|不要|不用|放弃|先不|暂不/.test(text)) return false
  return /创建|新建|添加|登记|录入|确认|清单|方案|更新|已将|已为|已帮|补货记录/.test(text)
}

export function answerHouseholdQuickly(question: string, state: AppState, itemViews: HouseholdChatItemView[]): string | null {
  const text = question.trim().toLocaleLowerCase("zh-CN")
  // 添加/新建/记一笔意图需要走 agent 草稿流程，不能被本地快捷回答拦截
  if (/添加|新建|创建|录入|登记|帮我加|记一笔|记录一下|买了|下单|购入|入手/.test(text)) return null
  const urgent = itemViews.filter(({ computed }) => computed.displayStatus === "urgent").sort((a, b) => a.computed.dueAt - b.computed.dueAt)
  const warning = itemViews.filter(({ computed }) => computed.displayStatus === "warning").sort((a, b) => a.computed.dueAt - b.computed.dueAt)

  // 本月预算
  if (/预算|还剩|花了|支出|超支|本月预算|月预算/.test(text)) {
    const spend = calculateMonthlySpend(state.items)
    const budget = state.settings.monthlyBudget
    if (!budget || budget <= 0) {
      return [
        `本月已记录补货支出 ¥${formatPrice(spend)}，但还没有设置每月预算。`,
        "下一步：可以在设置里填写每月预算，我再帮你对比剩余额度。"
      ].join("\n")
    }
    const remaining = budget - spend
    const percent = Math.round((spend / budget) * 100)
    return [
      remaining >= 0
        ? `本月预算还剩 ¥${formatPrice(remaining)}。`
        : `本月预算已超出 ¥${formatPrice(Math.abs(remaining))}。`,
      `预算：¥${formatPrice(budget)}。`,
      `已记录支出：¥${formatPrice(spend)}。`,
      `使用率：${percent}%。`,
      percent >= 90 ? "下一步：本月尽量先别再补非急需品。" : "下一步：保持当前节奏即可。"
    ].join("\n")
  }

  // 这周 / 下周 要补什么：按日期分组
  if (/下周|未来一周|未来7天|未来七天|这周|本周|一周内/.test(text)) {
    const upcoming = itemViews
      .filter(({ computed }) => computed.daysUntilDue <= 7)
      .sort((a, b) => a.computed.dueAt - b.computed.dueAt)
    if (!upcoming.length) return "未来 7 天没有新的补货提醒，可以先不用处理。"
    const groups = new Map<string, string[]>()
    for (const { item, computed } of upcoming) {
      const key = formatDate(computed.dueAt)
      const list = groups.get(key) || []
      const timing = computed.daysUntilDue <= 0 ? "已到提醒点" : `${computed.daysUntilDue} 天后到提醒点`
      list.push(`${item.name}（${timing}，${computed.remainingText}）`)
      groups.set(key, list)
    }
    return [
      `未来 7 天有 ${upcoming.length} 项需要关注，按提醒日分组：`,
      ...[...groups.entries()].map(([date, names]) => `${date}：${names.join("、")}`)
    ].join("\n")
  }

  // 今天优先买什么：urgent > warning > dueAt，最多 5 项，附原因
  if (/今天|优先|现在|急|补什么|买什么|今天买|优先买/.test(text)) {
    if (!urgent.length && !warning.length) return "当前没有急需补货或快用完的记录，可以先不用处理。"
    const priority = [...urgent, ...warning].slice(0, 5)
    const lines = priority.map(({ item, computed }, index) => {
      const reason = computed.daysUntilDepletion <= 0
        ? "预计已用完"
        : computed.daysUntilDue <= 0
          ? `已到提醒点，${computed.remainingText}`
          : `${computed.daysUntilDue} 天后到提醒点，${computed.remainingText}`
      return `${index + 1}. ${item.name}：${reason}。`
    })
    return [
      urgent.length ? `今天优先看 ${urgent.length} 项急需补货。` : `今天没有急需补货，另有 ${warning.length} 项快用完。`,
      ...lines,
      "下一步：点对应物品补货，或在对话里直接说「在京东买了两袋猫粮」。"
    ].join("\n")
  }

  // 哪些信息缺失：按 价格 / 平台 / 常购商品 / 评价 分组
  if (/缺|没有|补全|信息|哪些信息|信息缺失/.test(text)) {
    const missingPrice = itemViews.filter(({ item }) => !item.history.some((event) => Number.isFinite(event.price) && event.price! > 0))
    const missingPlatform = itemViews.filter(({ item }) => {
      const latest = latestHistory(item)
      return !(latest?.platform || item.platform || item.purchaseOptions.some((option) => option.platform))
    })
    const missingOption = itemViews.filter(({ item }) => !item.purchaseOptions || item.purchaseOptions.length === 0)
    const missingReview = itemViews.filter(({ item }) => {
      const latest = latestHistory(item)
      return !(latest?.review || item.purchaseOptions.some((option) => option.review))
    })
    if (!missingPrice.length && !missingPlatform.length && !missingOption.length && !missingReview.length) {
      return "当前价格、平台、常购商品、评价记录看起来比较完整。"
    }
    return [
      "当前主要缺这些信息，补全后提醒和价格异常判断会更准。",
      `缺少价格：${missingPrice.map(({ item }) => item.name).slice(0, 10).join("、") || "无"}。`,
      `缺少平台：${missingPlatform.map(({ item }) => item.name).slice(0, 10).join("、") || "无"}。`,
      `缺少常购商品：${missingOption.map(({ item }) => item.name).slice(0, 10).join("、") || "无"}。`,
      `缺少评价：${missingReview.map(({ item }) => item.name).slice(0, 10).join("、") || "无"}。`
    ].join("\n")
  }

  // 哪些价格异常：本次单价 vs 历史均价，超过 10% 标记
  if (/价格异常|异常|均价|偏贵|贵了|涨价/.test(text)) {
    const anomalies: string[] = []
    for (const { item } of itemViews) {
      const priced = item.history.filter((event) => Number.isFinite(event.price) && event.price! > 0 && Number.isFinite(event.qty) && event.qty! > 0)
      if (priced.length < 2) continue
      const latest = priced[priced.length - 1]
      const latestUnit = latest.price! / latest.qty!
      const avgUnit = priced.reduce((total, event) => total + event.price! / event.qty!, 0) / priced.length
      if (avgUnit <= 0) continue
      const ratio = latestUnit / avgUnit
      if (ratio > 1.1) {
        const pct = Math.round((ratio - 1) * 100)
        anomalies.push(`${item.name}：本次单价 ¥${formatPrice(latestUnit)}，均价 ¥${formatPrice(avgUnit)}，贵 ${pct}%。`)
      } else if (ratio < 0.9) {
        const pct = Math.round((1 - ratio) * 100)
        anomalies.push(`${item.name}：本次单价 ¥${formatPrice(latestUnit)}，均价 ¥${formatPrice(avgUnit)}，便宜 ${pct}%。`)
      }
    }
    if (!anomalies.length) return "最近几次补货的单价和均价相比没有明显异常。"
    return ["以下物品本次单价相对历史均价偏离超过 10%。", ...anomalies].join("\n")
  }

  return null
}

export function buildHouseholdChatStarter(itemViews: HouseholdChatItemView[]): string {
  if (!itemViews.length) return "先添加一些消耗品后，我就能帮你查库存、价格和补货建议。"
  const urgent = itemViews.filter(({ computed }) => computed.displayStatus === "urgent").length
  const warning = itemViews.filter(({ computed }) => computed.displayStatus === "warning").length
  if (urgent > 0) return `现在有 ${urgent} 项急需补充。你可以问我“今天优先买什么？”`
  if (warning > 0) return `有 ${warning} 项快用完。你可以问我“这周可能要补什么？”`
  return "当前看起来比较稳。你可以问我“哪些东西可以暂时不用管？”"
}

export async function askHouseholdAssistant({
  apiKey,
  model,
  state,
  itemViews,
  messages,
  pendingActions,
  pendingDraft,
  repairMissingActionBlock
}: {
  apiKey: string
  model?: string
  state: AppState
  itemViews: HouseholdChatItemView[]
  messages: HouseholdChatMessage[]
  /** 当前处于待确认状态的创建清单；用户若要求修改，模型需输出修订后的完整动作块 */
  pendingActions?: ChatProposedAction[]
  /** 当前处于待确认状态的 agent 草稿；用户若要求修改，模型需输出修订后的完整 JSON draft */
  pendingDraft?: AgentDraft
  /** 上一轮疑似忘记动作块时，仅重试一次并把协议纠正放进系统提示 */
  repairMissingActionBlock?: boolean
}): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const latestQuestion = [...messages].reverse().find((message) => message.role === "user")?.content || ""
  const systemPrompt = [
    "你是一个安静、可靠的家庭消耗品补货助手。",
    "回答使用简体中文，语气克制、明确、低压力。",
    "优先回答库存、价格、补货时间、购买平台、上次购买评价、缺失记录。",
    "不要编造没有记录的价格、平台或评价。",
    "给出下一步行动时要具体，但不要制造焦虑。",
    "不要使用 Markdown。不要输出 **、#、-、*、```、表格或 emoji。",
    "回答要适合在小面板里阅读：先用一句话给结论，再按需使用短标题行，例如：需要补充：、可以暂缓：、信息缺失：、下一步：。",
    "每行只表达一个信息点。提到物品时使用「物品名：原因」格式，不要用项目符号。",
    "",
    "你还是一个可确认执行的录入 agent。凡是用户要创建、记录补货、添加常购商品、修改待确认草稿时，只输出 JSON，不输出正文解释。",
    "JSON 二选一：",
    '{"kind":"queryAnswer","answer":"只读查询回答"}',
    '{"kind":"draft","message":"一句短提示","draft":{"kind":"createItem","itemName":"消耗品名","category":"分类名","cycleDays":30,"bufferDays":2,"unit":"件"}}',
    "draft.kind 只能是 createItem、restock、createItemWithRestock、addPurchaseOption。",
    "createItem 字段：itemName、category、cycleDays、bufferDays、unit。",
    "restock 字段：itemName、itemId 可选、qty 可选、unit 可选、price 可选、platform 可选、purchaseProductName 可选、cycleDaysPatch 可选、restockDate 可选。",
    "createItemWithRestock 字段：item 是 createItem；restock 是补货记录字段；addPurchaseOption 可选，包含 productName、unit。",
    "addPurchaseOption 字段：itemName、itemId 可选、productName、unit 可选。",
    "补货单等于补货记录，不是普通建档。用户说买了、下单、花了多少钱、在哪个平台买，都应该生成 restock 或 createItemWithRestock 草稿。",
    "价格、平台、数量必须放进 restock 草稿，不要放进普通 createItem。",
    "模型永远不能声称已创建、已记录、已更新；真实写入只由本地确认卡片执行。",
    "不要输出 Markdown、表格、字段列表、<action> 标签或代码块。只输出一个 JSON 对象。",
    "缺少可推断字段时直接给建议值；只有完全不知道物品名时才用 queryAnswer 问一个问题。",
    ...(repairMissingActionBlock ? [
      "协议纠正：上一轮回复疑似承诺执行，但没有给出可解析 JSON draft。请立即输出完整 JSON draft。"
    ] : []),
    ...(pendingDraft ? [
      "",
      `当前待确认草稿（尚未写入）：${describeAgentDraft(pendingDraft)}`,
      JSON.stringify(pendingDraft),
      "如果用户修改草稿，输出修订后的完整 JSON draft。不要说已更新。",
      "如果用户询问是否已创建或已记录，用 queryAnswer 回答还没有真正写入，需要确认草稿。"
    ] : []),
    ...(pendingActions?.length ? [
      "",
      "当前待确认清单（用户尚未确认）：",
      ...pendingActions.map(describeActionLine),
      "如果用户要求修改清单内容，输出修订后的完整动作块（包含全部项，不只是改动的项），正文仍然最多一句话。",
      "如果用户用文字表达确认创建，不要回答已创建或已完成；界面会执行确认写入。",
      "如果用户表示不要了或取消，不输出动作块，正文用一句话确认已放弃。"
    ] : []),
    buildHouseholdContext(state, itemViews, latestQuestion)
  ].join("\n")

  const requestMessages = [
    { role: "system" as const, content: systemPrompt },
    ...messages.slice(-8).map((message) => ({ role: message.role, content: message.content }))
  ]

  if (window.desktop?.chatComplete) {
    return window.desktop.chatComplete({
      apiKey,
      model: model?.trim() || DEFAULT_CHAT_MODEL,
      messages: requestMessages
    })
  }

  if (window.desktop) {
    return { ok: false, error: "当前窗口还没有加载家庭问答服务，请关闭并重新启动 403家庭管家后再试。" }
  }

  return { ok: false, error: "当前是浏览器预览，无法连接本机对话服务。请在 403家庭管家桌面应用中使用。" }
}
