import { createItem, restockItem } from "../domain"
import type { AppState, PurchaseOption, ReplenishmentItem } from "../types"
import { fuzzyMatchItem, type ExtractedOrder, type ExtractedOrderLine } from "../llm/orderImport"
import { CONSUMABLE_TEMPLATES } from "../model/consumableTemplates"
import { createItemDraftFromName, findItemMatch, type AgentDraft, type CreateItemDraft, type OrderRow, type RestockDraftDetails } from "./drafts"
import { buildPostCommitObservation } from "./observations"
import type { ChatDateContext } from "../llm/householdChat"

export type AgentMessageLink = {
  label: string
  target: { kind: "item"; itemId: string } | { kind: "category"; category: string }
}

export type AgentCommitResult = {
  state: AppState
  summary: string
  links: AgentMessageLink[]
  /**
   * 任务四（写入后观察）：commit 成功后针对本次写入物品运行观察引擎的口语化收尾。
   * 无命中时为 undefined。调用方拼接到结果消息末尾。
   */
  observation?: string
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
      // 使用 createItemDraftFromName 推断分类/周期/单位，避免硬编码 30/2
      const inferred = createItemDraftFromName(itemName, state, row.measureUnit)
      // 尊重调用方传入的 category（弹窗流程里用户已选择分类）
      const resolvedCategory = category && category !== "其他" ? category : inferred.category
      drafts.push({
        kind: "createItemWithRestock",
        item: {
          kind: "createItem",
          itemName,
          category: resolvedCategory,
          cycleDays: inferred.cycleDays,
          // bufferDays 按周期的 20% 向上取整，上限 7 天；比固定 2 更贴近消耗品节奏
          bufferDays: Math.min(Math.ceil(inferred.cycleDays * 0.2), 7),
          unit: row.measureUnit || inferred.unit || "件"
        },
        restock: restockDetails,
        addPurchaseOption: productName && productName !== itemName
          ? { productName, unit: row.measureUnit || inferred.unit || "件" }
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

export function commitAgentDraft(
  state: AppState,
  draft: AgentDraft,
  now: number = Date.now(),
  dateContext?: ChatDateContext,
  seenObservationKeys?: Set<string>
): AgentCommitResult {
  const links: AgentMessageLink[] = []
  const work: AgentWorkState = { categories: [...state.categories], items: [...state.items] }
  const summary = applyAgentDraft(work, draft, now, links)
  const nextState = { ...state, categories: work.categories, items: work.items, updatedAt: now }

  // 任务四：写入后观察——针对本次写入的物品运行三类判定
  const observation = runPostCommitObservation(draft, work.items, now, dateContext, seenObservationKeys)

  return {
    state: nextState,
    summary,
    links,
    observation
  }
}

/**
 * 批量确认：订单截图导入等多条草稿一次性写入，共享同一份工作区。
 * 任一条草稿找不到目标物品时只跳过它本身，不阻塞其它草稿。
 */
export function commitAgentDraftBatch(
  state: AppState,
  drafts: AgentDraft[],
  now: number = Date.now(),
  dateContext?: ChatDateContext,
  seenObservationKeys?: Set<string>
): AgentCommitResult {
  const links: AgentMessageLink[] = []
  const work: AgentWorkState = { categories: [...state.categories], items: [...state.items] }
  const summaries: string[] = []
  for (const draft of drafts) {
    const summary = applyAgentDraft(work, draft, now, links)
    if (summary) summaries.push(summary)
  }
  const nextState = { ...state, categories: work.categories, items: work.items, updatedAt: now }

  // 任务四：写入后观察——对每条草稿的写入物品运行判定，取最重要的一条
  let observation: string | undefined
  if (dateContext) {
    for (const draft of drafts) {
      const obs = runPostCommitObservation(draft, work.items, now, dateContext, seenObservationKeys)
      if (obs) {
        observation = obs
        break // 取第一条命中（已按重要性排序）
      }
    }
  }

  return {
    state: nextState,
    summary: summaries.join("\n"),
    links,
    observation
  }
}

/**
 * 任务四：针对本次写入的物品运行观察引擎的三类判定。
 * 仅 restock / createItemWithRestock 草稿会产生新 history 记录，需要检查。
 * 复用 observations.ts 的 buildPostCommitObservation，不重新实现判定规则。
 */
function runPostCommitObservation(
  draft: AgentDraft,
  items: ReplenishmentItem[],
  now: number,
  dateContext?: ChatDateContext,
  seenObservationKeys?: Set<string>
): string | undefined {
  if (!dateContext) return undefined

  // 找到本次写入的物品
  let targetItem: ReplenishmentItem | undefined
  if (draft.kind === "restock") {
    targetItem = items.find((item) =>
      draft.itemId ? item.id === draft.itemId : item.name === draft.itemName
    )
  } else if (draft.kind === "createItemWithRestock") {
    targetItem = items.find((item) => item.name === draft.item.itemName)
  }

  if (!targetItem) return undefined

  const observation = buildPostCommitObservation(targetItem, dateContext, seenObservationKeys)
  return observation?.text
}

// ---------- 订单截图自动映射（对话上传截图用） ----------

/** 明显非消耗品的关键词：命中即跳过，不生成草稿。 */
const NON_CONSUMABLE_KEYWORDS = [
  "手机壳", "手机膜", "保护膜", "保护壳", "数据线", "充电线", "充电器", "充电宝", "移动电源",
  "耳机", "蓝牙耳机", "音箱", "音响", "智能手表", "手表", "手环",
  "键盘", "鼠标", "鼠标垫", "显示器", "电脑", "笔记本", "平板", "电纸书",
  "路由器", "网线", "转换器", "扩展坞", "读卡器", "U盘", "移动硬盘", "硬盘",
  "衣服", "上衣", "裤子", "鞋子", "运动鞋", "拖鞋", "袜子", "包包", "钱包", "皮带", "帽子", "围巾", "手套", "眼镜",
  "玩具", "手办", "图书", "书籍", "小说", "杂志", "文具", "本子", "笔袋",
  "刀", "剪刀", "工具", "螺丝", "胶带", "电池"
]

/** 订单行自动映射结果。drafts 是可执行草稿；skippedRows 是非消耗品；uncertainRows 是歧义行。 */
export type OrderLineMapping = {
  drafts: AgentDraft[]
  skippedRows: OrderRow[]
  uncertainRows: OrderRow[]
}

function isNonConsumable(line: ExtractedOrderLine): boolean {
  const haystack = [line.productName, line.brandName, line.coreName, line.genericName]
    .filter((text): text is string => Boolean(text))
    .join(" ")
    .toLocaleLowerCase("zh-CN")
  return NON_CONSUMABLE_KEYWORDS.some((keyword) => haystack.includes(keyword.toLocaleLowerCase("zh-CN")))
}

function templateMatches(line: ExtractedOrderLine): { name: string; category: string; cycleDays: number; bufferDays: number; unit: string } | null {
  const texts = [line.genericName, line.coreName, line.brandName, line.productName].filter((text): text is string => Boolean(text))
  for (const text of texts) {
    const lower = text.toLocaleLowerCase("zh-CN")
    const template = CONSUMABLE_TEMPLATES.find((template) =>
      template.name === text
      || template.name.toLocaleLowerCase("zh-CN") === lower
      || lower.includes(template.name)
      || template.name.includes(text)
    )
    if (template) {
      return {
        name: template.name,
        category: template.category,
        cycleDays: template.defaultCycleDays,
        bufferDays: template.bufferDays,
        unit: template.unit
      }
    }
  }
  return null
}

function buildOrderRow(line: ExtractedOrderLine, platform?: string, orderDate?: number, reason?: string, candidates?: string[]): OrderRow {
  return {
    productName: line.productName,
    coreName: line.coreName,
    brandName: line.brandName,
    genericName: line.genericName,
    qty: line.qty,
    price: line.price,
    measureAmount: line.measureAmount,
    measureUnit: line.measureUnit,
    platform,
    orderDate,
    reason,
    candidates
  }
}

/**
 * 把订单截图识别结果自动映射为 AgentDraft + skippedRows + uncertainRows。
 *
 * 对话上传截图后调用此函数（不经弹窗的逐行编辑），由本地匹配 + 模型信号共同判断：
 *   1. 模型返回 matchedItemName 或本地 findItemMatch 命中已有物品 → restock draft
 *   2. 模型返回 genericName 或本地模板命中但无已有物品 → createItemWithRestock draft
 *   3. findItemMatch 返回 ambiguous 且有多个候选 → uncertainRows（仍生成 best-guess draft 带 matchHint）
 *   4. 命中非消耗品关键词或模型 + 本地都无消耗品信号 → skippedRows
 *
 * 订单弹窗和对话上传都复用此函数的输出（drafts）走 commitAgentDraftBatch。
 */
export function mapOrderLinesToDrafts(
  order: ExtractedOrder,
  state: AppState,
  now: number
): OrderLineMapping {
  const drafts: AgentDraft[] = []
  const skippedRows: OrderRow[] = []
  const uncertainRows: OrderRow[] = []
  const platform = order.platform
  const orderDate = order.orderDate

  for (const line of order.lines) {
    if (line.qty <= 0) continue

    // 1) 非消耗品关键词命中 → 直接跳过
    if (isNonConsumable(line)) {
      skippedRows.push(buildOrderRow(line, platform, orderDate, "不像日常消耗品，先不管"))
      continue
    }

    const productName = (line.coreName || line.brandName || line.productName).trim()
    const matchQuery = line.genericName || line.coreName || line.brandName || line.productName

    // 2) 已有物品匹配：模型信号 + 本地 findItemMatch + 模糊兜底
    let matchedItemId: string | undefined
    let matchedItemName: string | undefined
    let matchHint: string | undefined
    let uncertain = false
    let candidates: string[] = []

    // 2a) 模型指定 matchedItemName
    if (line.matchedItemName) {
      const byName = state.items.find((item) => item.name === line.matchedItemName)
      if (byName) {
        matchedItemId = byName.id
        matchedItemName = byName.name
      }
    }
    // 2b) 本地 findItemMatch（覆盖模型未命中的情况）
    if (!matchedItemId && matchQuery) {
      const match = findItemMatch(state, matchQuery)
      if (match.item) {
        if (match.confidence === "ambiguous" && match.candidates.length > 1) {
          uncertain = true
          candidates = match.candidates
          matchHint = match.hint || `「${matchQuery}」可能对应：${match.candidates.join("、")}，请确认是哪一个。`
        }
        matchedItemId = match.item.id
        matchedItemName = match.item.name
      }
    }
    // 2c) 模糊兜底（覆盖 findItemMatch 漏掉的情况，与弹窗逻辑一致）
    if (!matchedItemId) {
      const fuzzy = fuzzyMatchItem([line.coreName, line.productName, line.brandName, line.genericName], state.items)
      if (fuzzy) {
        matchedItemId = fuzzy.id
        matchedItemName = fuzzy.name
      }
    }

    // 3) 命中已有物品 → restock draft
    if (matchedItemId && matchedItemName) {
      const restockDetails: RestockDraftDetails = {
        qty: Math.max(1, Math.round(line.qty)),
        unit: line.measureUnit,
        price: line.price,
        platform,
        purchaseProductName: productName,
        restockDate: orderDate,
        review: undefined,
        purchaseMeasureAmount: line.measureAmount,
        purchaseMeasureUnit: line.measureUnit,
        matchHint
      }
      drafts.push({
        kind: "restock",
        itemId: matchedItemId,
        itemName: matchedItemName,
        ...restockDetails
      })
      if (uncertain) {
        uncertainRows.push(buildOrderRow(line, platform, orderDate, matchHint, candidates))
      }
      continue
    }

    // 4) 无已有物品但有消耗品信号 → createItemWithRestock
    const template = templateMatches(line)
    const hasConsumableSignal = Boolean(line.genericName) || Boolean(template) || Boolean(line.matchedItemName)
    if (hasConsumableSignal) {
      const itemName = (line.genericName || template?.name || line.coreName || line.brandName || line.productName).trim()
      if (!itemName) continue
      const inferred = createItemDraftFromName(itemName, state, line.measureUnit)
      // 周期/缓冲天数优先用 createItemDraftFromName 推断（基于 DEFAULT_CYCLES），
      // 模板只作为分类和消耗品信号的来源；bufferDays 按周期 20% 向上取整，上限 7 天。
      const resolvedCategory = template?.category || inferred.category
      const cycleDays = inferred.cycleDays || template?.cycleDays || 30
      const bufferDays = Math.min(Math.ceil(cycleDays * 0.2), 7)
      const unit = line.measureUnit || template?.unit || inferred.unit || "件"
      drafts.push({
        kind: "createItemWithRestock",
        item: {
          kind: "createItem",
          itemName,
          category: resolvedCategory,
          cycleDays,
          bufferDays,
          unit
        },
        restock: {
          qty: Math.max(1, Math.round(line.qty)),
          unit: line.measureUnit || unit,
          price: line.price,
          platform,
          purchaseProductName: productName,
          restockDate: orderDate,
          purchaseMeasureAmount: line.measureAmount,
          purchaseMeasureUnit: line.measureUnit,
          matchHint
        },
        addPurchaseOption: productName && productName !== itemName
          ? { productName, unit: line.measureUnit || unit }
          : undefined
      })
      if (uncertain) {
        uncertainRows.push(buildOrderRow(line, platform, orderDate, matchHint, candidates))
      }
      continue
    }

    // 5) 无消耗品信号 → 跳过
    skippedRows.push(buildOrderRow(line, platform, orderDate, "不像日常消耗品，先不管"))
  }

  return { drafts, skippedRows, uncertainRows }
}
