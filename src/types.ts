export type ItemType = "learning" | "fixed"
export type ItemUrgency = "normal" | "warning" | "urgent"
export type Rating = 1 | 2 | 3

export type RestockEvent = {
  id: string
  at: number
  intervalDays?: number
  price?: number
  qty?: number
  platform?: string
  rating?: Rating
  review?: string
}

export type ReplenishmentItem = {
  id: string
  name: string
  category: string
  type: ItemType
  cycleDays: number
  bufferDays: number
  lastRestockedAt: number
  anchorEstimated: boolean
  history: RestockEvent[]
  link?: string
  price?: number
  snoozeUntil?: number
  orderedAt?: number
  suggestedCycleDays?: number
  learningEnabled?: boolean
  unit?: string
  platform?: string
  defaultQty?: number
  createdAt: number
  updatedAt: number
}

export type ReminderSettings = {
  reminderIntervalMinutes: 30 | 60
  quietStart: string
  quietEnd: string
  snoozeUntilHour: number
  monthlyBudget?: number
}

export type AppState = {
  version: 2
  categories: string[]
  items: ReplenishmentItem[]
  settings: ReminderSettings
  updatedAt: number
}

export type ItemComputed = {
  status: ItemUrgency
  displayStatus: ItemUrgency
  statusLabel: "充足" | "快用完" | "急需补货"
  dueAt: number
  depletionAt: number
  daysUntilDue: number
  daysUntilDepletion: number
  isDue: boolean
  isSnoozed: boolean
  remainingText: string
  statusText: string
}

export type ItemDraft = {
  name: string
  category: string
  cycleDays: number
  bufferDays: number
  link: string
  remainingDays: string
  learningEnabled: boolean
  unit: string
  defaultQty: string
  platform: string
}

export type PriceAnchor = {
  lowestUnitPrice: number | null
  avgUnitPrice: number | null
  latestUnitPrice: number | null
  priceCount: number
}

export type ConsumptionInfo = {
  dailyUse: number | null
  dailyUseText: string
}

export type RecentRestock = {
  itemId: string
  itemName: string
  amount: string
  qty: string
  platform: string
  customPlatform: string
  linkDraft: string
  snapshot: ReplenishmentItem
}

export const PLATFORM_OPTIONS = ["拼多多", "淘宝", "京东", "抖音", "1688", "线下", "其他"]
export const UNIT_OPTIONS = ["件", "包", "卷", "瓶", "袋", "盒", "支", "kg", "L", "其他"]
