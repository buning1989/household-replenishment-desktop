export type ItemType = "learning" | "fixed"
export type ItemUrgency = "normal" | "warning" | "urgent"
export type Rating = 1 | 2 | 3
export type ItemSource = "manual" | "onboarding" | "imported"
export type ModelConfidence = "low" | "medium" | "high"
export type InventoryStatus = "justRestocked" | "plenty" | "half" | "low" | "unknown"

export type ResidentCount = 1 | 2 | 3 | 4
export type ChildSituation = "none" | "infant" | "schoolAge" | "teen"
export type PetSituation = "none" | "cat" | "dog" | "catAndDog" | "other"
export type CookingFrequency = "rarely" | "sometimes" | "often" | "daily"
export type LaundryFrequency = "low" | "medium" | "daily"
export type HomeSize = "oneBedroom" | "twoBedroom" | "threePlus"

export type HouseholdProfile = {
  residentCount: ResidentCount
  children: ChildSituation
  pets: PetSituation
  cookingFrequency: CookingFrequency
  laundryFrequency: LaundryFrequency
  homeSize: HomeSize
  bathroomCount?: number
  createdAt: number
  updatedAt: number
}

export type OnboardingStep = 1 | 2 | 3 | 4 | 5
export type TemplateDecision = "manage" | "defer" | "notUsed"

export type OnboardingState = {
  completed: boolean
  rerun: boolean
  currentStep: OnboardingStep
  skippedProfile: boolean
  skipped: boolean
  managedTemplateIds: string[]
  notUsedTemplateIds: string[]
  deferredTemplateIds: string[]
  createdTemplateIds: string[]
  inventoryStatuses: Record<string, InventoryStatus>
  startedAt?: number
  completedAt?: number
}

export type TemplateActivation = "default" | "conditional" | "recommended"
export type TemplateTrigger =
  | { kind: "pet"; values: PetSituation[] }
  | { kind: "child"; values: ChildSituation[] }
  | { kind: "cooking"; values: CookingFrequency[] }

export type ConsumableTemplate = {
  id: string
  name: string
  category: string
  minCycleDays: number
  maxCycleDays: number
  defaultCycleDays: number
  bufferDays: number
  unit: string
  activation: TemplateActivation
  trigger?: TemplateTrigger
  influenceFactors: Array<"residents" | "children" | "pets" | "cooking" | "laundry" | "homeSize">
  learningEnabled: boolean
  defaultConfidence: ModelConfidence
}

export interface PurchaseOption {
  id: string
  productName: string  // 具体商品名称（如"维达卫生纸"）
  platform: string     // 购买平台
  unit: string         // 计量单位
  price?: number       // 采购价格
  link?: string        // 商品链接（可选）
  review?: string      // 对该具体商品的评价
  isDefault?: boolean  // 是否为默认选项
}

export type RestockEvent = {
  id: string
  at: number
  intervalDays?: number
  price?: number
  qty?: number
  platform?: string
  purchaseProductName?: string  // 本次补货对应的具体采购商品名称快照
  purchaseUnit?: string         // 本次补货对应的采购单位快照
  rating?: Rating
  review?: string
}

export type ReplenishmentItem = {
  id: string
  name: string              // 消耗品名称（如"卫生纸"）
  category: string
  type: ItemType
  cycleDays: number
  bufferDays: number
  lastRestockedAt: number
  /** 当前库存预计用完时间；补货后清除，恢复使用 cycleDays 预测。 */
  inventoryDepletionAt?: number
  anchorEstimated: boolean
  purchaseOptions: PurchaseOption[]  // 新增：采购选项列表
  history: RestockEvent[]            // 已有：补货记录
  link?: string
  price?: number
  snoozeUntil?: number
  suggestedCycleDays?: number
  learningEnabled?: boolean
  source?: ItemSource
  templateId?: string
  confidence?: ModelConfidence
  inventoryStatus?: InventoryStatus
  modelNote?: string
  lastFeedbackAt?: number
  feedbackCount?: number
  unit?: string
  platform?: string
  defaultQty?: number
  /** @deprecated 仅用于旧数据迁移，不参与业务计算。使用 bufferDays 代替。 */
  reminderDaysAhead?: number
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
  version: 3
  categories: string[]
  items: ReplenishmentItem[]
  settings: ReminderSettings
  householdProfile: HouseholdProfile | null
  onboarding: OnboardingState
  updatedAt: number
}

export type ItemComputed = {
  status: ItemUrgency
  displayStatus: ItemUrgency
  statusLabel: "充足" | "快用完" | "急需补货" | "初始估算中" | "可能快到补货周期了"
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
  price?: number
  usageIntervalDays?: number
  purchaseOptions?: PurchaseOption[]  // 新增：采购选项列表
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
