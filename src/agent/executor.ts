import { createItem, restockItem, updateItemFromDraft, updateRestockRecord } from "../domain"
import type { AppState, PurchaseOption, ReplenishmentItem } from "../types"
import { fuzzyMatchItem, type ExtractedOrder, type ExtractedOrderLine } from "../llm/orderImport"
import { CONSUMABLE_TEMPLATES } from "../model/consumableTemplates"
import { createItemDraftFromName, findItemMatch, type AgentDraft, type CreateItemDraft, type OrderRow, type RestockDraftDetails } from "./drafts"
import { buildPostCommitObservation } from "./observations"
import type { ChatDateContext } from "../llm/householdChat"
import type { AgentAction, AgentPlan } from "./actions"

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

/** 可变工作区：批量写入时多个草稿/动作共享同一份 categories/items。
 *  settings 仅 setMonthlyBudget 等设置类 action 使用；旧 commitAgentDraft 不初始化此字段。 */
export type AgentWorkState = {
  categories: string[]
  items: ReplenishmentItem[]
  settings?: AppState["settings"]
}

function norm(value: string): string {
  // 与 drafts.ts 的 norm 保持一致：去掉所有空白字符（不只是首尾 trim），
  // 这样 "pidan 豆腐猫砂" 和 "pidan豆腐猫砂" 能匹配到同一个常购商品。
  return value.replace(/\s+/g, "").toLocaleLowerCase("zh-CN")
}

function findItem(items: ReplenishmentItem[], itemId: string | undefined, itemName: string): ReplenishmentItem | undefined {
  if (itemId) {
    const byId = items.find((item) => item.id === itemId)
    if (byId) return byId
  }
  // 复用 drafts.ts 的匹配逻辑：exact > synonym > substring > template
  const state: AppState = { categories: [], items, settings: {} as AppState["settings"], householdProfile: null, updatedAt: 0, version: 3 }
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

// ---------- AgentPlan 执行入口（与 AgentDraft 并存的新协议） ----------

/** 在工作区里按 itemId 优先、itemName 兜底查找物品。用于 applyAgentAction。 */
function findWorkItem(work: AgentWorkState, itemId?: string, itemName?: string): ReplenishmentItem | undefined {
  if (itemId) {
    const byId = work.items.find((item) => item.id === itemId)
    if (byId) return byId
  }
  if (itemName) {
    // 复用 drafts.ts 的匹配逻辑（exact > synonym > substring）
    const stateLike: AppState = { categories: work.categories, items: work.items, settings: {} as AppState["settings"], householdProfile: null, updatedAt: 0, version: 3 }
    const match = findItemMatch(stateLike, itemName)
    if (match.item) return match.item
    // 兜底：裸 substring
    const lowered = norm(itemName)
    return work.items.find((item) => norm(item.name).includes(lowered) || lowered.includes(norm(item.name)))
  }
  return undefined
}

function linkItem(links: AgentMessageLink[], item: ReplenishmentItem) {
  links.push({ label: `查看「${item.name}」`, target: { kind: "item", itemId: item.id } })
}

function linkCategory(links: AgentMessageLink[], category: string) {
  links.push({ label: `查看「${category}」分类`, target: { kind: "category", category } })
}

/**
 * 把 timestamp（ms）与 dateHint 字符串匹配。
 * 支持的 hint：「最近一条」「昨天」「前天」「今天」。
 * 不支持的 hint 返回 false（executor 会跳过该记录）。
 */
function matchesDateHint(at: number, hint: string): boolean {
  const hintLower = hint.trim()
  if (hintLower === "最近一条") return true
  const date = new Date(at)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const target = new Date(date)
  target.setHours(0, 0, 0, 0)
  const diffDays = Math.round((today.getTime() - target.getTime()) / (24 * 60 * 60 * 1000))
  if (hintLower === "今天") return diffDays === 0
  if (hintLower === "昨天") return diffDays === 1
  if (hintLower === "前天") return diffDays === 2
  return false
}

function ensureWorkCategory(work: AgentWorkState, category: string) {
  if (!work.categories.some((c) => norm(c) === norm(category))) {
    work.categories = [...work.categories, category]
  }
}

/**
 * 把单个 AgentAction 应用到可变工作区。
 * 所有写入复用 domain 逻辑（createItem / restockItem / updateRestockRecord / updateItemFromDraft）。
 * 不修改 state，调用方负责拼装新 state。
 *
 * 返回 { summary, ok }：
 *   - ok=true：成功执行；或目标不存在这类「良性跳过」（不阻断后续 action）。
 *   - ok=false：依赖性失败（如目标分类不存在、重名冲突、写入门类未实现）。
 *     commitAgentPlan 遇到 ok=false 会停止后续 action，并回滚本次 plan 已写入的 work，
 *     避免 state 被部分错误污染。
 */
export function applyAgentAction(
  work: AgentWorkState,
  action: AgentAction,
  now: number,
  links: AgentMessageLink[]
): { summary: string; ok: boolean } {
  switch (action.type) {
    case "createCategory": {
      if (work.categories.some((c) => norm(c) === norm(action.name))) {
        linkCategory(links, action.name)
        return { summary: `没有创建新分类。「${action.name}」已存在。`, ok: true }
      }
      work.categories = [...work.categories, action.name]
      linkCategory(links, action.name)
      return { summary: `已新建分类：${action.name}。`, ok: true }
    }

    case "createItem": {
      const existing = findWorkItem(work, undefined, action.name)
      if (existing) {
        linkItem(links, existing)
        return { summary: `没有创建新消耗品。「${existing.name}」已存在。`, ok: true }
      }
      ensureWorkCategory(work, action.category)
      const draft: import("../types").ItemDraft = {
        name: action.name,
        category: action.category,
        cycleDays: action.cycleDays,
        bufferDays: action.bufferDays,
        link: "",
        remainingDays: "",
        learningEnabled: true,
        unit: action.unit,
        defaultQty: "",
        platform: "",
        purchaseOptions: action.addPurchaseOption
          ? [{
              id: crypto.randomUUID(),
              productName: action.addPurchaseOption.productName,
              unit: action.addPurchaseOption.unit || action.unit,
              pricingMode: "spec"
            }]
          : []
      }
      const item = createItem(draft, now)
      work.items = [...work.items, item]
      linkItem(links, item)
      return {
        summary: action.addPurchaseOption
          ? `已创建：消耗品「${item.name}」，并挂上常购商品「${action.addPurchaseOption.productName}」。`
          : `已创建：消耗品「${item.name}」。`,
        ok: true
      }
    }

    case "updateItem": {
      const target = findWorkItem(work, action.itemId, action.itemName)
      if (!target) {
        // 良性跳过：目标物品不存在，不影响后续 action
        return { summary: `没有修改。找不到消耗品「${action.itemName || action.itemId}」。`, ok: true }
      }
      const nextDraft: import("../types").ItemDraft = {
        name: action.name ?? target.name,
        category: action.category ?? target.category,
        cycleDays: action.cycleDays ?? target.cycleDays,
        bufferDays: action.bufferDays ?? target.bufferDays,
        link: target.link ?? "",
        remainingDays: "",
        learningEnabled: target.learningEnabled ?? true,
        unit: action.unit ?? target.unit ?? "件",
        defaultQty: target.defaultQty?.toString() ?? "",
        platform: target.platform ?? "",
        purchaseOptions: target.purchaseOptions
      }
      const updated = updateItemFromDraft(target, nextDraft)
      work.items = work.items.map((item) => item.id === target.id ? updated : item)
      linkItem(links, updated)
      return { summary: `已修改：消耗品「${updated.name}」。`, ok: true }
    }

    case "addPurchaseOption": {
      const target = findWorkItem(work, action.itemId, action.itemName)
      if (!target) {
        return { summary: `没有添加。找不到消耗品「${action.itemName}」。`, ok: true }
      }
      if (target.purchaseOptions.some((opt) => norm(opt.productName) === norm(action.productName))) {
        linkItem(links, target)
        return { summary: `没有创建新内容。「${target.name}」下已有常购商品「${action.productName}」。`, ok: true }
      }
      const option: PurchaseOption = {
        id: crypto.randomUUID(),
        productName: action.productName,
        unit: action.unit || target.unit || "件",
        pricingMode: "spec"
      }
      const updated = {
        ...target,
        purchaseOptions: [...target.purchaseOptions, option],
        updatedAt: now
      }
      work.items = work.items.map((item) => item.id === target.id ? updated : item)
      linkItem(links, updated)
      return { summary: `已添加：常购商品「${action.productName}」挂到「${target.name}」下。`, ok: true }
    }

    case "recordRestock": {
      const target = findWorkItem(work, action.itemId, action.itemName)
      if (!target) {
        return { summary: `没有记录补货。找不到消耗品「${action.itemName}」。`, ok: true }
      }
      const itemForRestock = action.cycleDaysPatch
        ? { ...target, cycleDays: action.cycleDaysPatch, updatedAt: now }
        : target
      const restocked = restockItem(
        itemForRestock, now, action.price, action.qty, action.platform, undefined,
        action.purchaseProductName || target.name, action.unit || target.unit,
        undefined, undefined, action.purchaseMeasureAmount, action.purchaseMeasureUnit,
        action.review, action.restockDate
      )
      work.items = work.items.map((item) => item.id === target.id ? restocked : item)
      linkItem(links, restocked)
      return { summary: `已记录：${restocked.name} 本次补货。`, ok: true }
    }

    case "updateRestockRecord": {
      const target = findWorkItem(work, action.itemId, undefined)
      if (!target) {
        return { summary: `没有修改。找不到物品 ${action.itemId}。`, ok: true }
      }
      const eventId = action.eventId || target.history[target.history.length - 1]?.id
      if (!eventId) {
        return { summary: `没有修改。${target.name} 还没有补货记录。`, ok: true }
      }
      const existing = target.history.find((e) => e.id === eventId)
      if (!existing) {
        return { summary: `没有修改。找不到补货记录 ${action.eventId}。`, ok: true }
      }
      const patch = {
        at: action.patch.at ?? existing.at,
        qty: action.patch.qty ?? existing.qty ?? 1,
        price: action.patch.price ?? existing.price ?? 0,
        platform: action.patch.platform ?? existing.platform,
        review: action.patch.review ?? existing.review,
        purchaseMeasureAmount: action.patch.purchaseMeasureAmount ?? existing.purchaseMeasureAmount,
        purchaseMeasureUnit: action.patch.purchaseMeasureUnit ?? existing.purchaseMeasureUnit
      }
      const updated = updateRestockRecord(target, eventId, patch, now)
      work.items = work.items.map((item) => item.id === target.id ? updated : item)
      linkItem(links, updated)
      return { summary: `已修改：${updated.name} 的补货记录。`, ok: true }
    }

    case "setMonthlyBudget": {
      work.settings = { ...(work.settings || ({} as AppState["settings"])), monthlyBudget: action.amount }
      return { summary: `已设置本月预算：¥${action.amount}。`, ok: true }
    }

    // ---------- 第二期：编辑类 action ----------

    case "renameCategory": {
      // 原分类不存在 → 依赖性失败（ok=false），阻断后续依赖此分类的 action
      if (!work.categories.some((c) => norm(c) === norm(action.oldName))) {
        return { summary: `没有重命名。分类「${action.oldName}」不存在。`, ok: false }
      }
      // 新名与已有分类同名（且不是 oldName 自己）→ 依赖性失败
      if (
        norm(action.newName) !== norm(action.oldName)
        && work.categories.some((c) => norm(c) === norm(action.newName))
      ) {
        return { summary: `没有重命名。已有分类「${action.newName}」，不能重名。`, ok: false }
      }
      // 复用 updateItemFromDraft 不可行（分类是 state 顶层字段），直接替换
      work.categories = work.categories.map((c) => norm(c) === norm(action.oldName) ? action.newName : c)
      // 同步迁移物品的 category 字段
      work.items = work.items.map((item) =>
        norm(item.category) === norm(action.oldName) ? { ...item, category: action.newName, updatedAt: now } : item
      )
      linkCategory(links, action.newName)
      return { summary: `已重命名分类：${action.oldName} → ${action.newName}。`, ok: true }
    }

    case "moveItem": {
      const target = findWorkItem(work, action.itemId, action.itemName)
      if (!target) {
        return { summary: `没有移动。找不到消耗品「${action.itemName || action.itemId}」。`, ok: true }
      }
      // 目标分类不存在 → 依赖性失败（本期不自动创建，避免静默写入不存在的分类）
      if (!work.categories.some((c) => norm(c) === norm(action.targetCategory))) {
        return { summary: `没有移动。分类「${action.targetCategory}」不存在，本期不会自动创建。`, ok: false }
      }
      // 同分类不算失败
      if (norm(target.category) === norm(action.targetCategory)) {
        linkItem(links, target)
        return { summary: `没有移动。「${target.name}」已经在分类「${action.targetCategory}」下。`, ok: true }
      }
      const updated = { ...target, category: action.targetCategory, updatedAt: now }
      work.items = work.items.map((item) => item.id === target.id ? updated : item)
      linkItem(links, updated)
      return { summary: `已移动：「${target.name}」 → 分类「${action.targetCategory}」。`, ok: true }
    }

    case "updateItemUnit": {
      const target = findWorkItem(work, action.itemId, action.itemName)
      if (!target) {
        return { summary: `没有修改。找不到消耗品「${action.itemName || action.itemId}」。`, ok: true }
      }
      const updated = { ...target, unit: action.unit, updatedAt: now }
      work.items = work.items.map((item) => item.id === target.id ? updated : item)
      linkItem(links, updated)
      return { summary: `已修改单位：「${target.name}」 → ${action.unit}。`, ok: true }
    }

    case "updateItemReminder": {
      const target = findWorkItem(work, action.itemId, action.itemName)
      if (!target) {
        return { summary: `没有修改。找不到消耗品「${action.itemName || action.itemId}」。`, ok: true }
      }
      const updated = { ...target, bufferDays: action.bufferDays, updatedAt: now }
      work.items = work.items.map((item) => item.id === target.id ? updated : item)
      linkItem(links, updated)
      return { summary: `已修改提醒：「${target.name}」提前 ${action.bufferDays} 天。`, ok: true }
    }

    case "updatePurchaseOption": {
      const target = findWorkItem(work, action.itemId, action.itemName)
      if (!target) {
        return { summary: `没有修改。找不到消耗品「${action.itemName || action.itemId}」。`, ok: true }
      }
      // 定位常购商品：optionId 优先，productName 兜底
      const prodName = action.productName
      const optIndex = action.optionId
        ? target.purchaseOptions.findIndex((o) => o.id === action.optionId)
        : target.purchaseOptions.findIndex((o) => norm(o.productName) === norm(prodName || ""))
      if (optIndex < 0) {
        return { summary: `没有修改。「${target.name}」下找不到常购商品「${action.productName || action.optionId}」。`, ok: true }
      }
      const existing = target.purchaseOptions[optIndex]
      const updatedOpt: PurchaseOption = {
        ...existing,
        productName: action.patch.productName ?? existing.productName,
        unit: action.patch.unit ?? existing.unit,
        platform: action.patch.platform ?? existing.platform,
        price: action.patch.price ?? existing.price,
        link: action.patch.link ?? existing.link,
        measureUnit: action.patch.measureUnit ?? existing.measureUnit,
        measureBaseAmount: action.patch.measureBaseAmount ?? existing.measureBaseAmount
      }
      const updated = {
        ...target,
        purchaseOptions: target.purchaseOptions.map((o, i) => i === optIndex ? updatedOpt : o),
        updatedAt: now
      }
      work.items = work.items.map((item) => item.id === target.id ? updated : item)
      linkItem(links, updated)
      return { summary: `已修改常购商品：「${target.name}」·「${existing.productName}」。`, ok: true }
    }

    case "setDefaultPurchaseOption": {
      const target = findWorkItem(work, action.itemId, action.itemName)
      if (!target) {
        return { summary: `没有设置。找不到消耗品「${action.itemName || action.itemId}」。`, ok: true }
      }
      const prodName = action.productName
      const optIndex = action.optionId
        ? target.purchaseOptions.findIndex((o) => o.id === action.optionId)
        : target.purchaseOptions.findIndex((o) => norm(o.productName) === norm(prodName || ""))
      if (optIndex < 0) {
        return { summary: `没有设置。「${target.name}」下找不到常购商品「${action.productName || action.optionId}」。`, ok: true }
      }
      // 同一物品同时最多一个默认：把其他默认取消，把目标设为默认
      const updatedOptions = target.purchaseOptions.map((o, i) => ({
        ...o,
        isDefault: i === optIndex ? true : false
      }))
      const updated = { ...target, purchaseOptions: updatedOptions, updatedAt: now }
      work.items = work.items.map((item) => item.id === target.id ? updated : item)
      linkItem(links, updated)
      return { summary: `已设默认常购商品：「${target.name}」·「${target.purchaseOptions[optIndex].productName}」。`, ok: true }
    }

    // ---------- 第三期：删除类 action（高风险，需二次确认） ----------

    case "deletePurchaseOption": {
      const target = findWorkItem(work, action.itemId, action.itemName)
      if (!target) {
        // 依赖性失败：物品不存在，不应继续后续依赖此物品的 action
        return { summary: `没有删除。找不到消耗品「${action.itemName}」。`, ok: false }
      }
      const prodName = action.productName
      const optIndex = action.optionId
        ? target.purchaseOptions.findIndex((o) => o.id === action.optionId)
        : target.purchaseOptions.findIndex((o) => norm(o.productName) === norm(prodName || ""))
      if (optIndex < 0) {
        return { summary: `没有删除。「${target.name}」下找不到常购商品「${action.productName || action.optionId}」。`, ok: false }
      }
      const removed = target.purchaseOptions[optIndex]
      // 直接移除；若是默认商品，移除后该物品不再有默认商品（不自动设新默认）
      const updatedOptions = target.purchaseOptions.filter((_, i) => i !== optIndex)
      const updated = { ...target, purchaseOptions: updatedOptions, updatedAt: now }
      work.items = work.items.map((item) => item.id === target.id ? updated : item)
      linkItem(links, updated)
      return { summary: `已删除常购商品：「${target.name}」·「${removed.productName}」。`, ok: true }
    }

    case "deleteRestockRecord": {
      const target = findWorkItem(work, action.itemId, action.itemName)
      if (!target) {
        return { summary: `没有删除。找不到消耗品「${action.itemName}」。`, ok: false }
      }
      if (target.history.length === 0) {
        return { summary: `没有删除。「${target.name}」还没有补货记录。`, ok: false }
      }
      // recordId 优先；无 recordId 时按 dateHint / price / 最近一条定位
      let eventIndex = -1
      if (action.recordId) {
        eventIndex = target.history.findIndex((e) => e.id === action.recordId)
      } else if (action.dateHint && action.dateHint !== "最近一条" && action.price === undefined) {
        // 仅按 dateHint 匹配（昨天/前天/今天）；多匹配时不删，返回依赖性失败
        const matches = target.history.filter((e) => matchesDateHint(e.at, action.dateHint!))
        if (matches.length === 0) {
          return { summary: `没有删除。「${target.name}」下没有匹配的补货记录。`, ok: false }
        }
        if (matches.length > 1) {
          return { summary: `没有删除。「${target.name}」下有 ${matches.length} 条匹配的补货记录，请明确指定。`, ok: false }
        }
        eventIndex = target.history.findIndex((e) => e.id === matches[0].id)
      } else if (action.price !== undefined) {
        // 按 price 匹配；多匹配时不删，返回依赖性失败
        const matches = target.history.filter((e) => (e.price ?? 0) === action.price)
        if (matches.length === 0) {
          return { summary: `没有删除。「${target.name}」下没有价格 ¥${action.price} 的补货记录。`, ok: false }
        }
        if (matches.length > 1) {
          return { summary: `没有删除。「${target.name}」下有 ${matches.length} 条价格 ¥${action.price} 的补货记录，请明确指定。`, ok: false }
        }
        eventIndex = target.history.findIndex((e) => e.id === matches[0].id)
      } else {
        // 默认删最近一条（dateHint 为空或 "最近一条" 都走这里）
        eventIndex = target.history.length - 1
      }
      if (eventIndex < 0) {
        return { summary: `没有删除。找不到补货记录 ${action.recordId}。`, ok: false }
      }
      const removed = target.history[eventIndex]
      const updatedHistory = target.history.filter((_, i) => i !== eventIndex)
      const updated = { ...target, history: updatedHistory, updatedAt: now }
      work.items = work.items.map((item) => item.id === target.id ? updated : item)
      linkItem(links, updated)
      return { summary: `已删除补货记录：「${target.name}」· ${new Date(removed.at).toLocaleDateString("zh-CN")} ¥${removed.price ?? 0}。`, ok: true }
    }

    case "deleteItem": {
      const target = findWorkItem(work, action.itemId, action.itemName)
      if (!target) {
        return { summary: `没有删除。找不到消耗品「${action.itemName}」。`, ok: false }
      }
      // 连带 history / purchaseOptions / 提醒状态全部移除（直接从 items 数组移除即可）
      work.items = work.items.filter((item) => item.id !== target.id)
      return { summary: `已删除消耗品：「${target.name}」（含 ${target.history.length} 条补货记录、${target.purchaseOptions.length} 个常购商品）。`, ok: true }
    }

    case "deleteCategory": {
      const exists = work.categories.some((c) => norm(c) === norm(action.categoryName))
      if (!exists) {
        return { summary: `没有删除。分类「${action.categoryName}」不存在。`, ok: false }
      }
      // 非空分类 → 依赖性失败，不删除
      const itemCount = work.items.filter((item) => norm(item.category) === norm(action.categoryName)).length
      if (itemCount > 0) {
        return { summary: `没有删除。分类「${action.categoryName}」下还有 ${itemCount} 个消耗品，请先移动或删除这些消耗品。`, ok: false }
      }
      work.categories = work.categories.filter((c) => norm(c) !== norm(action.categoryName))
      return { summary: `已删除分类：「${action.categoryName}」。`, ok: true }
    }

    default: {
      // 类型已约束，走到这里说明是未实现的 action
      return { summary: `未实现：${(action as { type: string }).type} 动作本期不支持。`, ok: false }
    }
  }
}

/**
 * 执行整个 AgentPlan。按顺序应用每个 action。
 *
 * 失败语义（第二期）：
 *   - ok=true（成功或良性跳过）：继续后续 action。
 *   - ok=false（依赖性失败）：立即停止后续 action，回滚本次 plan 已写入的 work，
 *     返回原 state + 错误摘要，避免 state 被部分错误污染。
 *
 * 写入后观察：取最重要的一条命中（与 commitAgentDraftBatch 行为对齐）。
 */
export function commitAgentPlan(
  state: AppState,
  plan: AgentPlan,
  now: number = Date.now(),
  dateContext?: ChatDateContext,
  seenObservationKeys?: Set<string>
): AgentCommitResult {
  const links: AgentMessageLink[] = []
  const work: AgentWorkState = {
    categories: [...state.categories],
    items: [...state.items],
    settings: { ...state.settings }
  }
  const summaries: string[] = []
  let failed = false
  for (const action of plan.actions) {
    const result = applyAgentAction(work, action, now, links)
    summaries.push(result.summary)
    if (!result.ok) {
      failed = true
      break
    }
  }

  // 依赖性失败：回滚本次 plan 已写入的 work，返回原 state + 错误摘要
  if (failed) {
    return {
      state,
      summary: summaries.join("\n"),
      links,
      observation: undefined
    }
  }

  const nextState: AppState = {
    ...state,
    categories: work.categories,
    items: work.items,
    settings: work.settings || state.settings,
    updatedAt: now
  }

  // 写入后观察：对涉及补货的 action 运行判定，取第一条命中
  let observation: string | undefined
  if (dateContext) {
    for (const action of plan.actions) {
      if (action.type !== "recordRestock" && action.type !== "createItem") continue
      const itemName = action.type === "recordRestock" ? action.itemName : action.name
      const targetItem = nextState.items.find((item) => norm(item.name) === norm(itemName))
      if (!targetItem) continue
      const obs = buildPostCommitObservation(targetItem, dateContext, seenObservationKeys)
      if (obs?.text) {
        observation = obs.text
        break
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
