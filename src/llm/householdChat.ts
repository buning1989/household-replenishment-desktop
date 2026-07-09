import { calculateConsumption, DEFAULT_CYCLES, estimateRemainingQty, formatDate, formatPrice, startOfDay } from "../domain"
import { calculateMonthlySpend } from "../pure-logic.mjs"
import type { AppState, ItemComputed, ReplenishmentItem } from "../types"
import { describeAgentDraft, type AgentClarification, type AgentDraft, type AgentDraftStatus, type OrderRow } from "../agent/drafts"
import type { AgentPlan } from "../agent/actions"
import type { OrderImportRow } from "../OrderImportReview"
import { buildManagerObservations, filterUnseenObservations, markObservationsSeen, observationKey, pickObservationByPreference, serializeHouseholdProfile, type ManagerObservation } from "../agent/observations"
import type { AgentContextPack, ConversationFocus } from "../agent/conversationContext"

const DEFAULT_CHAT_MODEL = "qwen-plus"

/**
 * 对话统一日期上下文。所有「今天/昨天/这周/未来 7 天」的判断都以此为准，
 * 不在 householdChat 内部随意 Date.now()，避免测试和运行不一致。
 */
export type ChatDateContext = {
  now: number
  todayStart: number
  /** 形如 2026-07-04 */
  todayLabel: string
  /** 形如 2026-07-04 09:30 */
  timestampLabel: string
  /** 形如 Asia/Shanghai 或 UTC+8 */
  timezone: string
}

/** 用当前时间构造一个 ChatDateContext，用于线上运行。 */
export function buildChatDateContext(now: number = Date.now()): ChatDateContext {
  const todayStart = startOfDay(now)
  const date = new Date(now)
  const pad = (n: number) => String(n).padStart(2, "0")
  const todayLabel = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const timestampLabel = `${todayLabel} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  const timezone = (() => {
    try {
      const offset = -date.getTimezoneOffset() / 60
      const sign = offset >= 0 ? "+" : "-"
      return `UTC${sign}${Math.abs(offset)}`
    } catch {
      return "local"
    }
  })()
  return { now, todayStart, todayLabel, timestampLabel, timezone }
}

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
  /** 消息创建时间戳（ms）。旧消息可能缺失，渲染层用当前时间兜底。仅用于展示，不参与业务判断。 */
  createdAt?: number
  /** 该条管家消息附带的创建提案；undefined 表示纯文本消息 */
  actions?: ChatProposedAction[]
  /** pending：等待确认；confirmed / cancelled：已处理；superseded：被修订后的新清单替代 */
  actionStatus?: "pending" | "confirmed" | "cancelled" | "superseded"
  /** 创建结果消息里的跳转入口 */
  links?: ChatMessageLink[]
  /** 新版可确认 agent 草稿；只有本地确认后才写入。 */
  agentDraft?: AgentDraft
  draftStatus?: AgentDraftStatus
  /** AgentPlan 多动作计划；与 agentDraft 并存，覆盖建分类/设预算/改周期等 plan-only 能力。
   *  确认前不写入 state，确认后由 commitAgentPlan 统一执行。 */
  agentPlan?: AgentPlan
  /** AgentPlan 状态。第三期新增 awaitingSecondConfirm：高风险 plan 第一次确认后等待二次「确认删除」。 */
  planStatus?: "pending" | "awaitingSecondConfirm" | "confirmed" | "cancelled" | "superseded"
  /** 模型或本地生成的澄清追问；用户点选项或自由输入后继续走流程，不写入 state。 */
  clarification?: AgentClarification
  /** 订单截图导入后的批量待确认草稿；每条独立标记 pending/confirmed/cancelled。批量确认前不写入 state。 */
  agentDraftBatch?: AgentDraft[]
  batchDraftStatuses?: AgentDraftStatus[]
  /** 批量草稿确认后的写入结果摘要与跳转入口 */
  batchResult?: { summary: string; links: ChatMessageLink[] }
  /** 用户消息里附带的订单截图缩略图（png/jpg/jpeg/webp）。仅在用户上传图片时存在。 */
  imageAttachments?: { name: string; dataUrl: string }[]
  /** 订单截图识别后被判断为非消耗品而跳过的行（手机壳、数据线等）。仅在 proposalBatch 场景下存在。 */
  skippedOrderRows?: OrderRow[]
  /** 订单截图识别后待用户确认归入哪个物品的歧义行。仅在 proposalBatch 场景下存在。 */
  uncertainOrderRows?: OrderRow[]
  /**
   * 订单截图识别后的可编辑行（与 OrderImportModal 同一结构）。
   * 对话模式复用 OrderImportReviewList 渲染；用户确认后调 buildAgentDraftsFromOrderRows + commitAgentDraftBatch。
   */
  orderImportRows?: OrderImportRow[]
  /** 订单截图导入是否已处理（pending / confirmed / cancelled） */
  orderImportStatus?: "pending" | "confirmed" | "cancelled"
  /** 订单截图导入确认后的写入结果摘要与跳转入口 */
  orderImportResult?: { summary: string; links: ChatMessageLink[] }
  /**
   * 临时 loading 消息标记：响应节奏层（respondWithPacing）在等待最终结果时插入。
   * 最终结果返回后会被替换掉，不进入长期历史，也不进入 LLM 上下文（compactRecentMessages 会跳过）。
   */
  isTransient?: boolean
}

/**
 * 任务二：构造系统提示中「你熟悉这个家庭已经管理的 XX 等消耗品」这一行的动态内容。
 * 从 state.items 取最多 5 个真实物品名拼接；物品为空时返回独立兜底句。
 * 抽成纯函数便于单测；不调用任何副作用。
 */
export function buildManagedItemsLine(items: ReplenishmentItem[]): string {
  const names = (items || [])
    .map((item) => item?.name?.trim())
    .filter((name): name is string => Boolean(name))
    .slice(0, 5)
  if (!names.length) return "这个家庭刚开始建立消耗品档案。"
  return `你熟悉这个家庭已经管理的${names.join("、")}等消耗品。`
}

/** 管家系统提示：身份 + 行为规则 + 输出协议 + 文案约束。 */
function buildHouseholdManagerSystemPrompt(opts: {
  pendingDraft?: AgentDraft
  pendingActions?: ChatProposedAction[]
  repairMissingActionBlock?: boolean
  dateContext: ChatDateContext
}): string {
  const { pendingDraft, pendingActions, repairMissingActionBlock, dateContext } = opts
  return [
    "你是「403 家庭管家」里长期负责这个家庭日常消耗品的管家，不是通用 AI 助手，也不是表格录入机器人。",
    "",
    "用户说一句很随意的话时，你要先查已有记录、历史补货习惯、常购商品、家庭画像和常识，再替用户整理出一个合理处理方案。",
    "你的目标不是让用户补字段，而是尽量替用户做判断：能根据上下文和生活常识判断的，就先给出一个可执行方案；只有在可能记错物品、重复创建、或用户表达明显冲突时，才追问。",
    "",
    "你和用户说话要口语、熟悉、克制。不要暴露内部推理过程，不要像系统表单。",
    "不要使用 Markdown，不要输出 **、#、-、*、```、表格或 emoji。",
    "每行只表达一个信息点。提到物品时用「物品名：原因」格式，不要用项目符号。",
    "",
    "【管家身份行为规则】",
    "1. 你已经在帮这个家庭管理消耗品，回答时不要像第一次认识用户。",
    "2. 用户表达不完整时，先查上下文，不要立刻追问。",
    "3. 历史记录里能找到习惯，就沿用历史习惯。",
    "4. 历史记录没有，但模板或常识足够明确，就用合理默认值。",
    "5. 价格、平台、商品规格不是必要字段，用户没说就先空着，不要追问。",
    "6. 日期没说时，补货类记录默认今天。",
    "7. 已有物品时，不要重复创建。",
    "8. 只有当写入对象不确定时才追问。",
    "9. 给用户的结论要像已经替他处理好了，只等他点头。",
    "10. 不要解释「我是怎么推理出来的」，只输出处理方案。",
    "",
    "【信息采集原则】",
    "你不是简单追问字段的表单助手。缺少价格、平台、商品名时，先查看历史采购记录和常购商品；如果有参考值，要主动给出判断。",
    "- 缺金额：先查该物品历史有价记录，计算单价后给出本次估价（如「之前猫砂大约 30 元一袋，这次 5 袋我先按 150 估」）。",
    "- 缺金额且无历史：基于物品品类给常见价格范围（如「猫砂之前还没记过价格，我先按常见范围 20-40 元一袋估，5 袋大概 100-200」），不要伪装成历史事实。",
    "- 缺平台但历史有平台习惯：提一句「之前一般是在 X 买」做参考，不强制追问。",
    "- 不同平台差异做自然判断：拼多多可能低一点、山姆/线下规格可能不一样、京东天猫淘宝和大部分历史接近时不特别提示。不要硬编码折扣系数。",
    "你的目标是让用户感到你在认真帮他理账，而不是让他自己填表。",
    "禁止出现「大概多少钱」「多少钱买的」「在哪家买的」「金额最好也记一下」「这笔才算完整」这类表单式追问。",
    "允许且鼓励：「我先按……估」「实际金额你直接改」「实际金额有差你直接说个数」「这笔补准后，后面比价才有参考」。",
    "禁止出现「不记得也可以」「没关系」「先空着也不影响」这类迁就式语言——它们让用户觉得你不愿帮他理账。",
    "",
    "【具体决策规则】",
    "- 已有 item 精确命中（例如用户说「加一袋猫砂」时库里已有「猫砂」）：视为记录补货，qty=1，unit 用用户表达>历史>item.unit，restockDate=today，price/platform 没说就空着。回复口吻：「猫砂我就按一袋记，今天补上。价格和平台这次先空着，不影响记录。你要是没问题，我就先这么记下。」",
    "- 没有 item，但命中高置信模板或常识（例如库里没有「猫砂」）：视为创建管理项 + 起始补货记录。category 取宠物用品，cycleDays 取 14，bufferDays 取 3，unit 取袋，restock.qty=1，restockDate=today。回复口吻：「我先把猫砂加进来，这袋就当作现在的起始库存。先按 14 天消耗一袋处理，提前 3 天提醒你及时补货。你要是没问题，我就先这么记下。」",
    "- 已有 item，但用户说「帮我加一个猫砂」：不要重复创建，输出 clarification：question=「猫砂已经在管了。你这次是要记一袋补货，还是想改一下猫砂的提醒节奏？」，options=[「记一袋补货」「改提醒节奏」「打开猫砂」]。",
    "- 多个相近物品（已有猫砂/猫粮/猫罐头，用户说「猫的那个加一袋」）：不要猜，输出 clarification：question=「你说的是猫砂、猫粮，还是猫罐头？我怕记错，先跟你确认一下。」，options=[「猫砂」「猫粮」「猫罐头」]。",
    "",
    "【非消耗品问题回答边界】",
    "你不是通用百科助手，但也不是只会填表的机器人。遇到非消耗品问题时按以下边界处理：",
    "- 身份/元对话（你是谁、你能做什么、你刚才为什么这么答）：直接用 queryAnswer 自然回答，不让用户换问法。",
    "- 实时外部信息（天气、新闻、股票、汇率、限行、快递到哪）：不要编造。用 queryAnswer 说明你看不了实时信息，并把话题自然带回能帮用户处理的家务、补货或提醒。",
    "- 家庭生活相邻问题（洗衣、做饭、收纳、清洁、宠物、囤货、买什么、怎么选）：可以用 queryAnswer 给简短自然回答，结合家里场景给建议，不要强行生成草稿。若建议涉及具体物品，可以提示「我也可以顺手帮你记成常购商品」。",
    "- 纯闲聊/寒暄：自然接住，引导用户回到要处理的家务。",
    "- 完全不属于家务范围且无法关联：用 queryAnswer 简短说明边界，并提示可以转成采购、提醒或记录。",
    "非消耗品问题一律输出 queryAnswer，不要输出 draft 或 clarification。",
    "",
    "【输出协议】",
    "凡是要创建、记录补货、添加常购商品、修改待确认草稿、或需要用户选一个时，只输出一个 JSON 对象，不输出正文解释。",
    "JSON 三选一：",
    '{"kind":"queryAnswer","answer":"只读查询回答"}',
    '{"kind":"draft","message":"一句口语化管家回复","draft":{...}}',
    '{"kind":"clarification","clarification":{"question":"口语化追问","options":["选项A","选项B"]}}',
    "draft.kind 只能是 createItem / restock / createItemWithRestock / addPurchaseOption。",
    "createItem 字段：itemName、category、cycleDays、bufferDays、unit。",
    "restock 字段：itemName、itemId 可选、qty 可选、unit 可选、price 可选、platform 可选、purchaseProductName 可选、cycleDaysPatch 可选、restockDate 可选、review 可选、purchaseMeasureAmount 可选、purchaseMeasureUnit 可选。",
    "createItemWithRestock 字段：item 是 createItem；restock 是补货记录字段；addPurchaseOption 可选，包含 productName、unit。",
    "addPurchaseOption 字段：itemName、itemId 可选、productName、unit 可选。",
    "clarification 字段：question、options（字符串数组，最多 6 项）、provisional（可选草稿）。",
    "",
    "【文案硬约束】",
    "message 中禁止出现：我理解为、我猜、我估算、根据模板、根据常识、待确认草稿、确认创建、确认记录、分类：、单位：、bufferDays、cycleDays。",
    "message 中允许且鼓励：「我先按……处理」「我先这么给你记」「这次先按……放进去」「后面你再补几次，我会自己把节奏调准」「价格和平台这次先空着，不影响记录」「你要是没问题，我就先这么记下」「不对的话你直接说一句，我再改」。",
    "模型永远不能声称已创建、已记录、已更新；真实写入只由本地确认卡片执行。",
    "不要输出 <action> 标签、表格、字段列表或代码块。只输出一个 JSON 对象。",
    "缺少可推断字段时直接给建议值；只有完全不知道物品名或写入对象有歧义时，才用 clarification 问一个问题。",
    ...(repairMissingActionBlock ? [
      "",
      "协议纠正：上一轮回复疑似承诺执行，但没有给出可解析 JSON。请立即输出完整 JSON（draft 或 clarification 或 queryAnswer 之一）。"
    ] : []),
    ...(pendingDraft ? [
      "",
      `当前待确认草稿（尚未写入）：${describeAgentDraft(pendingDraft)}`,
      JSON.stringify(pendingDraft),
      "如果用户修改草稿，输出修订后的完整 JSON draft，message 仍保持口语化。不要说已更新。",
      "如果用户询问是否已创建或已记录，用 queryAnswer 回答还没有真正写入，需要确认草稿。"
    ] : []),
    ...(pendingActions?.length ? [
      "",
      "当前待确认清单（用户尚未确认）：",
      ...pendingActions.map(describeActionLine),
      "如果用户要求修改清单内容，输出修订后的完整 JSON draft，message 仍保持口语化。",
      "如果用户用文字表达确认，不要回答已创建或已完成；界面会执行确认写入。",
      "如果用户表示不要了或取消，输出 queryAnswer 用一句话确认已放弃。"
    ] : [])
  ].join("\n")
}

/** 把待确认清单序列化进下一轮上下文，让模型知道自己在修订什么 */
export function describeActionLine(action: ChatProposedAction): string {
  if (action.type === "createCategory") return `- 分类：${action.name}`
  if (action.type === "createItem") return `- 消耗品：${action.name}，分类 ${action.category}，周期 ${action.cycleDays} 天，单位 ${action.unit}`
  return `- 常购商品：${action.productName}，挂到消耗品「${action.itemName}」`
}

export type HouseholdChatItemView = {
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

function buildHouseholdContext(
  state: AppState,
  itemViews: HouseholdChatItemView[],
  question: string,
  dateContext?: ChatDateContext,
  seenObservationKeys?: Set<string>
): string {
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

  const lines = [
    "当前家庭消耗品数据如下。请只基于这些数据回答；不确定时直接说明还缺什么记录。",
    `总数：${itemViews.length} 项。急需补充：${urgent.length} 项。快用完：${warning.length} 项。充足：${safe.length} 项。`,
    `缺少价格记录：${missingPrice.map(({ item }) => item.name).slice(0, 12).join("、") || "无"}。`,
    `缺少平台/商家：${missingPlatform.map(({ item }) => item.name).slice(0, 12).join("、") || "无"}。`,
    `分类：${state.categories.join("、") || "无"}。`,
    buildBudgetLine(state)
  ]

  // 修复既有缺陷：系统提示要求模型参考「家庭画像」，但上下文从未提供。
  // 把 householdProfile 序列化进来；画像为空则该段落省略。
  const profileSegment = serializeHouseholdProfile(state.householdProfile)
  if (profileSegment) {
    lines.push(profileSegment)
  }

  lines.push(`物品明细（按当前问题筛选 ${contextItems.length} 项）：`)
  lines.push(orderedItems || "暂无物品。")

  // 接入点 1：末尾追加【管家最近注意到】（至多 5 条），让模型同步看到管家视角的注意点
  // 任务四 A：会话级去重——已注入 LLM 上下文的观察不再重复注入。
  if (dateContext) {
    const allObservations = buildManagerObservations(state, itemViews, dateContext)
    const unseen = filterUnseenObservations(allObservations, seenObservationKeys)
    if (unseen.length) {
      const top = unseen.slice(0, 5)
      const obsText = top.map((obs) => `- ${obs.text}`).join("\n")
      lines.push(`【管家最近注意到】\n${obsText}`)
      if (seenObservationKeys) markObservationsSeen(top, seenObservationKeys)
    }
  }

  return lines.join("\n")
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

// ---------- 查询事实供料（任务四 A） ----------

/** 查询事实类型，对应原快捷回答里的几类本地计算。 */
export type QueryFactType = "identity" | "budget" | "thisWeek" | "nextWeek" | "today" | "missingInfo" | "priceAnomaly"

/** 检测用户提问对应的查询事实类型。返回 null 表示不是可识别的查询意图（写草稿/确认等）。 */
export function detectQueryFactType(text: string): QueryFactType | null {
  const lower = text.trim().toLocaleLowerCase("zh-CN")
  if (!lower) return null
  // 写入意图不归为查询
  if (/添加|新建|创建|录入|登记|帮我加|记一笔|记录一下|买了|下单|购入|入手/.test(lower)) return null
  if (/你是谁|你是干嘛|你能做什么|你是啥|你是什么|介绍下自己|介绍一下你自己/.test(lower)) return "identity"
  if (/预算|还剩|花了|支出|超支|本月预算|月预算/.test(lower)) return "budget"
  // 严格区分「下周」与「这周」：原来合并为一个分支导致返回相同内容（任务四 A 修复点）
  if (/下周|未来一周|未来7天|未来七天/.test(lower)) return "nextWeek"
  if (/这周|本周|一周内/.test(lower)) return "thisWeek"
  // today：要求时间标志词后接补货动作词，避免「今天天气怎么样」误命中
  if (/(今天|现在).*(补|买|要|急|缺)|优先(补|买)|补什么|买什么/.test(lower)) return "today"
  if (/缺|没有|补全|信息|哪些信息|信息缺失/.test(lower)) return "missingInfo"
  if (/价格异常|异常|均价|偏贵|贵了|涨价/.test(lower)) return "priceAnomaly"
  return null
}

/**
 * 按时间窗口切分物品视图：
 *   overdue   已到提醒点（daysUntilDue <= 0）
 *   thisWeek  本周（0 < daysUntilDue <= 7）
 *   nextWeek  下周（7 < daysUntilDue <= 14）
 * 三者互斥，按 dueAt 升序。
 */
export function partitionByWindow(itemViews: HouseholdChatItemView[]): {
  overdue: HouseholdChatItemView[]
  thisWeek: HouseholdChatItemView[]
  nextWeek: HouseholdChatItemView[]
} {
  const sortByDueAt = (list: HouseholdChatItemView[]) => [...list].sort((a, b) => a.computed.dueAt - b.computed.dueAt)
  return {
    overdue: sortByDueAt(itemViews.filter(({ computed }) => computed.daysUntilDue <= 0)),
    thisWeek: sortByDueAt(itemViews.filter(({ computed }) => computed.daysUntilDue > 0 && computed.daysUntilDue <= 7)),
    nextWeek: sortByDueAt(itemViews.filter(({ computed }) => computed.daysUntilDue > 7 && computed.daysUntilDue <= 14))
  }
}

function formatBudgetFactLine(state: AppState, dateContext: ChatDateContext): string {
  const spend = calculateMonthlySpend(state.items, dateContext.now)
  const budget = state.settings.monthlyBudget
  if (!budget || budget <= 0) {
    return `本月预算：未设置；本月已支出 ¥${formatPrice(spend)}`
  }
  const remaining = budget - spend
  const percent = Math.round((spend / budget) * 100)
  const remainingText = remaining >= 0 ? `剩余 ¥${formatPrice(remaining)}` : `已超出 ¥${formatPrice(Math.abs(remaining))}`
  return `本月预算：¥${formatPrice(budget)}；本月已支出 ¥${formatPrice(spend)}（使用率 ${percent}%）；${remainingText}`
}

/**
 * 任务四 A：把原快捷回答里的本地计算结果序列化为【本地计算的事实】文本，注入 LLM 上下文。
 * 系统提示约束：数字必须取自该事实段，不得自行推算或编造。
 *
 * 返回 null 表示该问题不是可识别的查询意图（writeDraft / confirm / 无法识别）。
 */
export function buildQueryFacts(
  text: string,
  state: AppState,
  itemViews: HouseholdChatItemView[],
  dateContext: ChatDateContext
): string | null {
  const type = detectQueryFactType(text)
  if (!type) return null

  const lines: string[] = ["【本地计算的事实】（数字必须取自此段，不得自行推算或编造）"]
  lines.push(`提问类型：${type}`)

  if (type === "identity") {
    const urgent = itemViews.filter(({ computed }) => computed.displayStatus === "urgent").length
    const warning = itemViews.filter(({ computed }) => computed.displayStatus === "warning").length
    lines.push(`管理物品数：${itemViews.length} 项`)
    lines.push(`急需补货：${urgent} 项`)
    lines.push(`快用完：${warning} 项`)
    lines.push(formatBudgetFactLine(state, dateContext))
    return lines.join("\n")
  }

  if (type === "budget") {
    lines.push(formatBudgetFactLine(state, dateContext))
    return lines.join("\n")
  }

  if (type === "thisWeek" || type === "nextWeek") {
    const { overdue, thisWeek, nextWeek } = partitionByWindow(itemViews)
    if (type === "thisWeek") {
      lines.push("提问窗口：今天起 7 天内（含已到提醒点）")
      if (overdue.length) {
        lines.push(`已到提醒点：${overdue.map(({ item, computed }) => `${item.name}（${computed.remainingText}）`).join("、")}`)
      } else {
        lines.push("已到提醒点：无")
      }
      if (thisWeek.length) {
        const grouped = new Map<string, string[]>()
        for (const { item, computed } of thisWeek) {
          const key = formatDate(computed.dueAt)
          const list = grouped.get(key) || []
          list.push(`${item.name}（${computed.daysUntilDue} 天后到提醒点）`)
          grouped.set(key, list)
        }
        lines.push(`未来 7 天到提醒点：${[...grouped.entries()].map(([d, names]) => `${d}：${names.join("、")}`).join("；")}`)
      } else {
        lines.push("未来 7 天到提醒点：无")
      }
    } else {
      lines.push("提问窗口：8-14 天内")
      if (nextWeek.length) {
        const grouped = new Map<string, string[]>()
        for (const { item, computed } of nextWeek) {
          const key = formatDate(computed.dueAt)
          const list = grouped.get(key) || []
          list.push(`${item.name}（${computed.daysUntilDue} 天后到提醒点）`)
          grouped.set(key, list)
        }
        lines.push(`8-14 天到提醒点：${[...grouped.entries()].map(([d, names]) => `${d}：${names.join("、")}`).join("；")}`)
      } else {
        lines.push("8-14 天到提醒点：无")
      }
    }
    lines.push(formatBudgetFactLine(state, dateContext))
    return lines.join("\n")
  }

  if (type === "today") {
    const urgent = itemViews.filter(({ computed }) => computed.displayStatus === "urgent").sort((a, b) => a.computed.dueAt - b.computed.dueAt)
    const warning = itemViews.filter(({ computed }) => computed.displayStatus === "warning").sort((a, b) => a.computed.dueAt - b.computed.dueAt)
    lines.push("提问窗口：今日优先")
    if (urgent.length) {
      lines.push(`今日急需（urgent）：${urgent.map(({ item, computed }) => `${item.name}（${computed.remainingText}）`).join("、")}`)
    } else {
      lines.push("今日急需（urgent）：无")
    }
    if (warning.length) {
      lines.push(`今日快用完（warning）：${warning.map(({ item, computed }) => `${item.name}（${computed.remainingText}）`).join("、")}`)
    } else {
      lines.push("今日快用完（warning）：无")
    }
    lines.push(formatBudgetFactLine(state, dateContext))
    return lines.join("\n")
  }

  if (type === "missingInfo") {
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
    lines.push(`缺少价格记录：${missingPrice.map(({ item }) => item.name).slice(0, 12).join("、") || "无"}`)
    lines.push(`缺少平台/商家：${missingPlatform.map(({ item }) => item.name).slice(0, 12).join("、") || "无"}`)
    lines.push(`缺少常购商品：${missingOption.map(({ item }) => item.name).slice(0, 12).join("、") || "无"}`)
    lines.push(`缺少评价：${missingReview.map(({ item }) => item.name).slice(0, 12).join("、") || "无"}`)
    return lines.join("\n")
  }

  // priceAnomaly
  const anomalies: string[] = []
  for (const { item } of itemViews) {
    const priced = item.history.filter((event) => Number.isFinite(event.price) && event.price! > 0 && Number.isFinite(event.qty) && event.qty! > 0)
    if (priced.length < 2) continue
    const latest = priced[priced.length - 1]
    const prior = priced.slice(0, -1)
    const latestUnit = latest.price! / latest.qty!
    const avgUnit = prior.reduce((total, event) => total + event.price! / event.qty!, 0) / prior.length
    if (avgUnit <= 0) continue
    const ratio = latestUnit / avgUnit
    if (ratio > 1.1) {
      const pct = Math.round((ratio - 1) * 100)
      anomalies.push(`${item.name}（本次单价 ¥${formatPrice(latestUnit)}，均价 ¥${formatPrice(avgUnit)}，贵了 ${pct}%）`)
    } else if (ratio < 0.9) {
      const pct = Math.round((1 - ratio) * 100)
      anomalies.push(`${item.name}（本次单价 ¥${formatPrice(latestUnit)}，均价 ¥${formatPrice(avgUnit)}，便宜了 ${pct}%）`)
    }
  }
  lines.push(`价格异常物品：${anomalies.join("；") || "无"}`)
  lines.push(formatBudgetFactLine(state, dateContext))
  return lines.join("\n")
}

// ---------- 快捷兜底回答（任务四 A 降级为 LLM 失败兜底） ----------

export function answerHouseholdQuickly(
  question: string,
  state: AppState,
  itemViews: HouseholdChatItemView[],
  dateContext: ChatDateContext = buildChatDateContext(),
  seenObservationKeys?: Set<string>
): string | null {
  const text = question.trim().toLocaleLowerCase("zh-CN")
  // 添加/新建/记一笔意图需要走 agent 草稿流程，不能被本地快捷回答拦截
  if (/添加|新建|创建|录入|登记|帮我加|记一笔|记录一下|买了|下单|购入|入手/.test(text)) return null

  // 接入点 2：观察引擎懒加载 + 跨维度提示。
  // 每类模板回答末尾追加至多 1 条与当前问题不同维度的观察；同维度不追加，避免重复。
  // 任务四 A：会话级去重——已展示过的观察不再追加。
  let _observations: ManagerObservation[] | null = null
  const getObservations = (): ManagerObservation[] => {
    if (_observations === null) _observations = buildManagerObservations(state, itemViews, dateContext)
    return _observations
  }
  const withObs = (answer: string, preferences: ManagerObservation["kind"][]): string => {
    const all = getObservations()
    const candidates = seenObservationKeys && seenObservationKeys.size > 0
      ? filterUnseenObservations(all, seenObservationKeys)
      : all
    const obs = pickObservationByPreference(candidates, preferences)
    if (obs) {
      seenObservationKeys?.add(observationKey(obs))
      return `${answer}\n${obs.text}`
    }
    return answer
  }

  // 身份问题：你是谁 / 你能做什么 —— 用管家口吻短句回答，不展开能力清单（不追加观察）
  if (/你是谁|你是干嘛|你能做什么|你是啥|你是什么|介绍下自己|介绍一下你自己/.test(text)) {
    return "我是 403 家庭管家，平时就帮你盯着家里的消耗品。你随口说买了什么、快没什么，我先按家里的习惯替你记好，拿不准的时候才问你。"
  }

  const urgent = itemViews.filter(({ computed }) => computed.displayStatus === "urgent").sort((a, b) => a.computed.dueAt - b.computed.dueAt)
  const warning = itemViews.filter(({ computed }) => computed.displayStatus === "warning").sort((a, b) => a.computed.dueAt - b.computed.dueAt)

  // 本月预算：追加 dueSoon / negativeReviewRepurchase / priceAnomaly / cycleDrift（排除 budgetThreshold，同维度）
  if (/预算|还剩|花了|支出|超支|本月预算|月预算/.test(text)) {
    const spend = calculateMonthlySpend(state.items)
    const budget = state.settings.monthlyBudget
    const budgetPrefs: ManagerObservation["kind"][] = ["dueSoon", "negativeReviewRepurchase", "priceAnomaly", "cycleDrift"]
    if (!budget || budget <= 0) {
      return withObs(`本月已经记了 ¥${formatPrice(spend)} 的补货支出，还没设月预算。要不你在设置里填一个？我下次好帮你盯着别超。`, budgetPrefs)
    }
    const remaining = budget - spend
    const percent = Math.round((spend / budget) * 100)
    if (remaining >= 0) {
      const tail = percent >= 90 ? "这月尽量先别再补非急需品了。" : "保持当前节奏就行。"
      return withObs(`本月预算还剩 ¥${formatPrice(remaining)}（已用 ${percent}%）。${tail}`, budgetPrefs)
    }
    return withObs(`本月预算已经超了 ¥${formatPrice(Math.abs(remaining))}（使用率 ${percent}%）。接下来非急需的可以先放放。`, budgetPrefs)
  }

  // 任务四 A：严格区分「下周」与「这周」，不再合并为一个分支。
  // 下周：8-14 天到提醒点；这周：已到提醒点 + 0-7 天内到提醒点。
  if (/下周|未来一周|未来7天|未来七天/.test(text)) {
    const { nextWeek } = partitionByWindow(itemViews)
    const weekPrefs: ManagerObservation["kind"][] = ["budgetThreshold", "negativeReviewRepurchase", "priceAnomaly", "cycleDrift"]
    if (!nextWeek.length) {
      return withObs("下周（8-14 天内）没有新的补货提醒，可以先不用处理。", weekPrefs)
    }
    const grouped = new Map<string, string[]>()
    for (const { item, computed } of nextWeek) {
      const key = formatDate(computed.dueAt)
      const list = grouped.get(key) || []
      list.push(`${item.name}（${computed.daysUntilDue} 天后到提醒点）`)
      grouped.set(key, list)
    }
    const groupLines = [...grouped.entries()].map(([date, names]) => `${date}：${names.join("、")}`)
    return withObs(`下周（8-14 天内）要留意：${groupLines.join("；")}。`, weekPrefs)
  }

  if (/这周|本周|一周内/.test(text)) {
    const { overdue, thisWeek } = partitionByWindow(itemViews)
    const weekPrefs: ManagerObservation["kind"][] = ["budgetThreshold", "negativeReviewRepurchase", "priceAnomaly", "cycleDrift"]

    if (!overdue.length && !thisWeek.length) {
      return withObs("这周没有新的补货提醒，可以先不用处理。", weekPrefs)
    }

    const lines: string[] = []
    if (overdue.length) {
      lines.push(overdue.length === 1
        ? `先处理已经到点的：${overdue[0].item.name}，${overdue[0].computed.remainingText}。`
        : `先处理已经到点的 ${overdue.length} 项：${overdue.map(({ item, computed }) => `${item.name}（${computed.remainingText}）`).join("、")}。`
      )
    }
    if (thisWeek.length) {
      const grouped = new Map<string, string[]>()
      for (const { item, computed } of thisWeek) {
        const key = formatDate(computed.dueAt)
        const list = grouped.get(key) || []
        list.push(`${item.name}（${computed.daysUntilDue} 天后到提醒点）`)
        grouped.set(key, list)
      }
      const groupLines = [...grouped.entries()].map(([date, names]) => `${date}：${names.join("、")}`)
      lines.push(overdue.length
        ? `接下来 7 天还要留意：${groupLines.join("；")}。`
        : `接下来 7 天要留意：${groupLines.join("；")}。`
      )
    }
    return withObs(lines.join("\n"), weekPrefs)
  }

  // 今天优先买什么：urgent > warning > dueAt，最多 5 项，附原因
  // 追加 budgetThreshold / negativeReviewRepurchase / priceAnomaly / cycleDrift（排除 dueSoon，答案已列到点物品）
  if (/今天|优先|现在|急|补什么|买什么|今天买|优先买/.test(text)) {
    const todayPrefs: ManagerObservation["kind"][] = ["budgetThreshold", "negativeReviewRepurchase", "priceAnomaly", "cycleDrift"]
    if (!urgent.length && !warning.length) return withObs("今天没有需要优先处理的，可以先放放。", todayPrefs)
    const priority = [...urgent, ...warning].slice(0, 5)
    const lines = priority.map(({ item, computed }, index) => {
      const reason = computed.daysUntilDepletion <= 0
        ? "预计已经用完"
        : computed.daysUntilDue <= 0
          ? `已到提醒点，${computed.remainingText}`
          : `${computed.daysUntilDue} 天后到提醒点，${computed.remainingText}`
      return `${index + 1}. ${item.name}：${reason}。`
    })
    return withObs([
      urgent.length ? `今天先看 ${urgent.length} 项急需补货。` : `今天没有急需的，另有 ${warning.length} 项快用完。`,
      ...lines
    ].join("\n"), todayPrefs)
  }

  // 哪些信息缺失：按 价格 / 平台 / 常购商品 / 评价 分组
  // 信息缺失与五类观察无直接重叠，全部维度都可追加，优先 dueSoon / budgetThreshold
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
    const missingPrefs: ManagerObservation["kind"][] = ["dueSoon", "budgetThreshold", "negativeReviewRepurchase", "priceAnomaly", "cycleDrift"]
    if (!missingPrice.length && !missingPlatform.length && !missingOption.length && !missingReview.length) {
      return withObs("价格、平台、常购商品、评价记录都还齐全，暂时不用补。", missingPrefs)
    }
    const groups: string[] = []
    if (missingPrice.length) groups.push(`价格：${missingPrice.map(({ item }) => item.name).slice(0, 10).join("、")}`)
    if (missingPlatform.length) groups.push(`平台：${missingPlatform.map(({ item }) => item.name).slice(0, 10).join("、")}`)
    if (missingOption.length) groups.push(`常购商品：${missingOption.map(({ item }) => item.name).slice(0, 10).join("、")}`)
    if (missingReview.length) groups.push(`评价：${missingReview.map(({ item }) => item.name).slice(0, 10).join("、")}`)
    return withObs(`有几处信息还缺，补上之后提醒会更准：${groups.join("；")}。不急的话下次补货时顺手补就行。`, missingPrefs)
  }

  // 哪些价格异常：本次单价 vs 此前历史均价（排除最新一条），超过 10% 标记
  // 追加 dueSoon / budgetThreshold / negativeReviewRepurchase / cycleDrift（排除 priceAnomaly，同维度）
  if (/价格异常|异常|均价|偏贵|贵了|涨价/.test(text)) {
    const anomalies: string[] = []
    for (const { item } of itemViews) {
      const priced = item.history.filter((event) => Number.isFinite(event.price) && event.price! > 0 && Number.isFinite(event.qty) && event.qty! > 0)
      if (priced.length < 2) continue
      const latest = priced[priced.length - 1]
      const prior = priced.slice(0, -1)
      const latestUnit = latest.price! / latest.qty!
      const avgUnit = prior.reduce((total, event) => total + event.price! / event.qty!, 0) / prior.length
      if (avgUnit <= 0) continue
      const ratio = latestUnit / avgUnit
      if (ratio > 1.1) {
        const pct = Math.round((ratio - 1) * 100)
        anomalies.push(`${item.name}这次单价 ¥${formatPrice(latestUnit)}，均价 ¥${formatPrice(avgUnit)}，贵了 ${pct}%`)
      } else if (ratio < 0.9) {
        const pct = Math.round((1 - ratio) * 100)
        anomalies.push(`${item.name}这次单价 ¥${formatPrice(latestUnit)}，均价 ¥${formatPrice(avgUnit)}，便宜了 ${pct}%`)
      }
    }
    const pricePrefs: ManagerObservation["kind"][] = ["dueSoon", "budgetThreshold", "negativeReviewRepurchase", "cycleDrift"]
    if (!anomalies.length) return withObs("最近几次补货的单价都还算正常，没明显异常。", pricePrefs)
    return withObs(`这几样本次单价和均价偏离超过 10%：${anomalies.join("；")}。`, pricePrefs)
  }

  return null
}

export function buildHouseholdChatStarter(itemViews: HouseholdChatItemView[]): string {
  if (!itemViews.length) return "咱们还没开始管任何消耗品。你跟我说一句「在京东买了两袋猫粮」，我就先把猫粮加进来。"
  const urgent = itemViews.filter(({ computed }) => computed.displayStatus === "urgent").length
  const warning = itemViews.filter(({ computed }) => computed.displayStatus === "warning").length
  if (urgent > 0) return `现在有 ${urgent} 项急需补货，要不先看看今天优先买什么？`
  if (warning > 0) return `有 ${warning} 项快用完了，最近几天可能要补一下。`
  return "当前库存看起来比较稳，你随时跟我说买了什么、记一笔就行。"
}

/**
 * 把 ConversationFocus 序列化为 LLM 可读的焦点描述。
 * 让 LLM 知道当前在处理什么任务，用户的话优先解释为什么。
 */
function describeActiveFocus(focus: ConversationFocus): string {
  if (focus.kind === "pendingDraft") {
    return `当前有一张待确认草稿（${describeAgentDraft(focus.draft)}）。用户这一轮的话优先解释为对这张草稿的补充或修订。`
  }
  if (focus.kind === "orderImport") {
    return `当前有 ${focus.rows.length} 行订单识别结果待确认。用户这一轮的话优先解释为对订单行的修改、跳过或确认。`
  }
  if (focus.kind === "clarification") {
    return `上一轮你发起了追问：${focus.clarification.question}。用户这一轮的话可能是对追问的回答。`
  }
  if (focus.kind === "queryTopic") {
    return `用户在问 ${focus.topic} 类问题。请基于【相关业务事实】中的数字回答，不要自行推算或编造。`
  }
  return "无特定焦点。用户这一轮的话可能是新任务或闲聊。"
}

/** 根据 focus 类型给 LLM 的动作指引 */
function describeAllowedActionsGuidance(focus: ConversationFocus): string {
  if (focus.kind === "pendingDraft") {
    return [
      "如果用户在补充商品评价（如「还挺好用的」「不起灰」「猫爱吃」），输出修订后的 draft，把评价写入 review 字段。",
      "如果用户说纯数字，优先补到 price 字段。",
      "如果说平台名（京东/淘宝/天猫等），补到 platform 字段。",
      "如果说日期，补到 restockDate 字段。",
      "明显跳题才输出 queryAnswer。"
    ].join("")
  }
  if (focus.kind === "orderImport") {
    return "可输出 queryAnswer 说明订单处理方式，或输出 draft 修订某行。"
  }
  if (focus.kind === "queryTopic") {
    return "输出 queryAnswer，数字必须取自【相关业务事实】段。"
  }
  return "根据用户意图输出 queryAnswer / draft / clarification 之一。"
}

export async function askHouseholdAssistant({
  apiKey,
  model,
  contextPack,
  repairMissingActionBlock
}: {
  apiKey: string
  model?: string
  /** 上下文包：包含 activeFocus / recentMessages / relevantAppFacts / pendingExecutable / allowedActions 等。
   *  LLM 只看到 contextPack 里的内容，不再接收完整 messages。 */
  contextPack: AgentContextPack
  /** 上一轮疑似忘记动作块时，仅重试一次并把协议纠正放进系统提示 */
  repairMissingActionBlock?: boolean
}): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const { dateContext, activeFocus, recentMessages, relevantAppFacts, pendingExecutable, allowedActions } = contextPack

  const systemPrompt = [
    buildHouseholdManagerSystemPrompt({
      pendingDraft: pendingExecutable,
      repairMissingActionBlock,
      dateContext
    }),
    "",
    "【当前时间】",
    `今天是：${dateContext.todayLabel}`,
    `当前时间：${dateContext.timestampLabel}`,
    `本地时区：${dateContext.timezone}`,
    "所有「今天、明天、昨天、这周、下周、未来 7 天」的判断都必须以这个日期为准。",
    "如果家庭数据里出现早于今天的提醒日期，它表示已经过了提醒点，不要说成未来要发生。",
    "",
    "【当前对话焦点】",
    describeActiveFocus(activeFocus),
    "",
    "【允许的动作】",
    allowedActions.join("、"),
    describeAllowedActionsGuidance(activeFocus),
    "",
    "【相关业务事实】",
    relevantAppFacts
  ].join("\n")

  const requestMessages = [
    { role: "system" as const, content: systemPrompt },
    ...recentMessages.map((message) => ({ role: message.role, content: message.content }))
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
