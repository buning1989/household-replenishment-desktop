import { addDays, DEFAULT_CYCLES, startOfDay } from "../domain"
import { CONSUMABLE_TEMPLATES } from "../model/consumableTemplates"
import type { AppState } from "../types"

export type AgentDraftStatus = "pending" | "confirmed" | "cancelled" | "superseded"

export type CreateItemDraft = {
  kind: "createItem"
  itemName: string
  category: string
  cycleDays: number
  bufferDays: number
  unit: string
}

export type RestockDraft = {
  kind: "restock"
  itemId?: string
  itemName: string
  qty?: number
  unit?: string
  price?: number
  platform?: string
  purchaseProductName?: string
  cycleDaysPatch?: number
  restockDate?: number
  /** 本次购买评价短句，如「好用」「猫不爱吃」 */
  review?: string
  /** 单件商品含量数值，如 500ml 中的 500 */
  purchaseMeasureAmount?: number
  /** 单件商品含量单位，如 ml / kg / 抽 */
  purchaseMeasureUnit?: string
  /** 物品匹配置信度低或疑似匹配时的提示，供卡片展示 */
  matchHint?: string
}

export type RestockDraftDetails = Omit<RestockDraft, "kind" | "itemId" | "itemName">

export type CreateItemWithRestockDraft = {
  kind: "createItemWithRestock"
  item: CreateItemDraft
  restock: RestockDraftDetails
  addPurchaseOption?: {
    productName: string
    unit?: string
  }
}

export type AddPurchaseOptionDraft = {
  kind: "addPurchaseOption"
  itemId?: string
  itemName: string
  productName: string
  unit?: string
}

export type AgentDraft =
  | CreateItemDraft
  | RestockDraft
  | CreateItemWithRestockDraft
  | AddPurchaseOptionDraft

/**
 * 订单截图行的展示摘要。用于 proposalBatch 中被跳过（非消耗品）或待确认（多匹配）的行。
 * 与 ExtractedOrderLine 的区别：这是面向对话展示的精简结构，只保留卡片需要的字段。
 */
export type OrderRow = {
  productName: string
  coreName?: string
  brandName?: string
  genericName?: string
  qty: number
  price?: number
  measureAmount?: number
  measureUnit?: string
  platform?: string
  orderDate?: number
  /** 跳过或待确认的原因，供卡片展示 */
  reason?: string
  /** 待确认行可能对应的物品名列表，供用户选择 */
  candidates?: string[]
}

export type ClarificationOption = {
  label: string
  /** 选中该选项时附带的修订意图；UI 可直接把 label 当作新的用户消息继续走流程。 */
  hint?: string
}

/** 模型主动澄清：写入对象不确定（同名、近义、模糊指代）时使用。
 *  - question：展示给用户的口语化追问
 *  - options：可点击的选项；UI 应让用户能直接点选，也可自由输入
 *  - provisional：暂存的草稿对象（不会写入 state），用户选完选项后由本地组装成完整草稿
 */
export type AgentClarification = {
  question: string
  options: ClarificationOption[]
  provisional?: AgentDraft
}

export type AgentResponse =
  | { kind: "draft"; draft: AgentDraft; message?: string }
  | { kind: "clarification"; clarification: AgentClarification }
  | { kind: "queryAnswer"; answer: string }

const UNIT_PATTERN = "包|瓶|袋|盒|支|卷|件|kg|斤|L|升"
const CHINESE_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10
}

function cleanText(value: string): string {
  return value.trim().replace(/\s+/g, "")
}

function norm(value: string): string {
  return cleanText(value).toLocaleLowerCase("zh-CN")
}

export function parseAmount(value: string | undefined): number | undefined {
  if (!value) return undefined
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value)
  if (value === "十") return 10
  if (value.startsWith("十")) return 10 + (CHINESE_DIGITS[value.slice(1)] || 0)
  if (value.endsWith("十")) return (CHINESE_DIGITS[value[0]] || 1) * 10
  if (value.includes("十")) {
    const [tens, ones] = value.split("十")
    return (CHINESE_DIGITS[tens] || 1) * 10 + (CHINESE_DIGITS[ones] || 0)
  }
  return CHINESE_DIGITS[value]
}

export function parseQty(text: string): { qty?: number; unit?: string } {
  const match = text.match(new RegExp(`([一二两三四五六七八九十\\d]+)\\s*(${UNIT_PATTERN})`))
  return { qty: parseAmount(match?.[1]), unit: match?.[2] }
}

export function parsePrice(text: string): number | undefined {
  // 优先匹配「前缀 + 数字 + 后缀单位」（如 花了100块钱、128元）
  const withSuffix = text.match(/(?:花了|花|价格|金额|共|一共|￥|¥)?\s*(\d+(?:\.\d+)?)\s*(?:块钱|块|元)/)
  if (withSuffix) return Number(withSuffix[1])
  // 兜底匹配「前缀 + 数字」（如 花了128，帮我记一下）
  const withPrefix = text.match(/(?:花了|花|价格|金额|共|一共|￥|¥)\s*(\d+(?:\.\d+)?)/)
  if (withPrefix) return Number(withPrefix[1])
  return undefined
}

export function parsePlatform(text: string): string | undefined {
  const match = text.match(/京东|淘宝|天猫|拼多多|抖音|1688|盒马|山姆|美团|超市|线下/)
  return match?.[0]
}

// ---------- 分类与别名 ----------

/** 标准分类（与 consumableTemplates 对齐）。 */
const CANONICAL_CATEGORIES = [
  "厨房",
  "卫生间",
  "洗衣清洁",
  "日常护理",
  "宠物用品",
  "母婴用品",
  "水电煤",
  "其他"
]

/**
 * 分类别名 → 标准分类。用户口语里的分类名先映射到标准名，
 * 再优先回落到 state.categories 里已存在的同名分类。
 */
const CATEGORY_ALIASES: Record<string, string> = {
  宠物: "宠物用品",
  猫狗: "宠物用品",
  猫咪用品: "宠物用品",
  猫用品: "宠物用品",
  狗用品: "宠物用品",
  个人护理: "日常护理",
  洗漱: "日常护理",
  洗护: "日常护理",
  清洁: "洗衣清洁",
  洗衣用品: "洗衣清洁",
  洗涤: "洗衣清洁",
  宝宝: "母婴用品",
  母婴: "母婴用品",
  婴儿: "母婴用品",
  厨房用品: "厨房",
  卫生: "卫生间",
  洗手间: "卫生间"
}

/**
 * 从一句话里解析目标分类。优先级：
 *   1. 显式「放到 X / 归到 X / 分类改成 X」后面的 X
 *   2. 句子里出现的标准分类名或别名
 * 命中别名时映射回标准分类；如果 state 里已有更具体的同名分类则用 state 的。
 */
export function resolveCategory(text: string, state?: AppState): string | undefined {
  const compacted = cleanText(text)
  const explicit = compacted.match(/(?:归到|放到|分类改成|分类改为|分类调整为|放到|归入|归到)([^\s，。,!.！？?的]+)/)
  const candidate = explicit?.[1] || compacted
  const stateCategories = state?.categories || []
  // 1) 精确命中 state 已有分类
  for (const category of stateCategories) {
    if (candidate.includes(category)) return category
  }
  // 2) 命中别名 → 标准分类
  for (const [alias, canonical] of Object.entries(CATEGORY_ALIASES)) {
    if (candidate.includes(alias)) {
      // 如果 state 里有以 canonical 开头的分类（例如「日常护理」），优先用 state 的
      const stateMatch = stateCategories.find((category) => category === canonical || category.includes(canonical) || canonical.includes(category))
      return stateMatch || canonical
    }
  }
  // 3) 命中标准分类名
  for (const canonical of CANONICAL_CATEGORIES) {
    if (candidate.includes(canonical)) return canonical
  }
  return undefined
}

function inferCategory(itemName: string, state?: AppState): string {
  const name = itemName.toLocaleLowerCase("zh-CN")
  const matched = resolveCategory(name, state)
  if (matched) return matched
  // 关键词兜底
  if (name.includes("厨房纸") || name.includes("洗洁精") || name.includes("保鲜") || name.includes("垃圾袋")) return "厨房"
  if (name.includes("卫生纸") || name.includes("卷纸") || name.includes("抽纸") || name.includes("面巾") || name.includes("手帕纸") || name.includes("洗手液") || name.includes("洁厕")) return "卫生间"
  if (name.includes("洗衣") || name.includes("凝珠") || name.includes("地板清洁") || name.includes("柔顺")) return "洗衣清洁"
  if (name.includes("猫") || name.includes("狗") || name.includes("宠物") || name.includes("尿垫") || name.includes("猫砂") || name.includes("猫粮")) return "宠物用品"
  if (name.includes("纸尿裤") || name.includes("湿巾") || name.includes("奶粉") || name.includes("母婴") || name.includes("宝宝")) return "母婴用品"
  if (name.includes("水费") || name.includes("电费") || name.includes("燃气")) return "水电煤"
  if (name.includes("洗发") || name.includes("沐浴") || name.includes("牙") || name.includes("洗面") || name.includes("护理") || name.includes("纸")) return "日常护理"
  return "其他"
}

function inferCycleDays(itemName: string): number {
  const localCycles: Record<string, number> = {
    洗衣凝珠: 15,
    洗发水: 30,
    洗面奶: 90
  }
  const match = Object.entries({ ...DEFAULT_CYCLES, ...localCycles }).find(([key]) => itemName.includes(key))
  return match ? match[1] : 30
}

function cleanItemName(raw: string): string {
  return cleanText(raw)
    .replace(/^帮我|^请帮我|^我想|^给我/, "")
    .replace(/^(添加一个|添加|新建一个|新建|创建一个|创建|录入|登记|加一个|加个)/, "")
    .replace(/(消耗品|补货单|补货记录|管理项|吧|一下)$/g, "")
    .replace(/[，。,.!！?？]/g, "")
    .replace(/的/g, "")
    .trim()
}

function extractPurchasedName(text: string): string | undefined {
  const compact = cleanText(text)
  const qty = parseQty(compact)
  if (qty.unit) {
    const qtyMatch = compact.match(new RegExp(`[一二两三四五六七八九十\\d]+${qty.unit}`))
    if (qtyMatch?.index !== undefined) {
      const afterQty = compact.slice(qtyMatch.index + qtyMatch[0].length)
      const name = afterQty
        .replace(/(，|,|。).*$/, "")
        .replace(/花了.*$/, "")
        .replace(/帮我.*$/, "")
        .replace(/创建.*$/, "")
      const cleaned = cleanItemName(name)
      if (cleaned) return cleaned
    }
  }
  const boughtMatch = compact.match(/买了(.+?)(?:，|,|。|花了|帮我|创建|$)/)
  return boughtMatch ? cleanItemName(boughtMatch[1]) : undefined
}

// ---------- 物品匹配 ----------

/** 物品同义词表：query → 物品名（用于 findItem 的 synonym 层）。 */
const ITEM_SYNONYMS: Record<string, string[]> = {
  卫生纸: ["卷纸", "抽纸", "面巾纸", "手帕纸"],
  纸巾: ["抽纸", "卷纸", "卫生纸"],
  沐浴露: ["沐浴乳", "浴液"],
  洗衣液: ["洗衣液"],
  猫粮: ["猫粮"],
  猫砂: ["猫砂"]
}

/** 容易误匹配的短名：query 太短且能命中多个物品时，只标记疑似匹配。 */
const AMBIGUOUS_SHORT_NAMES = ["纸", "粮", "砂", "液", "露", "膏", "剂"]

export type ItemMatch = {
  item?: import("../types").ReplenishmentItem
  confidence: "exact" | "synonym" | "substring" | "template" | "ambiguous"
  candidates: string[]
  hint?: string
}

/**
 * 增强物品匹配：exact > alias(category) > synonym > substring > template。
 * 对「纸 / 粮 / 砂」这类短名给出疑似匹配提示，不直接断言。
 */
export function findItemMatch(state: AppState, query: string): ItemMatch {
  const normalized = norm(query)
  const items = state.items || []
  const candidates: string[] = []
  if (!normalized) return { confidence: "ambiguous", candidates }

  // 1) exact
  const exact = items.find((item) => norm(item.name) === normalized)
  if (exact) return { item: exact, confidence: "exact", candidates: [exact.name] }

  // 2) synonym（query 是某物品的同义词）
  for (const [canonical, synonyms] of Object.entries(ITEM_SYNONYMS)) {
    if (synonyms.includes(query) || synonyms.includes(normalized)) {
      const match = items.find((item) => norm(item.name) === norm(canonical))
      if (match) return { item: match, confidence: "synonym", candidates: [match.name] }
    }
    // 反向：query 命中 canonical，物品名是同义词
    if (canonical === query || canonical === normalized) {
      const match = items.find((item) => synonyms.some((synonym) => norm(synonym) === norm(item.name)))
      if (match) return { item: match, confidence: "synonym", candidates: [match.name] }
    }
  }

  // 3) substring（双向包含）
  const substringMatches = items.filter((item) => {
    const name = norm(item.name)
    return name.includes(normalized) || normalized.includes(name)
  })
  if (substringMatches.length === 1) {
    return { item: substringMatches[0], confidence: "substring", candidates: [substringMatches[0].name] }
  }
  if (substringMatches.length > 1) {
    // 短名 + 多命中 → 疑似匹配
    if (AMBIGUOUS_SHORT_NAMES.includes(normalized) || normalized.length <= 2) {
      const hint = `「${query}」可能指：${substringMatches.map((item) => item.name).join("、")}，请确认是哪一个。`
      return { item: substringMatches[0], confidence: "ambiguous", candidates: substringMatches.map((item) => item.name), hint }
    }
    // 多命中但 query 较长，取最短物品名（通常是最贴近的通用名）
    const sorted = [...substringMatches].sort((a, b) => a.name.length - b.name.length)
    return { item: sorted[0], confidence: "substring", candidates: sorted.map((item) => item.name) }
  }

  // 4) template match（基于内置消耗品模板的名称匹配）
  const template = CONSUMABLE_TEMPLATES.find((template) =>
    template.name === query
    || norm(template.name) === normalized
    || template.name.includes(query)
    || query.includes(template.name)
  )
  if (template) {
    candidates.push(template.name)
    return { confidence: "template", candidates: [template.name], hint: `「${query}」可对应模板「${template.name}」，但库里还没有这个物品。` }
  }

  return { confidence: "ambiguous", candidates }
}

/** 旧 API 保留：只返回 item。 */
function findItem(state: AppState, itemName: string) {
  return findItemMatch(state, itemName).item
}

export function createItemDraftFromName(itemName: string, state?: AppState, unit?: string): CreateItemDraft {
  const name = cleanItemName(itemName)
  const cycleDays = inferCycleDays(name)
  return {
    kind: "createItem",
    itemName: name,
    category: inferCategory(name, state),
    cycleDays,
    bufferDays: Math.min(2, Math.max(0, cycleDays - 1)),
    unit: unit || "件"
  }
}

// ---------- 自然语言字段解析 ----------

const WEEKDAY_KEYS: Record<string, number> = {
  一: 1, 壹: 1, 1: 1,
  二: 2, 贰: 2, 2: 2,
  三: 3, 叁: 3, 3: 3,
  四: 4, 肆: 4, 4: 4,
  五: 5, 伍: 5, 5: 5,
  六: 6, 陆: 6, 6: 6,
  日: 0, 天: 0, 末: 0, 0: 0
}

/** 解析自然日期：今天/昨天/前天/大前天/上周X/N月N日/YYYY-MM-DD → 当天 00:00 时间戳。 */
export function parseNaturalDate(text: string, now = Date.now()): number | undefined {
  const compacted = cleanText(text)
  if (/今天|今日/.test(compacted)) return startOfDay(now)
  if (/大前天/.test(compacted)) return startOfDay(addDays(now, -3))
  if (/前天/.test(compacted)) return startOfDay(addDays(now, -2))
  if (/昨天|昨日/.test(compacted)) return startOfDay(addDays(now, -1))
  const lastWeekMatch = compacted.match(/上周([一二三四五六日天末壹贰叁肆伍陆柒0-9])/)
  if (lastWeekMatch) {
    const target = WEEKDAY_KEYS[lastWeekMatch[1]]
    if (target !== undefined) {
      const current = new Date(startOfDay(now))
      const currentDay = current.getDay()
      let diff = currentDay - target
      if (diff <= 0) diff += 7
      if (diff === 0) diff = 7
      return startOfDay(addDays(now, -diff))
    }
  }
  // N月N日
  const mdMatch = compacted.match(/(\d{1,2})月(\d{1,2})[日号]/)
  if (mdMatch) {
    const month = Number(mdMatch[1])
    const day = Number(mdMatch[2])
    return buildDate(month, day, now)
  }
  // YYYY-MM-DD
  const ymdMatch = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (ymdMatch) {
    const [, year, month, day] = ymdMatch.map(Number)
    const date = new Date(year, month - 1, day)
    date.setHours(0, 0, 0, 0)
    const ts = date.getTime()
    if (Number.isFinite(ts)) return ts
  }
  return undefined
}

function buildDate(month: number, day: number, now: number): number | undefined {
  const year = new Date(now).getFullYear()
  let date = new Date(year, month - 1, day)
  date.setHours(0, 0, 0, 0)
  // 如果该日期还没到，可能是去年的
  if (date.getTime() > now + 24 * 60 * 60 * 1000) {
    date = new Date(year - 1, month - 1, day)
    date.setHours(0, 0, 0, 0)
  }
  return date.getTime()
}

/** 评价关键词 → 短评。按列表顺序，取第一个命中。 */
const REVIEW_PHRASES: Array<{ keys: string[]; review: string }> = [
  { keys: ["下次不买", "下次别买", "不回购", "不会再买"], review: "下次不买" },
  { keys: ["猫不爱吃", "猫不吃", "猫讨厌"], review: "猫不爱吃" },
  { keys: ["味道大", "味道重", "气味大"], review: "味道大" },
  { keys: ["质量一般", "质量差", "一般般"], review: "质量一般" },
  { keys: ["不好用", "不好使", "难用"], review: "不好用" },
  { keys: ["好用", "挺好用", "不错", "挺不错", "好用"], review: "好用" },
  { keys: ["回购", "会回购", "继续回购"], review: "回购" }
]

export function parseReview(text: string): string | undefined {
  const compacted = cleanText(text)
  for (const { keys, review } of REVIEW_PHRASES) {
    if (keys.some((key) => compacted.includes(key))) return review
  }
  return undefined
}

/** 解析单件商品含量规格：500ml / 2kg / 100抽 / 24片 / 24卷 → {amount, unit}。 */
const SPEC_UNIT_PATTERN = "(ml|毫升|L|升|kg|公斤|千克|g|克|抽|片|卷)"

export function parseSpec(text: string): { amount: number; unit: string } | undefined {
  const compacted = cleanText(text)
  const match = compacted.match(new RegExp(`(\\d+(?:\\.\\d+)?)${SPEC_UNIT_PATTERN}`))
  if (!match) return undefined
  const amount = Number(match[1])
  const unit = match[2]
  if (!Number.isFinite(amount) || amount <= 0) return undefined
  return { amount, unit: normalizeSpecUnit(unit) }
}

function normalizeSpecUnit(unit: string): string {
  switch (unit) {
    case "毫升": return "ml"
    case "升": return "L"
    case "公斤":
    case "千克": return "kg"
    case "克": return "g"
    default: return unit
  }
}

/** 解析商品名修订：「商品名叫 X」「买的是 X」→ X。 */
export function parseProductNameRevision(text: string): string | undefined {
  const compacted = cleanText(text)
  const m1 = compacted.match(/(?:商品名叫|商品名是|买的是|品牌是|牌子是)([^\s，。,!.！？?的]+)/)
  if (m1) return m1[1]
  return undefined
}

/** 解析 itemName 修订：「不是 X 是 Y」「这个不是 X，是 Y」→ { from, to }。 */
export function parseItemNameRevision(text: string): { from: string; to: string } | undefined {
  const compacted = cleanText(text)
  // 允许第一组和「是」之间出现标点（如「不是抽纸，是卷纸」）
  const m = compacted.match(/(?:这个)?不是([^\s，。,!.！？?是]+)[，。,!.！？?\s]*是([^\s，。,!.！？?]+)/)
  if (m && m[1] && m[2] && m[1] !== "不") return { from: m[1], to: m[2] }
  return undefined
}

// ---------- 草稿构建 ----------

export function buildLocalDraftFromText(text: string, state: AppState): AgentDraft | null {
  const compact = cleanText(text)

  // 常购商品优先级最高：把 X 加为某物品的常购商品
  // 必须在补货信号判断之前，避免「加成卷纸的常购商品」被「加+卷」误吞
  const addOptionMatch = compact.match(/(?:把|给)?(.+?)的?常购商品/)
  if (addOptionMatch) {
    const productName = cleanItemName(addOptionMatch[1])
    if (productName && productName !== "常购商品") {
      const match = findItemMatch(state, productName)
      if (match.item) {
        return {
          kind: "addPurchaseOption",
          itemId: match.item.id,
          itemName: match.item.name,
          productName,
          unit: match.item.unit
        }
      }
    }
  }

  // 「加一袋猫砂」「加一瓶洗发水」这种「加+量词」也算补货信号，走 restock/createItemWithRestock
  // 但要排除「加一个」「加个」这种建档信号（无量词）
  const hasQtyWithAdd = /(?:加|补|买|购入).{0,4}(?:包|瓶|袋|盒|支|卷|件|kg|斤|L|升)/.test(compact)
  const hasPurchaseSignal = hasQtyWithAdd || /买了|下单|购入|入手|囤了|续上|补了|补货了|收货了|快递到了|花了|块钱|元|京东|淘宝|天猫|拼多多/.test(compact)
  if (hasPurchaseSignal) {
    const itemName = extractPurchasedName(compact)
    if (!itemName) return null
    const qty = parseQty(compact)
    const price = parsePrice(compact)
    const platform = parsePlatform(compact)
    const spec = parseSpec(compact)
    const review = parseReview(compact)
    const restockDate = parseNaturalDate(compact) || startOfDay(Date.now())
    const match = findItemMatch(state, itemName)
    if (match.item) {
      return {
        kind: "restock",
        itemId: match.item.id,
        itemName: match.item.name,
        qty: qty.qty,
        unit: qty.unit || match.item.unit,
        price,
        platform,
        purchaseProductName: itemName,
        review,
        purchaseMeasureAmount: spec?.amount,
        purchaseMeasureUnit: spec?.unit,
        restockDate,
        matchHint: match.confidence === "ambiguous" ? match.hint : undefined
      }
    }
    const item = createItemDraftFromName(itemName, state, qty.unit)
    return {
      kind: "createItemWithRestock",
      item,
      restock: {
        qty: qty.qty,
        unit: qty.unit || item.unit,
        price,
        platform,
        purchaseProductName: itemName,
        review,
        purchaseMeasureAmount: spec?.amount,
        purchaseMeasureUnit: spec?.unit,
        restockDate,
        matchHint: match.confidence === "template" ? match.hint : undefined
      },
      addPurchaseOption: { productName: itemName, unit: qty.unit || item.unit }
    }
  }

  // 「帮我加一个猫砂」等无补货信号时仍可能命中已有物品 → 走 restock（避免重复创建）
  if (/添加|新建|创建|录入|登记|帮我加|加一个|加个|加入清单|以后提醒|帮我管/.test(compact)) {
    // 如果用户说了具体物品名且库里已存在，且用户没有「以后提醒」「加入清单」等强建档信号，
    // 则视为补货而非创建
    const name = cleanItemName(compact.replace(/以后提醒|帮我管|加入清单/g, ""))
    if (name && name !== "一个" && name !== "个" && !/以后提醒|加入清单|帮我管/.test(compact)) {
      const match = findItemMatch(state, name)
      if (match.item && match.confidence === "exact") {
        return {
          kind: "restock",
          itemId: match.item.id,
          itemName: match.item.name,
          qty: 1,
          unit: match.item.unit,
          restockDate: startOfDay(Date.now())
        }
      }
    }
    const cleanedName = cleanItemName(compact.replace(/以后提醒|帮我管|加入清单/g, ""))
    if (!cleanedName || cleanedName === "一个" || cleanedName === "个") return null
    return createItemDraftFromName(cleanedName, state)
  }

  return null
}

// ---------- 草稿修订 ----------

function applyRestockRevision(restock: RestockDraftDetails, text: string): { restock: RestockDraftDetails; changed: boolean } {
  const next: RestockDraftDetails = { ...restock }
  let changed = false
  // 「不是 X，是 Y」模式：从 Y 段提取字段，避免被 X 段误命中
  const revisionMatch = text.match(/不是.*?是(.+?)(?:，|,|。|$)/)
  const revisionSource = revisionMatch ? revisionMatch[1] : text
  const qty = parseQty(revisionSource)
  let price = parsePrice(revisionSource)
  // 任务四 B4：纯数字（如「45」「45.5」）在修订上下文中视为价格补充。
  // 仅当 parsePrice 未命中时兜底；不影响 buildLocalDraftFromText 的初始解析。
  if (price === undefined) {
    const cleanedRevision = cleanText(revisionSource)
    if (/^[0-9]+(?:\.[0-9]+)?$/.test(cleanedRevision)) {
      price = Number(cleanedRevision)
    }
  }
  const platform = parsePlatform(revisionSource)
  const spec = parseSpec(revisionSource)
  const review = parseReview(text)
  const date = parseNaturalDate(text)
  const productRevision = parseProductNameRevision(text)
  const cycleMatch = text.match(/(?:周期|补货周期).*?(\d+)\s*天/)

  if (qty.qty !== undefined) { next.qty = qty.qty; changed = true }
  if (qty.unit) { next.unit = qty.unit; changed = true }
  if (price !== undefined) { next.price = price; changed = true }
  if (platform) { next.platform = platform; changed = true }
  if (spec) { next.purchaseMeasureAmount = spec.amount; next.purchaseMeasureUnit = spec.unit; changed = true }
  if (review) { next.review = review; changed = true }
  if (date !== undefined) { next.restockDate = date; changed = true }
  if (productRevision) { next.purchaseProductName = productRevision; changed = true }
  if (cycleMatch) { next.cycleDaysPatch = Number(cycleMatch[1]); changed = true }
  return { restock: next, changed }
}

export function reviseAgentDraft(draft: AgentDraft, text: string, state?: AppState): AgentDraft | null {
  const compact = cleanText(text)
  let changed = false
  const cycleMatch = compact.match(/(?:周期|补货周期).*?(\d+)\s*天/)
  const categoryRevision = resolveCategory(text, state)
  const itemNameRevision = parseItemNameRevision(text)
  const productRevision = parseProductNameRevision(text)
  const review = parseReview(text)
  const date = parseNaturalDate(text)

  if (draft.kind === "createItem") {
    const next: CreateItemDraft = { ...draft }
    if (cycleMatch) {
      next.cycleDays = Math.max(1, Number(cycleMatch[1]))
      next.bufferDays = Math.min(next.bufferDays, next.cycleDays - 1)
      changed = true
    }
    if (categoryRevision) { next.category = categoryRevision; changed = true }
    if (itemNameRevision) {
      // 修订物品名：重新推断分类和周期
      next.itemName = cleanItemName(itemNameRevision.to)
      if (!categoryRevision) next.category = inferCategory(next.itemName, state)
      next.cycleDays = inferCycleDays(next.itemName)
      next.bufferDays = Math.min(next.bufferDays, next.cycleDays - 1)
      changed = true
    }
    return changed ? next : null
  }

  if (draft.kind === "restock") {
    // itemName 修订：可能要切换到另一个物品
    if (itemNameRevision && state) {
      const newMatch = findItemMatch(state, itemNameRevision.to)
      if (newMatch.item) {
        const baseDetails: RestockDraftDetails = {
          qty: draft.qty, unit: draft.unit, price: draft.price, platform: draft.platform,
          purchaseProductName: draft.purchaseProductName, cycleDaysPatch: draft.cycleDaysPatch,
          restockDate: draft.restockDate, review: draft.review,
          purchaseMeasureAmount: draft.purchaseMeasureAmount, purchaseMeasureUnit: draft.purchaseMeasureUnit,
          matchHint: newMatch.confidence === "ambiguous" ? newMatch.hint : undefined
        }
        const { restock } = applyRestockRevision(baseDetails, text)
        return {
          kind: "restock",
          itemId: newMatch.item.id,
          itemName: newMatch.item.name,
          ...restock
        }
      }
      // 新名字库里没有 → 升级为 createItemWithRestock
      const item = createItemDraftFromName(itemNameRevision.to, state)
      return {
        kind: "createItemWithRestock",
        item,
        restock: {
          qty: draft.qty,
          unit: draft.unit || item.unit,
          price: draft.price,
          platform: draft.platform,
          purchaseProductName: draft.purchaseProductName || itemNameRevision.to,
          cycleDaysPatch: draft.cycleDaysPatch,
          restockDate: draft.restockDate,
          review: draft.review,
          purchaseMeasureAmount: draft.purchaseMeasureAmount,
          purchaseMeasureUnit: draft.purchaseMeasureUnit
        },
        addPurchaseOption: { productName: draft.purchaseProductName || itemNameRevision.to, unit: draft.unit || item.unit }
      }
    }
    const base: RestockDraft = { ...draft }
    if (categoryRevision) {
      // restock 草稿没有 category 字段；如果用户说改分类，且物品名匹配到某物品，
      // 这里不改物品本身分类（那是 createItem 的事），只提示。但若改的是 itemName 命中物品则上面已处理。
      // 这里不做改动，避免误改 restock 记录。
    }
    const { restock, changed: restockChanged } = applyRestockRevision(base, text)
    void review; void date; void productRevision
    return restockChanged ? { ...draft, ...restock } as RestockDraft : null
  }

  if (draft.kind === "createItemWithRestock") {
    const nextItem: CreateItemDraft = { ...draft.item }
    const nextRestock: RestockDraftDetails = { ...draft.restock }
    if (cycleMatch) {
      nextItem.cycleDays = Math.max(1, Number(cycleMatch[1]))
      nextItem.bufferDays = Math.min(nextItem.bufferDays, nextItem.cycleDays - 1)
      nextRestock.cycleDaysPatch = nextItem.cycleDays
      changed = true
    }
    if (categoryRevision) { nextItem.category = categoryRevision; changed = true }
    if (itemNameRevision) {
      nextItem.itemName = cleanItemName(itemNameRevision.to)
      if (!categoryRevision) nextItem.category = inferCategory(nextItem.itemName, state)
      nextItem.cycleDays = inferCycleDays(nextItem.itemName)
      nextItem.bufferDays = Math.min(nextItem.bufferDays, nextItem.cycleDays - 1)
      changed = true
    }
    const { restock, changed: restockChanged } = applyRestockRevision(nextRestock, text)
    Object.assign(nextRestock, restock)
    changed = changed || restockChanged
    if (nextRestock.unit && draft.addPurchaseOption) {
      draft.addPurchaseOption = { ...draft.addPurchaseOption, unit: nextRestock.unit }
    }
    return changed ? { ...draft, item: nextItem, restock: nextRestock } : null
  }

  if (draft.kind === "addPurchaseOption") {
    const next: AddPurchaseOptionDraft = { ...draft }
    if (productRevision) { next.productName = productRevision; changed = true }
    if (itemNameRevision && state) {
      const newMatch = findItemMatch(state, itemNameRevision.to)
      if (newMatch.item) { next.itemId = newMatch.item.id; next.itemName = newMatch.item.name; changed = true }
    }
    const qty = parseQty(text)
    if (qty.unit) { next.unit = qty.unit; changed = true }
    return changed ? next : null
  }

  return null
}

// ---------- 模型回复解析（兼容旧协议） ----------

function normalizeDraft(raw: unknown, state?: AppState): AgentDraft | null {
  if (typeof raw !== "object" || raw === null) return null
  const record = raw as Record<string, unknown>
  const kind = typeof record.kind === "string" ? record.kind : ""
  if (kind === "createItem") {
    const itemName = typeof record.itemName === "string" ? record.itemName.trim() : ""
    if (!itemName) return null
    return {
      kind,
      itemName,
      category: typeof record.category === "string" && record.category.trim() ? record.category.trim() : inferCategory(itemName, state),
      cycleDays: Number.isFinite(Number(record.cycleDays)) && Number(record.cycleDays) > 0 ? Math.round(Number(record.cycleDays)) : inferCycleDays(itemName),
      bufferDays: Number.isFinite(Number(record.bufferDays)) && Number(record.bufferDays) >= 0 ? Math.round(Number(record.bufferDays)) : 2,
      unit: typeof record.unit === "string" && record.unit.trim() ? record.unit.trim() : "件"
    }
  }
  if (kind === "restock") {
    const itemName = typeof record.itemName === "string" ? record.itemName.trim() : ""
    if (!itemName) return null
    return {
      kind,
      itemId: typeof record.itemId === "string" ? record.itemId : undefined,
      itemName,
      qty: Number.isFinite(Number(record.qty)) && Number(record.qty) > 0 ? Number(record.qty) : undefined,
      unit: typeof record.unit === "string" && record.unit.trim() ? record.unit.trim() : undefined,
      price: Number.isFinite(Number(record.price)) && Number(record.price) >= 0 ? Number(record.price) : undefined,
      platform: typeof record.platform === "string" && record.platform.trim() ? record.platform.trim() : undefined,
      purchaseProductName: typeof record.purchaseProductName === "string" && record.purchaseProductName.trim() ? record.purchaseProductName.trim() : itemName,
      cycleDaysPatch: Number.isFinite(Number(record.cycleDaysPatch)) && Number(record.cycleDaysPatch) > 0 ? Math.round(Number(record.cycleDaysPatch)) : undefined,
      restockDate: Number.isFinite(Number(record.restockDate)) ? Number(record.restockDate) : undefined,
      review: typeof record.review === "string" && record.review.trim() ? record.review.trim() : undefined,
      purchaseMeasureAmount: Number.isFinite(Number(record.purchaseMeasureAmount)) && Number(record.purchaseMeasureAmount) > 0 ? Number(record.purchaseMeasureAmount) : undefined,
      purchaseMeasureUnit: typeof record.purchaseMeasureUnit === "string" && record.purchaseMeasureUnit.trim() ? record.purchaseMeasureUnit.trim() : undefined,
      matchHint: typeof record.matchHint === "string" && record.matchHint.trim() ? record.matchHint.trim() : undefined
    }
  }
  if (kind === "createItemWithRestock") {
    const item = normalizeDraft(record.item, state)
    if (!item || item.kind !== "createItem") return null
    const restock = normalizeDraft({ ...(typeof record.restock === "object" && record.restock ? record.restock : {}), kind: "restock", itemName: item.itemName }, state)
    if (!restock || restock.kind !== "restock") return null
    const optionRecord = typeof record.addPurchaseOption === "object" && record.addPurchaseOption ? record.addPurchaseOption as Record<string, unknown> : null
    return {
      kind,
      item,
      restock: {
        qty: restock.qty,
        unit: restock.unit || item.unit,
        price: restock.price,
        platform: restock.platform,
        purchaseProductName: restock.purchaseProductName || item.itemName,
        cycleDaysPatch: restock.cycleDaysPatch,
        restockDate: restock.restockDate,
        review: restock.review,
        purchaseMeasureAmount: restock.purchaseMeasureAmount,
        purchaseMeasureUnit: restock.purchaseMeasureUnit,
        matchHint: restock.matchHint
      },
      addPurchaseOption: optionRecord && typeof optionRecord.productName === "string" && optionRecord.productName.trim()
        ? { productName: optionRecord.productName.trim(), unit: typeof optionRecord.unit === "string" ? optionRecord.unit.trim() : undefined }
        : undefined
    }
  }
  if (kind === "addPurchaseOption") {
    const itemName = typeof record.itemName === "string" ? record.itemName.trim() : ""
    const productName = typeof record.productName === "string" ? record.productName.trim() : ""
    if (!itemName || !productName) return null
    return {
      kind,
      itemId: typeof record.itemId === "string" ? record.itemId : undefined,
      itemName,
      productName,
      unit: typeof record.unit === "string" && record.unit.trim() ? record.unit.trim() : undefined
    }
  }
  return null
}

function normalizeClarification(raw: unknown): AgentClarification | null {
  if (typeof raw !== "object" || raw === null) return null
  const record = raw as Record<string, unknown>
  const question = typeof record.question === "string" ? record.question.trim() : ""
  if (!question) return null
  const optionsRaw = Array.isArray(record.options) ? record.options : []
  const options: ClarificationOption[] = []
  for (const entry of optionsRaw) {
    if (typeof entry === "string") {
      const trimmed = entry.trim()
      if (trimmed) options.push({ label: trimmed })
    } else if (typeof entry === "object" && entry !== null) {
      const label = typeof (entry as Record<string, unknown>).label === "string"
        ? String((entry as Record<string, unknown>).label).trim()
        : ""
      if (label) {
        const hint = typeof (entry as Record<string, unknown>).hint === "string"
          ? String((entry as Record<string, unknown>).hint).trim()
          : undefined
        options.push({ label, hint })
      }
    }
    if (options.length >= 6) break
  }
  if (!options.length) return null
  const provisional = normalizeDraft(record.provisional, undefined)
  return { question, options, provisional: provisional || undefined }
}

export function parseAgentResponse(content: string, state?: AppState): AgentResponse | null {
  const source = content.trim()
  const start = source.indexOf("{")
  const end = source.lastIndexOf("}")
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(source.slice(start, end + 1)) as Record<string, unknown>
    if (parsed.kind === "queryAnswer" && typeof parsed.answer === "string") {
      return { kind: "queryAnswer", answer: parsed.answer.trim() }
    }
    if (parsed.kind === "clarification") {
      const clarification = normalizeClarification(parsed.clarification)
      return clarification ? { kind: "clarification", clarification } : null
    }
    if (parsed.kind === "draft") {
      const draft = normalizeDraft(parsed.draft, state)
      return draft ? { kind: "draft", draft, message: typeof parsed.message === "string" ? parsed.message.trim() : undefined } : null
    }
    const draft = normalizeDraft(parsed, state)
    return draft ? { kind: "draft", draft } : null
  } catch {
    return null
  }
}

export function describeAgentDraft(draft: AgentDraft): string {
  if (draft.kind === "createItem") return `消耗品「${draft.itemName}」`
  if (draft.kind === "restock") return `补货记录「${draft.itemName}」`
  if (draft.kind === "createItemWithRestock") return `消耗品「${draft.item.itemName}」和本次补货`
  return `常购商品「${draft.productName}」`
}

/**
 * 本地澄清生成器：当 buildLocalDraftFromText 检测到写入对象不确定时，
 * 返回一个 AgentClarification 让用户选具体物品，而不是直接写入。
 *
 * 触发场景：
 *  1. 已有「猫砂」时用户说「帮我加一个猫砂」→ 不是创建，是补货或改节奏
 *  2. 已有多个相近物品（猫砂/猫粮/猫罐头）时用户说「猫的那个加一袋」→ 让用户选
 *
 * 返回 null 表示本地没识别到需要澄清的场景，应交给模型。
 */
export function buildLocalClarification(text: string, state: AppState): AgentClarification | null {
  const compact = cleanText(text)
  const hasAddSignal = /加一个|添加一个|新建一个|帮我加|加个|创建一个/.test(compact)
  if (!hasAddSignal) return null

  // 提取用户提到的物品名（去掉「加一个/帮我加」等动作词）
  const name = cleanItemName(compact.replace(/帮我加一个|帮我加|加一个|加个|添加一个|新建一个|创建一个|以后提醒|加入清单/g, ""))
  if (!name || name === "一个" || name === "个") return null

  const match = findItemMatch(state, name)
  // 场景 1：精确命中已有物品 → 不是创建，问是补货还是改节奏
  if (match.item && match.confidence === "exact") {
    return {
      question: `${match.item.name}已经在管了。你这次是要记一笔补货，还是想改一下提醒节奏？`,
      options: [
        { label: `记一笔${match.item.name}补货`, hint: `记一笔${match.item.name}补货` },
        { label: "改提醒节奏", hint: `把${match.item.name}的周期改一下` },
        { label: `打开${match.item.name}`, hint: `打开${match.item.name}` }
      ],
      provisional: {
        kind: "restock",
        itemId: match.item.id,
        itemName: match.item.name,
        unit: match.item.unit,
        restockDate: startOfDay(Date.now())
      }
    }
  }
  // 场景 2：多个相近物品，且 query 较模糊 → 让用户选具体哪一个
  if (match.candidates.length > 1 && (match.confidence === "ambiguous" || AMBIGUOUS_SHORT_NAMES.includes(norm(name)) || name.length <= 2)) {
    const candidateItems = match.candidates
      .map((candidateName) => state.items.find((item) => item.name === candidateName))
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .slice(0, 4)
    if (candidateItems.length > 1) {
      return {
        question: `你说的是${candidateItems.map((item) => item.name).join("、")}哪一个？我怕记错，先跟你确认一下。`,
        options: candidateItems.map((item) => ({
          label: item.name,
          hint: `给${item.name}记一笔补货`
        }))
      }
    }
  }
  return null
}

// ---------- 通知带出的草稿构造 ----------

/**
 * 任务六补丁：通知点击 openChat 时，构造该物品的本地 restock 草稿。
 * 预填上次购买的平台/商品名/数量（照旧），价格不预填（每笔不同）。
 * 用户回「确认」即可记单；也可先修订再确认。
 */
export function buildNotificationRestockDraft(
  item: import("../types").ReplenishmentItem,
  now: number = Date.now()
): AgentDraft {
  const latest = item.history[item.history.length - 1]
  return {
    kind: "restock",
    itemId: item.id,
    itemName: item.name,
    qty: latest?.qty || 1,
    unit: latest?.purchaseUnit || item.unit,
    platform: latest?.platform || item.platform,
    purchaseProductName: latest?.purchaseProductName,
    restockDate: startOfDay(now)
  }
}

/**
 * 任务六补丁：通知 openChat 时管家消息文案。
 * 引用上次购买的平台和商品名，问用户要不要照旧记一单。
 */
export function buildNotificationRestockMessage(item: import("../types").ReplenishmentItem): string {
  const latest = item.history[item.history.length - 1]
  const platform = latest?.platform || item.platform || "上次购买的平台"
  const productName = latest?.purchaseProductName || item.name
  return `${item.name}到提醒点了，${platform}买的${productName}，要不要照旧记一单？`
}
