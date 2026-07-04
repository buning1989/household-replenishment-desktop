import { createItem, restockItem } from "../domain"
import type { AppState, PurchaseOption, ReplenishmentItem } from "../types"
import type { AgentDraft, CreateItemDraft } from "./drafts"

export type AgentMessageLink = {
  label: string
  target: { kind: "item"; itemId: string } | { kind: "category"; category: string }
}

export type AgentCommitResult = {
  state: AppState
  summary: string
  links: AgentMessageLink[]
}

function norm(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN")
}

function findItem(items: ReplenishmentItem[], itemId: string | undefined, itemName: string): ReplenishmentItem | undefined {
  return (itemId ? items.find((item) => item.id === itemId) : undefined)
    || items.find((item) => norm(item.name) === norm(itemName))
    || items.find((item) => norm(itemName).includes(norm(item.name)) || norm(item.name).includes(norm(itemName)))
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

export function commitAgentDraft(state: AppState, draft: AgentDraft, now = Date.now()): AgentCommitResult {
  let categories = [...state.categories]
  let items = [...state.items]
  const links: AgentMessageLink[] = []

  const linkItem = (item: ReplenishmentItem) => {
    links.push({ label: `查看「${item.name}」`, target: { kind: "item", itemId: item.id } })
  }

  if (draft.kind === "createItem") {
    const existing = findItem(items, undefined, draft.itemName)
    if (existing) {
      linkItem(existing)
      return { state, summary: `没有创建新内容。\n消耗品「${existing.name}」已存在。`, links }
    }
    categories = ensureCategory(categories, draft.category)
    const item = itemFromDraft(draft, now)
    items = [...items, item]
    linkItem(item)
    return {
      state: { ...state, categories, items, updatedAt: now },
      summary: `已创建：消耗品「${item.name}」。`,
      links
    }
  }

  if (draft.kind === "addPurchaseOption") {
    const target = findItem(items, draft.itemId, draft.itemName)
    if (!target) return { state, summary: `没有创建新内容。\n找不到消耗品「${draft.itemName}」。`, links }
    if (target.purchaseOptions.some((option) => norm(option.productName) === norm(draft.productName))) {
      linkItem(target)
      return { state, summary: `没有创建新内容。\n「${target.name}」下已有常购商品「${draft.productName}」。`, links }
    }
    const option: PurchaseOption = {
      id: crypto.randomUUID(),
      productName: draft.productName,
      unit: draft.unit || target.unit || "件",
      pricingMode: "spec"
    }
    items = items.map((item) => item.id === target.id
      ? { ...item, purchaseOptions: [...item.purchaseOptions, option], updatedAt: now }
      : item)
    linkItem(target)
    return {
      state: { ...state, items, updatedAt: now },
      summary: `已添加：常购商品「${draft.productName}」。`,
      links
    }
  }

  if (draft.kind === "restock") {
    const target = findItem(items, draft.itemId, draft.itemName)
    if (!target) return { state, summary: `没有记录补货。\n找不到消耗品「${draft.itemName}」。`, links }
    const patchedTarget = draft.cycleDaysPatch ? { ...target, cycleDays: draft.cycleDaysPatch, updatedAt: now } : target
    const restocked = restockItem(
      patchedTarget,
      now,
      draft.price,
      draft.qty,
      draft.platform,
      undefined,
      draft.purchaseProductName || draft.itemName,
      draft.unit || patchedTarget.unit,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      draft.restockDate
    )
    items = items.map((item) => item.id === target.id ? restocked : item)
    linkItem(restocked)
    return {
      state: { ...state, items, updatedAt: now },
      summary: `已记录：${restocked.name} 本次补货。`,
      links
    }
  }

  const existing = findItem(items, undefined, draft.item.itemName)
  let item = existing
  if (!item) {
    categories = ensureCategory(categories, draft.item.category)
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
    items = [...items, item]
  }
  const itemForRestock = draft.restock.cycleDaysPatch
    ? { ...item, cycleDays: draft.restock.cycleDaysPatch, updatedAt: now }
    : item
  const restocked = restockItem(
    itemForRestock,
    now,
    draft.restock.price,
    draft.restock.qty,
    draft.restock.platform,
    itemForRestock.purchaseOptions[0]?.id,
    draft.restock.purchaseProductName || draft.addPurchaseOption?.productName || itemForRestock.name,
    draft.restock.unit || itemForRestock.unit,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    draft.restock.restockDate
  )
  items = items.map((candidate) => candidate.id === itemForRestock.id ? restocked : candidate)
  linkItem(restocked)
  return {
    state: { ...state, categories, items, updatedAt: now },
    summary: existing
      ? `已记录：${restocked.name} 本次补货。`
      : `已创建并记录：消耗品「${restocked.name}」。`,
    links
  }
}
