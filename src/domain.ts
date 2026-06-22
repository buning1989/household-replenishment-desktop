import type { AppState, ConsumptionInfo, ItemComputed, ItemDraft, ItemUrgency, PriceAnchor, ReplenishmentItem } from "./types"
import { createInitialOnboardingState } from "./model/onboarding"

const DAY_MS = 24 * 60 * 60 * 1000

export const DEFAULT_CYCLES: Record<string, number> = {
  卫生纸: 30,
  抽纸: 24,
  牛奶: 7,
  鸡蛋: 10,
  洗衣液: 45,
  沐浴露: 60,
  猫砂: 14,
  猫粮: 30,
  大桶水: 10
}

export function id(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export function startOfDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export function addDays(timestamp: number, days: number): number {
  const date = new Date(timestamp)
  date.setDate(date.getDate() + days)
  return startOfDay(date.getTime())
}

function calendarDayNumber(timestamp: number): number {
  const date = new Date(timestamp)
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS)
}

export function differenceInDays(later: number, earlier: number): number {
  return calendarDayNumber(later) - calendarDayNumber(earlier)
}

export function computeItem(item: ReplenishmentItem, now = Date.now()): ItemComputed {
  const depletionAt = Number.isFinite(item.inventoryDepletionAt)
    ? startOfDay(item.inventoryDepletionAt!)
    : addDays(item.lastRestockedAt, item.cycleDays)
  const dueAt = addDays(depletionAt, -item.bufferDays)
  const daysUntilDue = differenceInDays(dueAt, now)
  const daysUntilDepletion = differenceInDays(depletionAt, now)
  const isSnoozed = Number(item.snoozeUntil || 0) > now
  const status: ItemUrgency = daysUntilDepletion <= 0
    ? "urgent"
    : daysUntilDue <= 0
      ? "warning"
      : "normal"
  const isLowConfidence = item.source === "onboarding" && item.confidence === "low"
  const statusLabel: ItemComputed["statusLabel"] = isLowConfidence
    ? status === "normal" ? "初始估算中" : "可能快到补货周期了"
    : status === "urgent" ? "急需补货" : status === "warning" ? "快用完" : "充足"
  const displayStatus = status
  const isDue = !isSnoozed && status !== "normal"

  let remainingText = isLowConfidence
    ? status === "normal" ? `约 ${Math.max(0, daysUntilDepletion)} 天后再看看` : "现在还够用吗？"
    : `还剩约 ${Math.max(0, daysUntilDepletion)} 天`
  let statusText: string = statusLabel
  if (!isLowConfidence && daysUntilDepletion < 0) remainingText = `预计已用完 ${Math.abs(daysUntilDepletion)} 天`
  if (!isLowConfidence && daysUntilDepletion === 0) remainingText = "预计今天用完"
  if (isSnoozed && status !== "normal") statusText = `${statusLabel} · 已推迟至 ${formatDateTime(item.snoozeUntil!)}`

  return {
    status,
    displayStatus,
    statusLabel,
    dueAt,
    depletionAt,
    daysUntilDue,
    daysUntilDepletion,
    isDue,
    isSnoozed,
    remainingText,
    statusText
  }
}

export function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(timestamp)
}

export function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(timestamp)
}

export function formatPrice(value: number): string {
  return value.toFixed(2)
}

export function calculateMonthlySpend(items: ReplenishmentItem[], now = Date.now()): number {
  const monthStart = new Date(now)
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)
  const nextMonth = new Date(monthStart)
  nextMonth.setMonth(nextMonth.getMonth() + 1)

  return items.reduce((total, item) => total + item.history.reduce((itemTotal, event) => {
    const price = Number(event.price)
    if (event.at < monthStart.getTime() || event.at >= nextMonth.getTime() || !Number.isFinite(price) || price < 0) {
      return itemTotal
    }
    return itemTotal + price
  }, 0), 0)
}

export function nextSnoozeTime(hour: number, now = Date.now()): number {
  const target = new Date(now)
  target.setDate(target.getDate() + 1)
  target.setHours(hour, 0, 0, 0)
  return target.getTime()
}

function weightedCycle(intervals: number[], currentCycle: number): number | undefined {
  if (!intervals.length) return undefined
  const lower = Math.max(1, currentCycle * 0.5)
  const upper = currentCycle * 1.5
  let weightedTotal = 0
  let weightTotal = 0
  intervals.slice(-5).forEach((interval, index, list) => {
    const weight = index + 2
    const clipped = Math.min(upper, Math.max(lower, interval))
    weightedTotal += clipped * weight
    weightTotal += weight
    if (index === list.length - 1) {
      weightedTotal += clipped
      weightTotal += 1
    }
  })
  return Math.max(1, Math.round(weightedTotal / weightTotal))
}


function safeRestockQty(value: number | undefined): number {
  return Number.isFinite(value) && value! >= 1 ? Math.round(value!) : 1
}

export function restockItem(
  item: ReplenishmentItem,
  now = Date.now(),
  price?: number,
  qty?: number,
  platform?: string,
  purchaseProductName?: string,
  purchaseUnit?: string
): ReplenishmentItem {
  const actualInterval = item.anchorEstimated
    ? undefined
    : Math.max(1, differenceInDays(now, item.lastRestockedAt))

  const safeQty = safeRestockQty(qty)

  const history = [
    ...item.history,
    {
      id: id("restock"),
      at: now,
      intervalDays: actualInterval,
      price,
      qty: safeQty,
      platform,
      purchaseProductName: purchaseProductName?.trim() || undefined,
      purchaseUnit: purchaseUnit?.trim() || undefined
    }
  ]

  const previousQty = safeRestockQty(item.history[item.history.length - 1]?.qty)
  const currentSingleItemCycle = Math.max(1, Math.round(item.cycleDays / previousQty))

  const singleItemIntervals = history.flatMap((event, index) => {
    if (!event.intervalDays) return []
    const batchQty = index > 0 ? safeRestockQty(history[index - 1]?.qty) : 1
    return [Math.max(1, event.intervalDays / batchQty)]
  })

  const singleItemCandidate = item.learningEnabled !== false
    ? weightedCycle(singleItemIntervals, currentSingleItemCycle)
    : undefined

  const newCycleDays = singleItemCandidate
    ? Math.max(1, Math.round(singleItemCandidate * safeQty))
    : item.cycleDays

  const confidence = item.source === "onboarding"
    ? history.length >= 2 ? "high" : "medium"
    : item.confidence

  return {
    ...item,
    cycleDays: newCycleDays,
    lastRestockedAt: startOfDay(now),
    inventoryDepletionAt: undefined,
    anchorEstimated: false,
    history,
    price: price ?? item.price,
    platform: platform || item.platform,
    snoozeUntil: undefined,
    suggestedCycleDays: undefined,
    confidence,
    inventoryStatus: "justRestocked",
    modelNote: item.source === "onboarding"
      ? history.length >= 2 ? "已根据多次真实补货记录学习周期" : "已记录首次真实补货，继续观察中"
      : item.modelNote,
    updatedAt: now
  }
}

export function calibrateRemainingDays(item: ReplenishmentItem, remainingDays: number, now = Date.now()): ReplenishmentItem {
  const normalizedRemainingDays = Math.max(0, Math.round(remainingDays))
  return {
    ...item,
    inventoryDepletionAt: addDays(now, normalizedRemainingDays),
    anchorEstimated: true,
    updatedAt: now
  }
}

export function createItem(draft: ItemDraft, now = Date.now()): ReplenishmentItem {
  const cycleDays = Math.max(1, Number(draft.cycleDays))
  const parsedInventoryDays = Number(draft.remainingDays)
  const inventoryDays = draft.remainingDays === "" || !Number.isFinite(parsedInventoryDays)
    ? undefined
    : Math.max(0, Math.round(parsedInventoryDays))
  return {
    id: id("item"),
    name: draft.name.trim(),
    category: draft.category.trim() || "其他用品",
    type: "learning",
    learningEnabled: draft.learningEnabled,
    cycleDays,
    bufferDays: Math.min(Math.max(0, cycleDays - 1), Math.max(0, Number(draft.bufferDays))),
    lastRestockedAt: startOfDay(now),
    inventoryDepletionAt: inventoryDays === undefined ? undefined : addDays(now, inventoryDays),
    anchorEstimated: true,
    purchaseOptions: draft.purchaseOptions || [],
    history: [],
    link: draft.link.trim() || undefined,
    price: draft.price !== undefined ? draft.price : undefined,
    unit: draft.unit.trim() || undefined,
    platform: draft.platform.trim() || undefined,
    defaultQty: draft.defaultQty ? Math.max(1, Number(draft.defaultQty)) : undefined,
    source: "manual",
    confidence: "medium",
    createdAt: now,
    updatedAt: now
  }
}

export function updateItemFromDraft(item: ReplenishmentItem, draft: ItemDraft): ReplenishmentItem {
  const cycleDays = Math.max(1, Number(draft.cycleDays))
  const now = Date.now()
  const parsedInventoryDays = Number(draft.remainingDays)
  const inventoryDays = draft.remainingDays === "" || !Number.isFinite(parsedInventoryDays)
    ? undefined
    : Math.max(0, Math.round(parsedInventoryDays))
  return {
    ...item,
    name: draft.name.trim(),
    category: draft.category.trim() || "其他用品",
    type: "learning",
    learningEnabled: draft.learningEnabled,
    cycleDays,
    bufferDays: Math.min(Math.max(0, cycleDays - 1), Math.max(0, Number(draft.bufferDays))),
    inventoryDepletionAt: inventoryDays === undefined ? item.inventoryDepletionAt : addDays(now, inventoryDays),
    link: draft.link.trim() || undefined,
    unit: draft.unit.trim() || undefined,
    platform: draft.platform.trim() || undefined,
    defaultQty: draft.defaultQty ? Math.max(1, Number(draft.defaultQty)) : undefined,
    purchaseOptions: (draft.purchaseOptions || item.purchaseOptions).map((option) => ({
      ...option,
      unit: draft.unit.trim() || option.unit || "件"
    })),
    suggestedCycleDays: undefined,
    updatedAt: now
  }
}

function daysAgo(days: number): number {
  return addDays(Date.now(), -days)
}

function generateDemoData(): ReplenishmentItem[] {
  const now = Date.now()
  const oneDay = 24 * 60 * 60 * 1000

  return [
    // ==================== 卫生间分类 (5个物品) ====================
    {
      id: 'item-wc-1',
      name: '卫生纸',
      category: '卫生间',
      type: 'learning',
      cycleDays: 30,
      bufferDays: 5,
      lastRestockedAt: now - oneDay, // 1天前补货，剩余约29天（充足）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-wc-1-1',
          productName: '维达超韧卫生纸3层120抽*24包',
          platform: '淘宝',
          unit: '提',
          price: 59.9,
          link: 'https://taobao.com/vinda'
        },
        {
          id: 'opt-wc-1-2',
          productName: '清风原木纯品卫生纸',
          platform: '京东',
          unit: '提',
          price: 65.0,
          link: 'https://jd.com/qingfeng'
        }
      ],
      history: [
        {
          id: 'rec-wc-1-1',
          at: now - oneDay,
          intervalDays: 30,
          price: 59.9,
          qty: 2,
          platform: '淘宝',
          review: '质量不错，性价比高，会继续购买'
        },
        {
          id: 'rec-wc-1-2',
          at: now - 30 * oneDay,
          intervalDays: 30,
          price: 58.0,
          qty: 2,
          platform: '淘宝'
        }
      ],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    {
      id: 'item-wc-2',
      name: '洗发水',
      category: '卫生间',
      type: 'learning',
      cycleDays: 45,
      bufferDays: 7,
      lastRestockedAt: now - 40 * oneDay, // 40天前补货，剩余约5天（即将用完）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-wc-2-1',
          productName: '海飞丝去屑洗发水750ml',
          platform: '京东',
          unit: '瓶',
          price: 89.0,
          link: 'https://jd.com/headshoulders'
        }
      ],
      history: [
        {
          id: 'rec-wc-2-1',
          at: now - 40 * oneDay,
          intervalDays: 45,
          price: 89.0,
          qty: 1,
          platform: '京东',
          review: '去屑效果很好'
        }
      ],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    {
      id: 'item-wc-3',
      name: '沐浴露',
      category: '卫生间',
      type: 'learning',
      cycleDays: 60,
      bufferDays: 10,
      lastRestockedAt: now - 58 * oneDay, // 58天前补货，剩余约2天（即将用完）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-wc-3-1',
          productName: '多芬滋养沐浴露1L',
          platform: '淘宝',
          unit: '瓶',
          price: 45.0,
          link: 'https://taobao.com/dove'
        },
        {
          id: 'opt-wc-3-2',
          productName: '舒肤佳沐浴露1L',
          platform: '拼多多',
          unit: '瓶',
          price: 39.9,
          link: 'https://pdd.com/safeguard'
        }
      ],
      history: [],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    {
      id: 'item-wc-4',
      name: '牙膏',
      category: '卫生间',
      type: 'learning',
      cycleDays: 30,
      bufferDays: 5,
      lastRestockedAt: now - 35 * oneDay, // 35天前补货，剩余约-5天（已用完）
      anchorEstimated: true,
      purchaseOptions: [],
      history: [
        {
          id: 'rec-wc-4-1',
          at: now - 35 * oneDay,
          intervalDays: 30,
          price: 25.0,
          qty: 2,
          platform: '超市'
        }
      ],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    {
      id: 'item-wc-5',
      name: '洗手液',
      category: '卫生间',
      type: 'learning',
      cycleDays: 30,
      bufferDays: 5,
      lastRestockedAt: now, // 今天刚补货，剩余约30天（充足）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-wc-5-1',
          productName: '威露士洗手液500ml',
          platform: '京东',
          unit: '瓶',
          price: 19.9,
          link: 'https://jd.com/walch'
        }
      ],
      history: [
        {
          id: 'rec-wc-5-1',
          at: now,
          intervalDays: 30,
          price: 19.9,
          qty: 2,
          platform: '京东',
          review: '杀菌效果好，味道清新'
        }
      ],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    // ==================== 厨房分类 (4个物品) ====================
    {
      id: 'item-kitchen-1',
      name: '食用油',
      category: '厨房',
      type: 'learning',
      cycleDays: 30,
      bufferDays: 5,
      lastRestockedAt: now - 30 * oneDay, // 30天前补货，剩余约0天（已用完）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-kitchen-1-1',
          productName: '金龙鱼调和油5L',
          platform: '京东',
          unit: '桶',
          price: 69.9,
          link: 'https://jd.com/jinlongyu'
        }
      ],
      history: [
        {
          id: 'rec-kitchen-1-1',
          at: now - 30 * oneDay,
          intervalDays: 30,
          price: 69.9,
          qty: 1,
          platform: '京东',
          review: '口感不错，性价比高'
        }
      ],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    {
      id: 'item-kitchen-2',
      name: '保鲜膜',
      category: '厨房',
      type: 'learning',
      cycleDays: 90,
      bufferDays: 15,
      lastRestockedAt: now - 88 * oneDay, // 88天前补货，剩余约2天（即将用完）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-kitchen-2-1',
          productName: '妙洁保鲜膜30cm*30m',
          platform: '淘宝',
          unit: '卷',
          price: 19.9,
          link: 'https://taobao.com/miaojie'
        }
      ],
      history: [],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    {
      id: 'item-kitchen-3',
      name: '洗洁精',
      category: '厨房',
      type: 'learning',
      cycleDays: 45,
      bufferDays: 7,
      lastRestockedAt: now - 20 * oneDay, // 20天前补货，剩余约25天（充足）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-kitchen-3-1',
          productName: '立白新金桔洗洁精1.5kg',
          platform: '拼多多',
          unit: '瓶',
          price: 12.9,
          link: 'https://pdd.com/libai'
        },
        {
          id: 'opt-kitchen-3-2',
          productName: '雕牌洗洁精1.5kg',
          platform: '淘宝',
          unit: '瓶',
          price: 15.0,
          link: 'https://taobao.com/diao'
        }
      ],
      history: [
        {
          id: 'rec-kitchen-3-1',
          at: now - 20 * oneDay,
          intervalDays: 45,
          price: 12.9,
          qty: 2,
          platform: '拼多多',
          review: '去油污能力强，味道清香'
        }
      ],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    {
      id: 'item-kitchen-4',
      name: '鸡蛋',
      category: '厨房',
      type: 'learning',
      cycleDays: 10,
      bufferDays: 2,
      lastRestockedAt: now - 8 * oneDay, // 8天前补货，剩余约2天（即将用完）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-kitchen-4-1',
          productName: '新鲜土鸡蛋30枚',
          platform: '淘宝',
          unit: '盒',
          price: 35.0,
          link: 'https://taobao.com/eggs'
        }
      ],
      history: [
        {
          id: 'rec-kitchen-4-1',
          at: now - 8 * oneDay,
          intervalDays: 10,
          price: 35.0,
          qty: 1,
          platform: '淘宝',
          review: '鸡蛋很新鲜'
        }
      ],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    // ==================== 洗衣清洁分类 (3个物品) ====================
    {
      id: 'item-laundry-1',
      name: '洗衣液',
      category: '洗衣清洁',
      type: 'learning',
      cycleDays: 30,
      bufferDays: 5,
      lastRestockedAt: now - 28 * oneDay, // 28天前补货，剩余约2天（即将用完）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-laundry-1-1',
          productName: '蓝月亮深层洁净洗衣液3kg',
          platform: '京东',
          unit: '瓶',
          price: 59.9,
          link: 'https://jd.com/bluemoon'
        }
      ],
      history: [
        {
          id: 'rec-laundry-1-1',
          at: now - 28 * oneDay,
          intervalDays: 30,
          price: 59.9,
          qty: 1,
          platform: '京东'
        }
      ],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    {
      id: 'item-laundry-2',
      name: '柔顺剂',
      category: '洗衣清洁',
      type: 'learning',
      cycleDays: 40,
      bufferDays: 5,
      lastRestockedAt: now - 38 * oneDay, // 38天前补货，剩余约2天（即将用完）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-laundry-2-1',
          productName: '金纺衣物柔顺剂2L',
          platform: '淘宝',
          unit: '瓶',
          price: 35.0,
          link: 'https://taobao.com/comfort'
        }
      ],
      history: [],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    {
      id: 'item-laundry-3',
      name: '洗衣凝珠',
      category: '洗衣清洁',
      type: 'learning',
      cycleDays: 32,
      bufferDays: 5,
      lastRestockedAt: now - 29 * oneDay, // 29天前补货，剩余约3天（即将用完）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-laundry-3-1',
          productName: '汰渍洗衣凝珠28颗',
          platform: '京东',
          unit: '盒',
          price: 49.9,
          link: 'https://jd.com/tide'
        }
      ],
      history: [
        {
          id: 'rec-laundry-3-1',
          at: now - 29 * oneDay,
          intervalDays: 32,
          price: 49.9,
          qty: 1,
          platform: '京东',
          review: '使用方便，清洁力强'
        }
      ],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    // ==================== 宠物用品分类 (3个物品) ====================
    {
      id: 'item-pet-1',
      name: '猫粮',
      category: '宠物用品',
      type: 'learning',
      cycleDays: 15,
      bufferDays: 3,
      lastRestockedAt: now - 13 * oneDay, // 13天前补货，剩余约2天（即将用完）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-pet-1-1',
          productName: '皇家成猫粮2kg',
          platform: '京东',
          unit: '袋',
          price: 128.0,
          link: 'https://jd.com/royal-canin'
        },
        {
          id: 'opt-pet-1-2',
          productName: '渴望成猫粮1.8kg',
          platform: '淘宝',
          unit: '袋',
          price: 198.0,
          link: 'https://taobao.com/orijen'
        }
      ],
      history: [
        {
          id: 'rec-pet-1-1',
          at: now - 13 * oneDay,
          intervalDays: 15,
          price: 128.0,
          qty: 1,
          platform: '京东',
          review: '猫咪很喜欢吃'
        }
      ],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    {
      id: 'item-pet-2',
      name: '猫砂',
      category: '宠物用品',
      type: 'learning',
      cycleDays: 14,
      bufferDays: 3,
      lastRestockedAt: now - 12 * oneDay, // 12天前补货，剩余约2天（即将用完）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-pet-2-1',
          productName: 'pidan混合猫砂6L',
          platform: '淘宝',
          unit: '袋',
          price: 29.9,
          link: 'https://taobao.com/pidan'
        }
      ],
      history: [],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    {
      id: 'item-pet-3',
      name: '猫罐头',
      category: '宠物用品',
      type: 'learning',
      cycleDays: 7,
      bufferDays: 2,
      lastRestockedAt: now - 6 * oneDay, // 6天前补货，剩余约1天（即将用完）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-pet-3-1',
          productName: '希尔斯猫罐头85g*12罐',
          platform: '天猫',
          unit: '箱',
          price: 96.0,
          link: 'https://tmall.com/hills'
        }
      ],
      history: [
        {
          id: 'rec-pet-3-1',
          at: now - 6 * oneDay,
          intervalDays: 7,
          price: 96.0,
          qty: 1,
          platform: '天猫',
          review: '猫咪很爱吃'
        }
      ],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    // ==================== 日常护理分类 (3个物品) ====================
    {
      id: 'item-care-1',
      name: '纸巾',
      category: '日常护理',
      type: 'learning',
      cycleDays: 20,
      bufferDays: 3,
      lastRestockedAt: now - 18 * oneDay, // 18天前补货，剩余约2天（即将用完）
      anchorEstimated: true,
      purchaseOptions: [],
      history: [
        {
          id: 'rec-care-1-1',
          at: now - 18 * oneDay,
          intervalDays: 20,
          price: 25.0,
          qty: 1,
          platform: '超市'
        }
      ],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    {
      id: 'item-care-2',
      name: '卸妆棉',
      category: '日常护理',
      type: 'learning',
      cycleDays: 28,
      bufferDays: 4,
      lastRestockedAt: now - 25 * oneDay, // 25天前补货，剩余约3天（即将用完）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-care-2-1',
          productName: '尤妮佳化妆棉180片',
          platform: '淘宝',
          unit: '包',
          price: 15.9,
          link: 'https://taobao.com/unicharm'
        }
      ],
      history: [
        {
          id: 'rec-care-2-1',
          at: now - 25 * oneDay,
          intervalDays: 28,
          price: 15.9,
          qty: 2,
          platform: '淘宝',
          review: '柔软不掉絮'
        }
      ],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    {
      id: 'item-care-3',
      name: '牙刷',
      category: '日常护理',
      type: 'fixed',
      cycleDays: 90,
      bufferDays: 7,
      lastRestockedAt: now - 85 * oneDay, // 85天前补货，剩余约5天（即将用完）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-care-3-1',
          productName: '飞利浦声波牙刷头',
          platform: '京东',
          unit: '盒',
          price: 89.0,
          link: 'https://jd.com/philips'
        }
      ],
      history: [
        {
          id: 'rec-care-3-1',
          at: now - 85 * oneDay,
          intervalDays: 90,
          price: 89.0,
          qty: 1,
          platform: '京东'
        }
      ],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    // ==================== 饮品零食分类 (2个物品) ====================
    {
      id: 'item-snack-1',
      name: '咖啡',
      category: '饮品零食',
      type: 'learning',
      cycleDays: 30,
      bufferDays: 5,
      lastRestockedAt: now - 25 * oneDay, // 25天前补货，剩余约5天（即将用完）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-snack-1-1',
          productName: '雀巢速溶咖啡100条',
          platform: '京东',
          unit: '盒',
          price: 89.0,
          link: 'https://jd.com/nescafe'
        }
      ],
      history: [],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    {
      id: 'item-snack-2',
      name: '牛奶',
      category: '饮品零食',
      type: 'learning',
      cycleDays: 7,
      bufferDays: 2,
      lastRestockedAt: now - 3 * oneDay, // 3天前补货，剩余约4天（充足）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-snack-2-1',
          productName: '蒙牛纯牛奶250ml*24盒',
          platform: '京东',
          unit: '箱',
          price: 59.9,
          link: 'https://jd.com/mengniu'
        },
        {
          id: 'opt-snack-2-2',
          productName: '伊利纯牛奶250ml*24盒',
          platform: '天猫',
          unit: '箱',
          price: 62.0,
          link: 'https://tmall.com/yili'
        }
      ],
      history: [
        {
          id: 'rec-snack-2-1',
          at: now - 3 * oneDay,
          intervalDays: 7,
          price: 59.9,
          qty: 1,
          platform: '京东',
          review: '新鲜好喝'
        }
      ],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    // ==================== 其他用品分类 (2个物品) ====================
    {
      id: 'item-other-1',
      name: '垃圾袋',
      category: '其他用品',
      type: 'learning',
      cycleDays: 60,
      bufferDays: 10,
      lastRestockedAt: now - 50 * oneDay, // 50天前补货，剩余约10天（充足）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-other-1-1',
          productName: '美丽雅加厚垃圾袋50只',
          platform: '拼多多',
          unit: '卷',
          price: 9.9,
          link: 'https://pdd.com/meiliya'
        }
      ],
      history: [
        {
          id: 'rec-other-1-1',
          at: now - 50 * oneDay,
          intervalDays: 60,
          price: 9.9,
          qty: 3,
          platform: '拼多多',
          review: '很厚实，不容易破'
        }
      ],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    {
      id: 'item-other-2',
      name: '扫地机滤芯',
      category: '其他用品',
      type: 'fixed',
      cycleDays: 90,
      bufferDays: 7,
      lastRestockedAt: now - 20 * oneDay, // 20天前补货，剩余约70天（充足）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-other-2-1',
          productName: '石头扫地机滤芯',
          platform: '淘宝',
          unit: '个',
          price: 45.0,
          link: 'https://taobao.com/roborock'
        }
      ],
      history: [
        {
          id: 'rec-other-2-1',
          at: now - 20 * oneDay,
          intervalDays: 90,
          price: 45.0,
          qty: 1,
          platform: '淘宝'
        }
      ],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    // ==================== 新增即将用完的物品 ====================
    
    // 卫生间 - 护发素
    {
      id: 'item-wc-6',
      name: '护发素',
      category: '卫生间',
      type: 'learning',
      cycleDays: 45,
      bufferDays: 7,
      lastRestockedAt: now - 42 * oneDay, // 42天前补货，剩余约3天（即将用完）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-wc-6-1',
          productName: '潘婷乳液修复护发素700ml',
          platform: '京东',
          unit: '瓶',
          price: 79.0,
          link: 'https://jd.com/pantene'
        },
        {
          id: 'opt-wc-6-2',
          productName: '施华蔻修护护发素500ml',
          platform: '淘宝',
          unit: '瓶',
          price: 89.0,
          link: 'https://taobao.com/schwarzkopf'
        }
      ],
      history: [
        {
          id: 'rec-wc-6-1',
          at: now - 42 * oneDay,
          intervalDays: 45,
          price: 79.0,
          qty: 1,
          platform: '京东',
          review: '修复效果很好，头发柔顺'
        }
      ],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    // 卫生间 - 漱口水
    {
      id: 'item-wc-7',
      name: '漱口水',
      category: '卫生间',
      type: 'learning',
      cycleDays: 60,
      bufferDays: 10,
      lastRestockedAt: now - 55 * oneDay, // 55天前补货，剩余约5天（即将用完）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-wc-7-1',
          productName: '李施德林冰蓝漱口水500ml',
          platform: '京东',
          unit: '瓶',
          price: 39.9,
          link: 'https://jd.com/listerine'
        }
      ],
      history: [
        {
          id: 'rec-wc-7-1',
          at: now - 55 * oneDay,
          intervalDays: 60,
          price: 39.9,
          qty: 2,
          platform: '京东',
          review: '清新口气效果好'
        }
      ],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    // 厨房 - 酱油
    {
      id: 'item-kitchen-5',
      name: '酱油',
      category: '厨房',
      type: 'learning',
      cycleDays: 45,
      bufferDays: 7,
      lastRestockedAt: now - 40 * oneDay, // 40天前补货，剩余约5天（即将用完）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-kitchen-5-1',
          productName: '海天金标生抽500ml',
          platform: '拼多多',
          unit: '瓶',
          price: 12.9,
          link: 'https://pdd.com/haitian'
        },
        {
          id: 'opt-kitchen-5-2',
          productName: '李锦记薄盐生抽500ml',
          platform: '淘宝',
          unit: '瓶',
          price: 15.0,
          link: 'https://taobao.com/leekumkee'
        }
      ],
      history: [
        {
          id: 'rec-kitchen-5-1',
          at: now - 40 * oneDay,
          intervalDays: 45,
          price: 12.9,
          qty: 2,
          platform: '拼多多',
          review: '味道正宗，性价比高'
        }
      ],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    // 厨房 - 保鲜袋
    {
      id: 'item-kitchen-6',
      name: '保鲜袋',
      category: '厨房',
      type: 'learning',
      cycleDays: 90,
      bufferDays: 15,
      lastRestockedAt: now - 80 * oneDay, // 80天前补货，剩余约10天（即将用完）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-kitchen-6-1',
          productName: '妙洁加厚保鲜袋中号100只',
          platform: '京东',
          unit: '包',
          price: 19.9,
          link: 'https://jd.com/miaojie-bag'
        }
      ],
      history: [
        {
          id: 'rec-kitchen-6-1',
          at: now - 80 * oneDay,
          intervalDays: 90,
          price: 19.9,
          qty: 2,
          platform: '京东',
          review: '厚实耐用，密封性好'
        }
      ],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    // 洗衣清洁 - 消毒液
    {
      id: 'item-laundry-4',
      name: '消毒液',
      category: '洗衣清洁',
      type: 'learning',
      cycleDays: 60,
      bufferDays: 10,
      lastRestockedAt: now - 55 * oneDay, // 55天前补货，剩余约5天（即将用完）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-laundry-4-1',
          productName: '滴露衣物消毒液750ml',
          platform: '京东',
          unit: '瓶',
          price: 49.9,
          link: 'https://jd.com/dettol'
        },
        {
          id: 'opt-laundry-4-2',
          productName: '威露士衣物消毒液1L',
          platform: '淘宝',
          unit: '瓶',
          price: 39.9,
          link: 'https://taobao.com/walch-disinfectant'
        }
      ],
      history: [
        {
          id: 'rec-laundry-4-1',
          at: now - 55 * oneDay,
          intervalDays: 60,
          price: 49.9,
          qty: 1,
          platform: '京东',
          review: '杀菌效果好，安心使用'
        }
      ],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    // 宠物用品 - 狗粮
    {
      id: 'item-pet-4',
      name: '狗粮',
      category: '宠物用品',
      type: 'learning',
      cycleDays: 20,
      bufferDays: 3,
      lastRestockedAt: now - 18 * oneDay, // 18天前补货，剩余约2天（即将用完）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-pet-4-1',
          productName: '皇家小型成犬粮2kg',
          platform: '京东',
          unit: '袋',
          price: 138.0,
          link: 'https://jd.com/royal-canin-dog'
        },
        {
          id: 'opt-pet-4-2',
          productName: '渴望成犬粮2kg',
          platform: '淘宝',
          unit: '袋',
          price: 218.0,
          link: 'https://taobao.com/orijen-dog'
        }
      ],
      history: [
        {
          id: 'rec-pet-4-1',
          at: now - 18 * oneDay,
          intervalDays: 20,
          price: 138.0,
          qty: 1,
          platform: '京东',
          review: '狗狗很喜欢吃，营养丰富'
        }
      ],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    // 日常护理 - 护手霜
    {
      id: 'item-care-4',
      name: '护手霜',
      category: '日常护理',
      type: 'learning',
      cycleDays: 90,
      bufferDays: 15,
      lastRestockedAt: now - 80 * oneDay, // 80天前补货，剩余约10天（即将用完）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-care-4-1',
          productName: '欧舒丹乳木果护手霜30ml*3',
          platform: '天猫',
          unit: '套',
          price: 280.0,
          link: 'https://tmall.com/loccitane'
        },
        {
          id: 'opt-care-4-2',
          productName: '凡士林经典护手霜100ml',
          platform: '京东',
          unit: '支',
          price: 29.9,
          link: 'https://jd.com/vaseline'
        }
      ],
      history: [
        {
          id: 'rec-care-4-1',
          at: now - 80 * oneDay,
          intervalDays: 90,
          price: 29.9,
          qty: 2,
          platform: '京东',
          review: '滋润不油腻，吸收快'
        }
      ],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    // 饮品零食 - 茶包
    {
      id: 'item-snack-3',
      name: '茶包',
      category: '饮品零食',
      type: 'learning',
      cycleDays: 30,
      bufferDays: 5,
      lastRestockedAt: now - 27 * oneDay, // 27天前补货，剩余约3天（即将用完）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-snack-3-1',
          productName: '立顿红茶包100包',
          platform: '京东',
          unit: '盒',
          price: 39.9,
          link: 'https://jd.com/lipton'
        },
        {
          id: 'opt-snack-3-2',
          productName: '川宁伯爵茶包50包',
          platform: '天猫',
          unit: '盒',
          price: 59.0,
          link: 'https://tmall.com/twinings'
        }
      ],
      history: [
        {
          id: 'rec-snack-3-1',
          at: now - 27 * oneDay,
          intervalDays: 30,
          price: 39.9,
          qty: 1,
          platform: '京东',
          review: '口感醇厚，提神醒脑'
        }
      ],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    },
    
    // 其他用品 - 电池
    {
      id: 'item-other-3',
      name: '电池',
      category: '其他用品',
      type: 'fixed',
      cycleDays: 180,
      bufferDays: 30,
      lastRestockedAt: now - 160 * oneDay, // 160天前补货，剩余约20天（即将用完）
      anchorEstimated: true,
      purchaseOptions: [
        {
          id: 'opt-other-3-1',
          productName: '南孚5号碱性电池24粒',
          platform: '京东',
          unit: '盒',
          price: 49.9,
          link: 'https://jd.com/nanfu'
        }
      ],
      history: [
        {
          id: 'rec-other-3-1',
          at: now - 160 * oneDay,
          intervalDays: 180,
          price: 49.9,
          qty: 1,
          platform: '京东',
          review: '耐用持久，性价比高'
        }
      ],
      createdAt: now,
      updatedAt: now,
      learningEnabled: true
    }
  ]
}

export function createInitialState(): AppState {
  const now = Date.now()

  return {
    version: 3,
    categories: ["卫生间", "厨房", "洗衣清洁", "宠物用品", "日常护理", "饮品零食", "其他用品"],
    items: [],
    settings: {
      reminderIntervalMinutes: 60,
      quietStart: "22:00",
      quietEnd: "08:00",
      snoozeUntilHour: 8
    },
    householdProfile: null,
    onboarding: createInitialOnboardingState(now),
    updatedAt: now
  }
}

export function calculatePriceAnchor(history: ReplenishmentItem["history"]): PriceAnchor {
  const priced = history.filter((e) =>
    Number.isFinite(e.price) && e.price! > 0 &&
    Number.isFinite(e.qty) && e.qty! > 0
  )
  if (!priced.length) {
    return { lowestUnitPrice: null, avgUnitPrice: null, latestUnitPrice: null, priceCount: 0 }
  }

  const unitPrices = priced.map((e) => e.price! / e.qty!)
  return {
    lowestUnitPrice: Math.min(...unitPrices),
    avgUnitPrice: unitPrices.reduce((a, b) => a + b, 0) / unitPrices.length,
    latestUnitPrice: unitPrices[unitPrices.length - 1],
    priceCount: priced.length
  }
}

export function calculateConsumption(item: ReplenishmentItem): ConsumptionInfo {
  const qtyEvents = item.history.filter((e) => Number.isFinite(e.qty) && e.qty! > 0)
  if (!qtyEvents.length || !item.cycleDays) {
    return { dailyUse: null, dailyUseText: "暂无数据" }
  }

  const latest = qtyEvents[qtyEvents.length - 1]
  const dailyUse = latest.qty! / item.cycleDays

  const unit = item.unit || "件"
  const formatted = dailyUse < 0.1
    ? dailyUse.toFixed(2)
    : dailyUse < 1
      ? dailyUse.toFixed(1)
      : String(Math.round(dailyUse * 10) / 10)

  return {
    dailyUse,
    dailyUseText: `约 ${formatted} ${unit}/天`
  }
}

export function estimateRemainingQty(item: ReplenishmentItem, now = Date.now()): string | null {
  const consumption = calculateConsumption(item)
  if (!consumption.dailyUse) return null

  const computed = computeItem(item, now)
  const remainingDays = Math.max(0, computed.daysUntilDepletion)
  const remainingQty = remainingDays * consumption.dailyUse
  const unit = item.unit || "件"

  return `约 ${Math.round(remainingQty)} ${unit}`
}

export function getLatestRating(item: ReplenishmentItem): number | null {
  const rated = item.history.filter((e) => e.rating !== undefined).reverse()
  if (!rated.length) return null
  return rated[0].rating ?? null
}

export function formatUnitPrice(price: number, unit: string): string {
  return `¥${formatPrice(price)}/${unit}`
}
