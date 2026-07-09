/**
 * RecordInference：草稿字段建议引擎。
 *
 * 设计目标：
 *   1. 当 draft 缺 price / platform / unit 等字段时，不直接追问用户，
 *      而是先基于历史采购记录、常购商品、同品类记录、生活常识给出参考判断。
 *   2. 输出的 FieldSuggestion 只是「建议」，不直接写入 state；
 *      由 responseComposer 拼成口语化提示，让用户校正即可。
 *   3. 文案原则：有历史就用历史，没有历史就用常识，绝不假装历史。
 *
 * 数据来源优先级：
 *   itemHistory（当前物品的历史记录） >
 *   purchaseOption（当前物品的常购商品价格） >
 *   categoryHistory（同品类其他物品的历史，低置信参考） >
 *   template（内置模板默认值） >
 *   llmPrior（生活常识区间，最低置信）
 */

import { CONSUMABLE_TEMPLATES } from "../model/consumableTemplates"
import type { AppState, ReplenishmentItem, RestockEvent } from "../types"
import type { AgentDraft } from "./drafts"
import { findPricePrior, computePriceRange } from "./pricePrior"

export type FieldSuggestion = {
  field: "price" | "platform" | "purchaseProductName" | "unit" | "cycleDays"
  value?: string | number
  range?: { min: number; max: number }
  confidence: "high" | "medium" | "low"
  source: "itemHistory" | "purchaseOption" | "categoryHistory" | "template" | "llmPrior"
  reason: string
}

/** 简化版 ItemView，避免和 householdChat 里的 HouseholdChatItemView 强耦合。 */
export type InferenceItemView = { item: ReplenishmentItem }

/**
 * 历史价格统计：基于已有补货记录（price > 0 且 qty > 0），计算单价分布。
 * 返回 null 表示没有可用历史。
 */
type PriceStats = {
  /** 单价样本（price / qty） */
  unitPrices: number[]
  /** 平均单价 */
  average: number
  /** 中位单价 */
  median: number
  /** 最低单价 */
  min: number
  /** 最高单价 */
  max: number
  /** 样本数 */
  count: number
  /** 最近一次的单价（如有） */
  latest?: number
  /** 最近一次的平台（如有） */
  latestPlatform?: string
  /** 历史平台集合（去重） */
  platforms: string[]
}

function computePriceStats(history: RestockEvent[]): PriceStats | null {
  const priced = history.filter(
    (event) => Number.isFinite(event.price) && event.price! > 0 && Number.isFinite(event.qty) && event.qty! > 0
  )
  if (priced.length === 0) return null
  const unitPrices = priced.map((event) => event.price! / event.qty!)
  const sorted = [...unitPrices].sort((a, b) => a - b)
  const sum = unitPrices.reduce((total, value) => total + value, 0)
  const average = sum / unitPrices.length
  const median = sorted.length % 2 === 1
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
  const platforms = Array.from(
    new Set(
      priced
        .map((event) => event.platform)
        .filter((platform): platform is string => Boolean(platform && platform.trim()))
    )
  )
  const latest = priced[priced.length - 1]
  return {
    unitPrices,
    average,
    median,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    count: unitPrices.length,
    latest: latest.price! / latest.qty!,
    latestPlatform: latest.platform,
    platforms
  }
}

/** 单价波动判定：max/min > 1.2 视为波动较大。 */
function isVolatile(stats: PriceStats): boolean {
  if (stats.count < 2) return false
  if (stats.min <= 0) return false
  return stats.max / stats.min > 1.2
}

/** 在草稿里找出实际的物品名 / itemId / qty / unit / 已有平台。 */
function extractDraftContext(draft: AgentDraft): {
  itemName: string
  itemId?: string
  qty?: number
  unit?: string
  platform?: string
  category?: string
} {
  if (draft.kind === "restock") {
    return {
      itemName: draft.itemName,
      itemId: draft.itemId,
      qty: draft.qty,
      unit: draft.unit,
      platform: draft.platform
    }
  }
  if (draft.kind === "createItemWithRestock") {
    return {
      itemName: draft.item.itemName,
      qty: draft.restock.qty,
      unit: draft.restock.unit || draft.item.unit,
      platform: draft.restock.platform,
      category: draft.item.category
    }
  }
  if (draft.kind === "createItem") {
    return { itemName: draft.itemName, unit: draft.unit, category: draft.category }
  }
  // addPurchaseOption 不需要价格建议
  return { itemName: draft.itemName, itemId: draft.itemId }
}

/** 在 state.items 中按 itemId 或 itemName 找到当前物品。 */
function findItemInState(state: AppState, itemName: string, itemId?: string): ReplenishmentItem | undefined {
  if (itemId) {
    const byId = state.items.find((item) => item.id === itemId)
    if (byId) return byId
  }
  const lower = itemName.trim().toLocaleLowerCase("zh-CN")
  return state.items.find((item) => item.name.trim().toLocaleLowerCase("zh-CN") === lower)
}

// 已迁移到 pricePrior.ts 模块，使用更精确的细分类目价格先验

/** 价格建议主逻辑：综合 itemHistory / purchaseOption / categoryHistory / llmPrior。 */
function buildPriceSuggestion(
  draft: AgentDraft,
  state: AppState,
  itemViews: InferenceItemView[],
  ctx: { itemName: string; itemId?: string; qty?: number; unit?: string; platform?: string }
): FieldSuggestion | null {
  const qty = ctx.qty && ctx.qty > 0 ? ctx.qty : 1
  const unit = ctx.unit || "件"
  const item = findItemInState(state, ctx.itemName, ctx.itemId)

  // 1) 当前物品历史价格
  if (item) {
    const stats = computePriceStats(item.history)
    if (stats) {
      const perWhat = item.unit || unit
      const rounded = (value: number) => Math.round(value)
      if (isVolatile(stats)) {
        // 波动大：给区间，confidence 取决于样本数
        const minTotal = rounded(stats.min * qty)
        const maxTotal = rounded(stats.max * qty)
        const confidence = stats.count >= 3 ? "medium" : "low"
        return {
          field: "price",
          range: { min: minTotal, max: maxTotal },
          confidence,
          source: "itemHistory",
          reason: `过去${ctx.itemName}单价在 ¥${rounded(stats.min)}~¥${rounded(stats.max)}/${perWhat} 之间，这次 ${qty}${unit} 大概 ¥${minTotal}~¥${maxTotal}`
        }
      }
      // 波动小：给单一值（用平均单价 × qty）
      const unitPrice = stats.average
      const total = rounded(unitPrice * qty)
      const confidence = stats.count >= 3 ? "high" : "medium"
      const unitPriceText = Number.isFinite(unitPrice) ? Math.round(unitPrice) : unitPrice
      return {
        field: "price",
        value: total,
        confidence,
        source: "itemHistory",
        reason: `过去${ctx.itemName}大约 ¥${unitPriceText}/${perWhat}，这次 ${qty}${unit} 约 ¥${total}`
      }
    }
  }

  // 2) 当前物品常购商品价格（purchaseOption.price 是 deprecated 单件价）
  if (item && item.purchaseOptions.length > 0) {
    const defaultOption = item.purchaseOptions.find((option) => option.isDefault) || item.purchaseOptions[0]
    if (defaultOption && Number.isFinite(defaultOption.price) && defaultOption.price! > 0) {
      const unitPrice = defaultOption.price!
      const total = Math.round(unitPrice * qty)
      return {
        field: "price",
        value: total,
        confidence: "medium",
        source: "purchaseOption",
        reason: `按常购商品「${defaultOption.productName}」¥${Math.round(unitPrice)}/${unit} 估算，${qty}${unit} 约 ¥${total}`
      }
    }
  }

  // 3) 同品类其他物品的历史价格（低置信参考）
  if (item) {
    const category = item.category
    const siblings = (itemViews || []).map((view) => view.item).filter((other) => other.category === category && other.id !== item.id)
    const siblingUnitPrices: number[] = []
    for (const sibling of siblings) {
      const siblingStats = computePriceStats(sibling.history)
      if (siblingStats) siblingUnitPrices.push(...siblingStats.unitPrices)
    }
    if (siblingUnitPrices.length >= 2) {
      const sorted = [...siblingUnitPrices].sort((a, b) => a - b)
      const minUnit = sorted[0]
      const maxUnit = sorted[sorted.length - 1]
      const minTotal = Math.round(minUnit * qty)
      const maxTotal = Math.round(maxUnit * qty)
      return {
        field: "price",
        range: { min: minTotal, max: maxTotal },
        confidence: "low",
        source: "categoryHistory",
        reason: `同分类（${category}）其他物品单价在 ¥${Math.round(minUnit)}~¥${Math.round(maxUnit)}/${unit}，${qty}${unit} 大概 ¥${minTotal}~¥${maxTotal}（仅供参考）`
      }
    }
  }

  // 4) 内置模板默认价格（极少命中，因为模板不存价格，这里仅作为兜底返回 null 走 llmPrior）
  // 模板没有 price 字段，跳过。

  // 5) llmPrior：基于细分类目价格先验（pricePrior.ts）
  // 只有命中细分类目时才估价，未命中时返回 null（不估价）
  const prior = findPricePrior(ctx.itemName)
  if (!prior) {
    // 未命中细分类目，不估价
    return null
  }
  
  const range = computePriceRange(prior, qty)
  if (!range) {
    return null
  }
  
  const perWhat = prior.unit[0] || unit
  return {
    field: "price",
    range: { min: range.min, max: range.max },
    confidence: prior.confidence,
    source: "llmPrior",
    reason: `按${ctx.itemName}常见价格范围粗估，${qty}${unit} 大概 ¥${range.min}~¥${range.max}（这只是常见范围，不是历史记录）`
  }
}

/** 平台建议：基于历史平台习惯给参考，但不强加。 */
function buildPlatformSuggestion(
  draft: AgentDraft,
  state: AppState,
  ctx: { itemName: string; itemId?: string; platform?: string }
): FieldSuggestion | null {
  // 用户已经说了平台，不需要建议
  if (ctx.platform && ctx.platform.trim()) return null
  const item = findItemInState(state, ctx.itemName, ctx.itemId)
  if (!item) return null

  const platforms = Array.from(
    new Set(
      item.history
        .map((event) => event.platform)
        .filter((platform): platform is string => Boolean(platform && platform.trim()))
    )
  )
  if (platforms.length === 0 && item.platform) {
    platforms.push(item.platform)
  }
  if (platforms.length === 0) return null

  const primary = platforms[0]
  const confidence = platforms.length === 1 ? "high" : "medium"
  const reasonText = platforms.length === 1
    ? `之前一直在${primary}买`
    : `之前大多在${platforms.slice(0, 2).join("、")}买`
  return {
    field: "platform",
    value: primary,
    confidence,
    source: "itemHistory",
    reason: reasonText
  }
}

/** CycleDays 建议：来自物品本身或模板默认。仅在 createItem 类草稿且周期不确定时给。 */
function buildCycleSuggestion(
  draft: AgentDraft,
  _state: AppState,
  ctx: { itemName: string; category?: string }
): FieldSuggestion | null {
  if (draft.kind !== "createItem" && draft.kind !== "createItemWithRestock") return null
  // 已有物品的 cycleDays 已由 createItemDraftFromName 推断，这里不重复给
  // 仅在模板命中时给一个 template source 的低置信建议，让用户知道这是默认值
  const template = CONSUMABLE_TEMPLATES.find((entry) => entry.name === ctx.itemName || ctx.itemName.includes(entry.name))
  if (!template) return null
  return {
    field: "cycleDays",
    value: template.defaultCycleDays,
    confidence: "low",
    source: "template",
    reason: `按常见${template.name}消耗节奏，约 ${template.defaultCycleDays} 天一轮（只是默认值，可以改）`
  }
}

/**
 * 入口：根据草稿 + state + itemViews，生成字段建议列表。
 *
 * 注意：
 *   - 只在草稿缺字段时给建议；字段已齐全时返回空数组。
 *   - 建议值只是参考，调用方（responseComposer）负责拼成口语化提示，
 *     不直接写入 state。用户确认草稿时仍按 executableDraft 原值提交。
 */
export function buildRecordSuggestions(
  draft: AgentDraft,
  state: AppState,
  itemViews: InferenceItemView[]
): FieldSuggestion[] {
  if (draft.kind !== "restock" && draft.kind !== "createItemWithRestock") {
    // createItem / addPurchaseOption 不涉及价格/平台建议
    const ctx = extractDraftContext(draft)
    const cycle = buildCycleSuggestion(draft, state, ctx)
    return cycle ? [cycle] : []
  }

  const ctx = extractDraftContext(draft)
  const suggestions: FieldSuggestion[] = []

  // 价格建议：只在 price 缺失时给
  const restockDetails = draft.kind === "restock" ? draft : draft.restock
  const priceMissing = restockDetails.price === undefined || restockDetails.price === null
  if (priceMissing) {
    const priceSuggestion = buildPriceSuggestion(draft, state, itemViews, ctx)
    if (priceSuggestion) suggestions.push(priceSuggestion)
  }

  // 平台建议：只在 platform 缺失时给
  const platformMissing = !restockDetails.platform
  if (platformMissing) {
    const platformSuggestion = buildPlatformSuggestion(draft, state, ctx)
    if (platformSuggestion) suggestions.push(platformSuggestion)
  }

  return suggestions
}

/**
 * 工具：从建议列表里取指定字段的建议。便于 responseComposer 调用。
 */
export function findSuggestionByField(
  suggestions: FieldSuggestion[],
  field: FieldSuggestion["field"]
): FieldSuggestion | undefined {
  return suggestions.find((suggestion) => suggestion.field === field)
}

/**
 * 工具：判断当前草稿的某字段是否已有用户输入（非空）。
 * 用于决定是否需要给建议。
 */
export function isFieldFilled(draft: AgentDraft, field: FieldSuggestion["field"]): boolean {
  if (draft.kind === "restock") {
    if (field === "price") return draft.price !== undefined && draft.price !== null
    if (field === "platform") return Boolean(draft.platform && draft.platform.trim())
    if (field === "unit") return Boolean(draft.unit && draft.unit.trim())
    if (field === "purchaseProductName") return Boolean(draft.purchaseProductName && draft.purchaseProductName.trim())
  }
  if (draft.kind === "createItemWithRestock") {
    if (field === "price") return draft.restock.price !== undefined && draft.restock.price !== null
    if (field === "platform") return Boolean(draft.restock.platform && draft.restock.platform.trim())
    if (field === "unit") return Boolean((draft.restock.unit || draft.item.unit || "").trim())
    if (field === "purchaseProductName") return Boolean(draft.restock.purchaseProductName && draft.restock.purchaseProductName.trim())
  }
  return false
}
