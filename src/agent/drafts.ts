import { DEFAULT_CYCLES } from "../domain"
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

export type AgentResponse =
  | { kind: "draft"; draft: AgentDraft; message?: string }
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

function parseQty(text: string): { qty?: number; unit?: string } {
  const match = text.match(new RegExp(`([一二两三四五六七八九十\\d]+)\\s*(${UNIT_PATTERN})`))
  return { qty: parseAmount(match?.[1]), unit: match?.[2] }
}

function parsePrice(text: string): number | undefined {
  const match = text.match(/(?:花了|花|价格|金额|共|一共|￥|¥)?\s*(\d+(?:\.\d+)?)\s*(?:块钱|块|元)/)
  return match ? Number(match[1]) : undefined
}

function parsePlatform(text: string): string | undefined {
  const match = text.match(/京东|淘宝|天猫|拼多多|抖音|1688|盒马|山姆|美团|超市|线下/)
  return match?.[0]
}

function inferCategory(itemName: string, state?: AppState): string {
  const name = itemName.toLocaleLowerCase("zh-CN")
  const category = name.includes("洗衣") || name.includes("凝珠") || name.includes("清洁")
    ? "洗衣清洁"
    : name.includes("猫") || name.includes("狗") || name.includes("宠物")
      ? "宠物"
      : name.includes("水费") || name.includes("电费") || name.includes("燃气")
        ? "水电煤"
        : name.includes("纸") || name.includes("洗发") || name.includes("沐浴") || name.includes("牙") || name.includes("洗面") || name.includes("护理")
          ? "日常护理"
          : "其他"
  return state?.categories.includes(category) ? category : category
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
    .replace(/^(添加|新建|创建|录入|登记|加一个|加个)/, "")
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

function findItem(state: AppState, itemName: string) {
  const normalized = norm(itemName)
  return state.items.find((item) => norm(item.name) === normalized)
    || state.items.find((item) => normalized.includes(norm(item.name)) || norm(item.name).includes(normalized))
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

export function buildLocalDraftFromText(text: string, state: AppState): AgentDraft | null {
  const compact = cleanText(text)
  const hasPurchaseSignal = /买了|下单|购入|花了|块钱|元|京东|淘宝|天猫|拼多多/.test(compact)
  if (hasPurchaseSignal) {
    const itemName = extractPurchasedName(compact)
    if (!itemName) return null
    const qty = parseQty(compact)
    const price = parsePrice(compact)
    const platform = parsePlatform(compact)
    const existing = findItem(state, itemName)
    if (existing) {
      return {
        kind: "restock",
        itemId: existing.id,
        itemName: existing.name,
        qty: qty.qty,
        unit: qty.unit || existing.unit,
        price,
        platform,
        purchaseProductName: itemName
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
        purchaseProductName: itemName
      },
      addPurchaseOption: { productName: itemName, unit: qty.unit || item.unit }
    }
  }

  if (/添加|新建|创建|录入|登记|帮我加|加一个|加个/.test(compact)) {
    const name = cleanItemName(compact)
    if (!name || name === "一个" || name === "个") return null
    return createItemDraftFromName(name, state)
  }

  return null
}

export function reviseAgentDraft(draft: AgentDraft, text: string): AgentDraft | null {
  const compact = cleanText(text)
  let changed = false
  const cycleMatch = compact.match(/(?:周期|补货周期).*?(\d+)\s*天/)
  const qty = parseQty(compact)
  const price = parsePrice(compact)
  const platform = parsePlatform(compact)

  const reviseRestock = <T extends RestockDraft | CreateItemWithRestockDraft["restock"]>(restock: T): T => {
    const next = { ...restock }
    if (qty.qty !== undefined) {
      next.qty = qty.qty
      changed = true
    }
    if (qty.unit) {
      next.unit = qty.unit
      changed = true
    }
    if (price !== undefined) {
      next.price = price
      changed = true
    }
    if (platform) {
      next.platform = platform
      changed = true
    }
    if (cycleMatch) {
      next.cycleDaysPatch = Number(cycleMatch[1])
      changed = true
    }
    return next
  }

  if (draft.kind === "createItem") {
    const next = { ...draft }
    if (cycleMatch) {
      next.cycleDays = Math.max(1, Number(cycleMatch[1]))
      next.bufferDays = Math.min(next.bufferDays, next.cycleDays - 1)
      changed = true
    }
    return changed ? next : null
  }

  if (draft.kind === "restock") {
    const next = reviseRestock(draft)
    return changed ? next : null
  }

  if (draft.kind === "createItemWithRestock") {
    const next: CreateItemWithRestockDraft = {
      ...draft,
      item: { ...draft.item },
      restock: reviseRestock(draft.restock)
    }
    if (cycleMatch) {
      next.item.cycleDays = Math.max(1, Number(cycleMatch[1]))
      next.item.bufferDays = Math.min(next.item.bufferDays, next.item.cycleDays - 1)
      changed = true
    }
    if (qty.unit && next.addPurchaseOption) next.addPurchaseOption = { ...next.addPurchaseOption, unit: qty.unit }
    return changed ? next : null
  }

  if (draft.kind === "addPurchaseOption" && qty.unit) {
    return { ...draft, unit: qty.unit }
  }

  return null
}

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
      restockDate: Number.isFinite(Number(record.restockDate)) ? Number(record.restockDate) : undefined
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
        restockDate: restock.restockDate
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
