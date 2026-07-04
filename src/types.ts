export type ItemType = "learning" | "fixed"
export type ItemUrgency = "normal" | "warning" | "urgent"
export type Rating = 1 | 2 | 3
export type ItemSource = "manual" | "onboarding" | "imported"
export type ModelConfidence = "low" | "medium" | "high"
export type PricingMode = "spec" | "measure"
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
  productName: string  // 商品名称（如"维达卫生纸"）
  unit: string         // 规格（如"袋"、"瓶"、"包"）
  pricingMode?: PricingMode // 计价方式：按规格或按含量
  measureUnit?: string // 常用计量单位（如"kg"、"L"、"抽"）
  measureBaseAmount?: number // 计价口径数量（如 100 抽、100 克）
  /** @deprecated 每次补货会变化，保留用于旧数据迁移。 */
  platform?: string
  /** @deprecated 每次补货会变化，保留用于旧数据迁移。 */
  price?: number
  link?: string        // 商品链接（可选）
  /** @deprecated 每次补货会变化，保留用于旧数据迁移。 */
  review?: string
  isDefault?: boolean  // 是否为默认选项
  image?: string       // 图片（base64）
}

export type RestockEvent = {
  id: string
  at: number
  intervalDays?: number
  price?: number
  qty?: number
  platform?: string
  purchaseOptionId?: string      // 本次补货对应的商品卡片 id
  purchaseProductName?: string  // 本次补货对应的商品名称快照
  purchaseUnit?: string         // 本次补货对应的采购单位快照
  purchasePricingMode?: PricingMode // 本次补货对应的计价方式快照
  purchaseMeasureBaseAmount?: number // 本次补货对应的计价口径数量快照
  purchaseMeasureAmount?: number // 单件商品含量数值（如 500）
  purchaseMeasureUnit?: string  // 单件商品含量单位（如"ml"、"kg"）
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
  reminderIntervalHours: number
  quietStart: string
  quietEnd: string
  notificationEnabled: boolean
  monthlyBudget?: number
  /** 阿里云百炼（DashScope）API Key，用于订单截图识别；仅存本地。 */
  aiApiKey?: string
  /** @deprecated 旧版共用模型 ID；迁移时作为问答和订单识别的兜底。 */
  aiModel?: string
  /** 家庭问答使用的文本模型 ID。 */
  aiChatModel?: string
  /** 订单截图识别使用的视觉模型 ID。 */
  aiOrderModel?: string
  /** 订单识别默认模型策略：准确优先或速度优先。 */
  aiOrderMode?: "accurate" | "fast"
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

export const PLATFORM_OPTIONS = ["拼多多", "淘宝", "京东", "抖音", "1688", "线下", "美团外卖", "其他"]
export const UNIT_OPTIONS = ["件", "包", "卷", "瓶", "袋", "盒", "支", "kg", "L", "其他"]

// 删除分类时的安全选项：必须显式选择“迁移到其他分类”或“确认删除物品”，
// 非空分类不允许在两者都没有的情况下直接删除。
export interface DeleteCategoryOptions {
  moveToCategory?: string
  deleteItemsConfirmed?: boolean
}
