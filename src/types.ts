export type ItemType = "learning" | "fixed"
export type ItemUrgency = "normal" | "warning" | "urgent"

export type RestockEvent = {
  id: string
  at: number
  intervalDays?: number
  price?: number
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
  createdAt: number
  updatedAt: number
}

export type ReminderSettings = {
  reminderIntervalMinutes: 30 | 60
  idleThresholdMinutes: number
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
  displayStatus: ItemUrgency | "ordered"
  statusLabel: "充足" | "快用完" | "急需补货" | "在路上"
  dueAt: number
  depletionAt: number
  daysUntilDue: number
  daysUntilDepletion: number
  isDue: boolean
  isSnoozed: boolean
  isOrdered: boolean
  isArrivalOverdue: boolean
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
}
