/**
 * 订单截图识别结果的纯逻辑：类型、行转换、确认转换。
 *
 * 把这些与 React 无关的部分单独放在 .ts 文件里，方便：
 *   1. 测试直接导入（不需要 JSX 转译）
 *   2. OrderImportReview.tsx 组件复用同一份逻辑
 *   3. 弹窗和对话共享同一套数据结构
 */
import { type ReplenishmentItem } from "./types"
import { fuzzyMatchItem, fuzzyMatchOption, type ExtractedOrder } from "./llm/orderImport"

/** 订单识别后落到 UI 的可编辑行结构；modal 和 chat 共用 */
export type OrderImportRow = {
  key: string
  productName: string
  brandName?: string
  coreName?: string
  qty: number | ""
  price: number | ""
  measureAmount: number | ""
  measureUnit: string
  review: string
  date: string
  platform: string
  genericName?: string
  /** itemId | "__create__" | "__skip__" */
  targetItem: string
  /** "" (不指定) | optionId | "__newopt__" (新建常购商品) */
  targetOption: string
  /** 目标分类；"__newcat__" 表示使用 customCategory */
  category: string
  customCategory: string
  /** 当天已有相同价格记录，疑似重复导入 */
  duplicate: boolean
}

/** 用户确认导入后转成的最终行结构，传给 buildAgentDraftsFromOrderRows */
export type OrderImportConfirmedRow = {
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
  targetItem: string
  targetOption: string
  /** 已解析的目标分类 */
  category: string
}

/** 同一天且价格一致的记录视为疑似重复导入 */
function hasSimilarRestockRecord(item: ReplenishmentItem, orderDate?: number, price?: number): boolean {
  if (!orderDate) return false
  return item.history.some((event) =>
    event.at && new Date(event.at).setHours(0, 0, 0, 0) === orderDate && (price === undefined || event.price === price)
  )
}

/** 该常购商品最近一次补货记录里的含量快照，用于预填（如皇家猫粮 L40 每袋 2kg） */
function latestMeasureForOption(item: ReplenishmentItem, optionId: string | undefined): { amount?: number; unit?: string } {
  if (!optionId) return {}
  for (let i = item.history.length - 1; i >= 0; i--) {
    const event = item.history[i]
    if (event.purchaseOptionId === optionId && event.purchaseMeasureAmount && event.purchaseMeasureUnit) {
      return { amount: event.purchaseMeasureAmount, unit: event.purchaseMeasureUnit }
    }
  }
  return {}
}

function toDateInputValue(timestamp: number): string {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function parseDateInputValue(value: string): number | undefined {
  const [year, month, day] = value.split("-").map(Number)
  if (!year || !month || !day) return undefined
  const date = new Date(year, month - 1, day)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * 把订单截图识别结果（ExtractedOrder）转换成可编辑的 OrderImportRow[]。
 * modal 和 chat 都用这个入口，避免两套转换逻辑。
 */
export function buildOrderImportRowsFromExtract(
  order: ExtractedOrder,
  items: ReplenishmentItem[],
  categories: string[],
  imageIndex = 0
): OrderImportRow[] {
  const defaultDate = toDateInputValue(order.orderDate ?? Date.now())
  const defaultCategory = categories.includes("其他") ? "其他" : (categories[0] || "其他")
  return order.lines.map((line, index) => {
    const matchedItem = (line.matchedItemName ? items.find((item) => item.name === line.matchedItemName) : undefined)
      || fuzzyMatchItem([line.coreName, line.productName, line.brandName, line.genericName], items)
    const matchedOption = matchedItem
      ? ((line.matchedOptionName ? (matchedItem.purchaseOptions || []).find((option) => option.productName === line.matchedOptionName) : undefined)
        || fuzzyMatchOption(matchedItem, [line.coreName, line.productName, line.brandName]))
      : undefined
    const historyMeasure = matchedItem && matchedOption ? latestMeasureForOption(matchedItem, matchedOption.id) : {}
    return {
      key: `img${imageIndex}_line${index}`,
      productName: line.productName,
      brandName: line.brandName,
      coreName: line.coreName,
      qty: line.qty,
      price: line.price ?? "",
      measureAmount: line.measureAmount ?? historyMeasure.amount ?? "",
      measureUnit: line.measureUnit ?? historyMeasure.unit ?? "",
      review: "",
      date: defaultDate,
      platform: order.platform || "",
      genericName: line.genericName,
      targetItem: matchedItem ? matchedItem.id : "__create__",
      targetOption: matchedItem
        ? (matchedOption ? matchedOption.id : ((line.coreName || line.brandName || line.productName) ? "__newopt__" : ""))
        : "",
      category: matchedItem?.category || defaultCategory,
      customCategory: "",
      duplicate: matchedItem ? hasSimilarRestockRecord(matchedItem, order.orderDate, line.price) : false
    }
  })
}

/**
 * 把用户编辑后的 OrderImportRow[] 转成 OrderImportConfirmedRow[]，
 * 再交给 buildAgentDraftsFromOrderRows 生成 AgentDraft[]。
 */
export function orderImportRowsToConfirmed(rows: OrderImportRow[]): OrderImportConfirmedRow[] {
  return rows
    .filter((row) => row.targetItem !== "__skip__" && row.qty !== "" && Number(row.qty) > 0)
    .map((row) => {
      const measureAmount = row.measureAmount === "" ? undefined : Math.max(0, Number(row.measureAmount)) || undefined
      return {
        productName: row.productName,
        brandName: row.brandName,
        coreName: row.coreName,
        qty: Math.max(1, Math.round(Number(row.qty))),
        price: row.price === "" ? undefined : Math.max(0, Number(row.price)),
        measureAmount,
        measureUnit: measureAmount && row.measureUnit ? row.measureUnit : undefined,
        review: row.review.trim() || undefined,
        restockDate: parseDateInputValue(row.date),
        platform: row.platform || undefined,
        genericName: row.genericName,
        targetItem: row.targetItem,
        targetOption: row.targetOption,
        category: row.category === "__newcat__" ? row.customCategory.trim() || "其他" : row.category
      }
    })
}

/** 单条行的匹配状态标签，modal 和 chat 共用 */
export function rowMatchStatus(row: OrderImportRow, items: ReplenishmentItem[]): string {
  const targetItemObj = items.find((item) => item.id === row.targetItem)
  const selectedOption = targetItemObj?.purchaseOptions?.find((option) => option.id === row.targetOption)
  if (row.targetItem === "__skip__") return "已跳过"
  if (row.targetItem === "__create__") return "准备新建"
  if (selectedOption) return "已匹配常购商品"
  if (row.targetOption === "__newopt__") return "将新建常购商品"
  return "需要确认"
}
