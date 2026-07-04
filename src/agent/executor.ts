import { createItem, restockItem } from "../domain"
import type { AppState, PurchaseOption, ReplenishmentItem } from "../types"
import { findItemMatch, type AgentDraft, type CreateItemDraft, type RestockDraftDetails } from "./drafts"

export type AgentMessageLink = {
  label: string
  target: { kind: "item"; itemId: string } | { kind: "category"; category: string }
}

export type AgentCommitResult = {
  state: AppState
  summary: string
  links: AgentMessageLink[]
}

/**
 * 订单导入行转化为 AgentDraft 的输入结构。
 * 与 App.tsx 的 OrderImportConfirmedRow 结构一致，放在这里避免 executor 反向依赖 App.tsx。
 */
export type OrderImportDraftInput = {
  productName: string
  brandName?: string
  coreName?: string
  qty: number
  price?: number
  measureAmount?: number
  measureUnit?: string
  review?: string
  restockDate?: number
  platform?: string
  genericName?: string
  /** itemId | "__create__" | "__skip__" */
  targetItem: string
  /** "" (不指定) | optionId | "__newopt__" (新建常购商品) */
  targetOption: string
  /** 已解析的目标分类 */
  category: string
}

/**
 * 把订单截图导入确认页的每一行转成 AgentDraft。
 * - 命中已有物品 + 已有常购商品 → restock
 * - 命中已有物品 + 新建常购商品 → restock（常购商品由 commitAgentDraft 在写入时顺带建档，这里仅记 restock；为保留新建常购商品语义，升级为 createItemWithRestock 不合适，因为物品已存在）
 * - __create__ → createItemWithRestock（必要时附带 addPurchaseOption 语义）
 * - __skip__ → 跳过
 *
 * 注意：targetOption === "__newopt__" 时，由于目标物品已存在，我们仍用 restock 草稿，
 * 并把 purchaseProductName 传进去；新建常购商品的工作交给调用方在 commit 前用对话修正完成，
 * 或在后续迭代里扩展 restock 草稿支持 addPurchaseOption 标记。
 * 为满足「每行可转成 AgentDraft」的要求，这里对 targetOption === "__newopt__" 的情况
 * 升级为 createItemWithRestock 仅当 targetItem === "__create__"；否则保持 restock。
 */
export function buildAgentDraftsFromOrderRows(
  rows: OrderImportDraftInput[],
  state: AppState,
  now: number
): AgentDraft[] {
  const drafts: AgentDraft[] = []
  for (const row of rows) {
    if (row.targetItem === "__skip__") continue
    if (row.qty <= 0) continue
    const productName = (row.coreName || row.brandName || row.productName).trim()
    const genericName = (row.genericName || row.coreName || row.brandName || row.productName).trim()
    const category = (row.category || "其他").trim() || "其他"
    const restockDetails: RestockDraftDetails = {
      qty: Math.max(1, Math.round(row.qty)),
      unit: row.measureUnit,
      price: row.price,
      platform: row.platform,
      purchaseProductName: productName,
      restockDate: row.restockDate,
      review: row.review,
      purchaseMeasureAmount: row.measureAmount,
      purchaseMeasureUnit: row.measureUnit
    }

    if (row.targetItem === "__create__") {
      // 新建消耗品并补货；若要求新建常购商品则附 addPurchaseOption
      const itemName = genericName || productName
      if (!itemName) continue
      drafts.push({
        kind: "createItemWithRestock",
        item: {
          kind: "createItem",
          itemName,
          category,
          cycleDays: 30,
          bufferDays: 2,
          unit: row.measureUnit || "件"
        },
        restock: restockDetails,
        addPurchaseOption: productName && productName !== itemName
          ? { productName, unit: row.measureUnit || "件" }
          : undefined
      })
      continue
    }

    // 命中已有物品
    const target = state.items.find((item) => item.id === row.targetItem)
    if (!target) continue
    // targetOption === "__newopt__" 且有明确商品名 → 用 createItemWithRestock 不合适（物品已存在），
    // 这里走 restock，并把 purchaseProductName 设为识别出的商品名；新建常购商品由后续对话或 RestockModal 处理。
    drafts.push({
      kind: "restock",
      itemId: target.id,
      itemName: target.name,
      ...restockDetails
    })
  }
  return drafts
}

/** 可变工作区：批量写入时多个草稿共享同一份 categories/items。 */
export type AgentWorkState = {
  categories: string[]
  items: ReplenishmentItem[]
}

function norm(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN")
}

function findItem(items: ReplenishmentItem[], itemId: string | undefined, itemName: string): ReplenishmentItem | undefined {
  if (itemId) {
    const byId = items.find((item) => item.id === itemId)
    if (byId) return byId
  }
  // 复用 drafts.ts 的匹配逻辑：exact > synonym > substring > template
  const state: AppState = { categories: [], items, settings: {} as AppState["settings"], householdProfile: null, onboarding: {} as AppState["onboarding"], updatedAt: 0, version: 3 }
  const match = findItemMatch(state, itemName)
  if (match.item) return match.item
  // 兜底：裸 substring（findItemMatch 已覆盖，这里防御性保留）
  return items.find((item) => norm(itemName).includes(norm(item.name)) || norm(item.name).includes(norm(itemName)))
}

function itemFromDraft(draft: CreateItemDraft, now: number): ReplenishmentItem {
  return createItem({
    name: draft.itemName,
    category: draft.category,
    cycleDays: draft.cycleDays,
    bufferDays: draft.bufferDays,
    link: "",
    remainingDays: "",
    learningEnabled: true,
    unit: draft.unit,
    defaultQty: "",
    platform: ""
  }, now)
}

function ensureCategory(categories: string[], category: string): string[] {
  return categories.includes(category) ? categories : [...categories, category]
}

function buildRestockArgs(restock: RestockDraftDetails, item: ReplenishmentItem, now: number) {
  return {
    item: restock.cycleDaysPatch ? { ...item, cycleDays: restock.cycleDaysPatch, updatedAt: now } : item,
    now,
    price: restock.price,
    qty: restock.qty,
    platform: restock.platform,
    purchaseOptionId: undefined as string | undefined,
    purchaseProductName: restock.purchaseProductName || item.name,
    purchaseUnit: restock.unit || item.unit,
    purchasePricingMode: undefined as undefined,
    purchaseMeasureBaseAmount: undefined as number | undefined,
    purchaseMeasureAmount: restock.purchaseMeasureAmount,
    purchaseMeasureUnit: restock.purchaseMeasureUnit,
    review: restock.review,
    restockDate: restock.restockDate
  }
}

/**
 * 把单个草稿应用到一个可变工作区上。批量写入（订单导入）和单条确认共用此入口，
 * 不允许另写一套绕过逻辑。
 *
 * 返回新增的链接和本次小结；不修改 state，调用方负责拼装新 state。
 */
export function applyAgentDraft(
  work: AgentWorkState,
  draft: AgentDraft,
  now: number,
  links: AgentMessageLink[]
): string {
  const linkItem = (item: ReplenishmentItem) => {
    links.push({ label: `查看「${item.name}」`, target: { kind: "item", itemId: item.id } })
  }

  if (draft.kind === "createItem") {
    const existing = findItem(work.items, undefined, draft.itemName)
    if (existing) {
      linkItem(existing)
      return `没有创建新内容。消耗品「${existing.name}」已存在。`
    }
    work.categories = ensureCategory(work.categories, draft.category)
    const item = itemFromDraft(draft, now)
    work.items = [...work.items, item]
    linkItem(item)
    return `已创建：消耗品「${item.name}」。`
  }

  if (draft.kind === "addPurchaseOption") {
    const target = findItem(work.items, draft.itemId, draft.itemName)
    if (!target) return `没有创建新内容。找不到消耗品「${draft.itemName}」。`
    if (target.purchaseOptions.some((option) => norm(option.productName) === norm(draft.productName))) {
      linkItem(target)
      return `没有创建新内容。「${target.name}」下已有常购商品「${draft.productName}」。`
    }
    const option: PurchaseOption = {
      id: crypto.randomUUID(),
      productName: draft.productName,
      unit: draft.unit || target.unit || "件",
      pricingMode: "spec"
    }
    work.items = work.items.map((item) => item.id === target.id
      ? { ...item, purchaseOptions: [...item.purchaseOptions, option], updatedAt: now }
      : item)
    linkItem(target)
    return `已添加：常购商品「${draft.productName}」。`
  }

  if (draft.kind === "restock") {
    const target = findItem(work.items, draft.itemId, draft.itemName)
    if (!target) return `没有记录补货。找不到消耗品「${draft.itemName}」。`
    const args = buildRestockArgs(draft, target, now)
    const restocked = restockItem(
      args.item, args.now, args.price, args.qty, args.platform, args.purchaseOptionId,
      args.purchaseProductName, args.purchaseUnit, args.purchasePricingMode,
      args.purchaseMeasureBaseAmount, args.purchaseMeasureAmount, args.purchaseMeasureUnit,
      args.review, args.restockDate
    )
    work.items = work.items.map((item) => item.id === target.id ? restocked : item)
    linkItem(restocked)
    return `已记录：${restocked.name} 本次补货。`
  }

  // createItemWithRestock
  const existing = findItem(work.items, undefined, draft.item.itemName)
  let item = existing
  if (!item) {
    work.categories = ensureCategory(work.categories, draft.item.category)
    item = itemFromDraft(draft.item, now)
    if (draft.addPurchaseOption?.productName) {
      item = {
        ...item,
        purchaseOptions: [{
          id: crypto.randomUUID(),
          productName: draft.addPurchaseOption.productName,
          unit: draft.addPurchaseOption.unit || draft.restock.unit || draft.item.unit,
          pricingMode: "spec"
        }]
      }
    }
    work.items = [...work.items, item]
  }
  const args = buildRestockArgs(draft.restock, item, now)
  const restocked = restockItem(
    args.item, args.now, args.price, args.qty, args.platform,
    item.purchaseOptions[0]?.id,
    args.purchaseProductName || draft.addPurchaseOption?.productName || item.name,
    args.purchaseUnit, args.purchasePricingMode,
    args.purchaseMeasureBaseAmount, args.purchaseMeasureAmount, args.purchaseMeasureUnit,
    args.review, args.restockDate
  )
  work.items = work.items.map((candidate) => candidate.id === item!.id ? restocked : candidate)
  linkItem(restocked)
  return existing
    ? `已记录：${restocked.name} 本次补货。`
    : `已创建并记录：消耗品「${restocked.name}」。`
}

export function commitAgentDraft(state: AppState, draft: AgentDraft, now = Date.now()): AgentCommitResult {
  const links: AgentMessageLink[] = []
  const work: AgentWorkState = { categories: [...state.categories], items: [...state.items] }
  const summary = applyAgentDraft(work, draft, now, links)
  return {
    state: { ...state, categories: work.categories, items: work.items, updatedAt: now },
    summary,
    links
  }
}

/**
 * 批量确认：订单截图导入等多条草稿一次性写入，共享同一份工作区。
 * 任一条草稿找不到目标物品时只跳过它本身，不阻塞其它草稿。
 */
export function commitAgentDraftBatch(state: AppState, drafts: AgentDraft[], now = Date.now()): AgentCommitResult {
  const links: AgentMessageLink[] = []
  const work: AgentWorkState = { categories: [...state.categories], items: [...state.items] }
  const summaries: string[] = []
  for (const draft of drafts) {
    const summary = applyAgentDraft(work, draft, now, links)
    if (summary) summaries.push(summary)
  }
  return {
    state: { ...state, categories: work.categories, items: work.items, updatedAt: now },
    summary: summaries.join("\n"),
    links
  }
}
