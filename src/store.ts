import { createInitialState } from "./domain"
import type {
  AppState,
  ChildSituation,
  CookingFrequency,
  HomeSize,
  HouseholdProfile,
  InventoryStatus,
  LaundryFrequency,
  ModelConfidence,
  PetSituation,
  PurchaseOption,
  Rating,
  ReplenishmentItem,
  ReminderSettings,
  ResidentCount,
  RestockEvent
} from "./types"

const STORAGE_KEY = "household_replenishment_desktop_v1"

export type PersistenceIssue = {
  kind: "read" | "write" | "sync"
  message: string
}

let pendingLoadIssue: PersistenceIssue | null = null
let lastLoadUsedFallback = false

export function takePendingLoadIssue(): PersistenceIssue | null {
  const issue = pendingLoadIssue
  pendingLoadIssue = null
  return issue
}

// addCardStateDemoItems removed: demo items are no longer auto-seeded into real state.
// CARD_STATES_DEMO_KEY and demoItem() removed along with it.

// ---------- 运行时校验工具 ----------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asFiniteNumber(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function normalizeMeasureUnit(value: unknown): string | undefined {
  const rawText = asString(value)
  if (rawText?.startsWith("custom:")) return rawText
  const text = rawText?.toLowerCase()
  if (!text) return undefined
  if (/(kg|公斤|千克)/i.test(text)) return "kg"
  if (/(^|\d|\s)(g|克)$/i.test(text) || text === "g" || text === "克") return "g"
  if (/(ml|毫升)/i.test(text)) return "ml"
  if (/(^|\d|\s)(l|升)$/i.test(text) || text === "l" || text === "升") return "L"
  if (/(个|只|件|包|袋|瓶|盒|抽)/.test(text)) return text
  return text
}

function parseMeasureSnapshot(value: unknown): { amount?: number; unit?: string } {
  const text = asString(value)
  if (!text) return {}
  const match = text.match(/(\d+(?:\.\d+)?)\s*(kg|公斤|千克|g|克|ml|毫升|l|L|升)/i)
  if (!match) return { unit: normalizeMeasureUnit(text) }
  const rawUnit = match[2]
  const unit = /(kg|公斤|千克)/i.test(rawUnit)
    ? "kg"
    : /(?:g|克)/i.test(rawUnit)
      ? "g"
      : /(?:ml|毫升)/i.test(rawUnit)
        ? "ml"
        : "L"
  return { amount: Number(match[1]), unit }
}

const DEFAULT_SETTINGS: ReminderSettings = {
  reminderIntervalHours: 1,
  quietStart: "22:00",
  quietEnd: "08:00",
  notificationEnabled: true
}

/** 合并解析后的 settings，缺失字段用默认值兜底；monthlyBudget 仅在正数时保留。 */
function migrateSettings(raw: unknown): ReminderSettings {
  if (!isObject(raw)) return { ...DEFAULT_SETTINGS }
  const intervalHoursRaw = asFiniteNumber(raw.reminderIntervalHours)
  const legacyIntervalMinutes = asFiniteNumber(raw.reminderIntervalMinutes)
  const intervalHours = intervalHoursRaw ?? (legacyIntervalMinutes !== undefined ? legacyIntervalMinutes / 60 : undefined)
  return {
    reminderIntervalHours: intervalHours === undefined
      ? DEFAULT_SETTINGS.reminderIntervalHours
      : Math.min(24, Math.max(1, Math.round(intervalHours))),
    quietStart: asString(raw.quietStart) ?? DEFAULT_SETTINGS.quietStart,
    quietEnd: asString(raw.quietEnd) ?? DEFAULT_SETTINGS.quietEnd,
    notificationEnabled: raw.notificationEnabled !== false,
    monthlyBudget: asFiniteNumber(raw.monthlyBudget) !== undefined && (asFiniteNumber(raw.monthlyBudget) as number) > 0
      ? asFiniteNumber(raw.monthlyBudget)
      : undefined,
    aiApiKey: asString(raw.aiApiKey),
    aiModel: asString(raw.aiModel),
    aiChatModel: asString(raw.aiChatModel),
    aiOrderModel: asString(raw.aiOrderModel),
    aiOrderMode: raw.aiOrderMode === "fast" ? "fast" : "accurate"
  }
}

function migratePurchaseOption(raw: unknown): PurchaseOption | null {
  if (!isObject(raw)) return null
  const id = asString(raw.id)
  const productName = asString(raw.productName)
  const unit = asString(raw.unit)
  // id / productName / unit 为商品卡片核心标识，缺失则丢弃该选项避免后续渲染崩溃
  if (!id || !productName || !unit) return null
  const price = asFiniteNumber(raw.price)
  const measureUnit = normalizeMeasureUnit(raw.measureUnit)
  const pricingMode = raw.pricingMode === "spec" || raw.pricingMode === "measure"
    ? raw.pricingMode
    : measureUnit ? "measure" : "spec"
  const measureBaseAmount = asFiniteNumber(raw.measureBaseAmount)
  return {
    id,
    productName,
    unit,
    pricingMode,
    measureUnit: pricingMode === "measure" ? measureUnit : undefined,
    measureBaseAmount: pricingMode === "measure" && measureBaseAmount !== undefined && measureBaseAmount > 0 ? measureBaseAmount : undefined,
    platform: asString(raw.platform),
    price: price !== undefined && price > 0 ? price : undefined,
    link: asString(raw.link),
    review: asString(raw.review),
    isDefault: raw.isDefault === true,
    image: asString(raw.image)
  }
}

function migrateHistoryEvent(raw: unknown): RestockEvent | null {
  if (!isObject(raw)) return null
  const id = asString(raw.id)
  const at = asFiniteNumber(raw.at)
  // at 必须是有限数字（统计/排序依赖时间戳），缺失或非法直接丢弃该条 event
  if (at === undefined) return null
  const ratingNum = asFiniteNumber(raw.rating)
  const rating: Rating | undefined = ratingNum === 1 || ratingNum === 2 || ratingNum === 3 ? ratingNum : undefined
  const qty = asFiniteNumber(raw.qty)
  const measureSnapshot = parseMeasureSnapshot(raw.purchaseMeasureUnit)
  const measureAmount = asFiniteNumber(raw.purchaseMeasureAmount) ?? measureSnapshot.amount
  const purchasePricingMode = raw.purchasePricingMode === "spec" || raw.purchasePricingMode === "measure"
    ? raw.purchasePricingMode
    : measureAmount !== undefined ? "measure" : "spec"
  const purchaseMeasureBaseAmount = asFiniteNumber(raw.purchaseMeasureBaseAmount)
  return {
    id: id ?? `event_${at}_${Math.random().toString(36).slice(2, 7)}`,
    at,
    intervalDays: asFiniteNumber(raw.intervalDays),
    price: asFiniteNumber(raw.price),
    qty: qty !== undefined && qty > 0 ? qty : undefined,
    platform: asString(raw.platform),
    purchaseOptionId: asString(raw.purchaseOptionId),
    purchaseProductName: asString(raw.purchaseProductName),
    purchaseUnit: asString(raw.purchaseUnit),
    purchasePricingMode,
    purchaseMeasureBaseAmount: purchaseMeasureBaseAmount !== undefined && purchaseMeasureBaseAmount > 0 ? purchaseMeasureBaseAmount : undefined,
    purchaseMeasureAmount: measureAmount !== undefined && measureAmount > 0 ? measureAmount : undefined,
    purchaseMeasureUnit: measureSnapshot.unit ?? normalizeMeasureUnit(raw.purchaseMeasureUnit),
    rating,
    review: asString(raw.review)
  }
}

function migrateHouseholdProfile(raw: unknown): HouseholdProfile | null {
  if (!isObject(raw)) return null
  const residentCount = [1, 2, 3, 4].includes(Number(raw.residentCount))
    ? Number(raw.residentCount) as ResidentCount
    : 2
  const children: ChildSituation = ["none", "infant", "schoolAge", "teen"].includes(String(raw.children))
    ? raw.children as ChildSituation
    : "none"
  const pets: PetSituation = ["none", "cat", "dog", "catAndDog", "other"].includes(String(raw.pets))
    ? raw.pets as PetSituation
    : "none"
  const cookingFrequency: CookingFrequency = ["rarely", "sometimes", "often", "daily"].includes(String(raw.cookingFrequency))
    ? raw.cookingFrequency as CookingFrequency
    : "sometimes"
  const laundryFrequency: LaundryFrequency = ["low", "medium", "daily"].includes(String(raw.laundryFrequency))
    ? raw.laundryFrequency as LaundryFrequency
    : "medium"
  const homeSize: HomeSize = ["oneBedroom", "twoBedroom", "threePlus"].includes(String(raw.homeSize))
    ? raw.homeSize as HomeSize
    : "twoBedroom"
  const now = Date.now()
  const bathroomCount = asFiniteNumber(raw.bathroomCount)
  return {
    residentCount,
    children,
    pets,
    cookingFrequency,
    laundryFrequency,
    homeSize,
    bathroomCount: bathroomCount !== undefined && bathroomCount > 0 ? Math.round(bathroomCount) : undefined,
    createdAt: asFiniteNumber(raw.createdAt) ?? now,
    updatedAt: asFiniteNumber(raw.updatedAt) ?? now
  }
}

/**
 * 防御脏数据：不假设任何字段一定存在且类型正确。
 * cycleDays 必须是 >=1 的有限数字，否则回退到 1；
 * bufferDays 必须 >=0 且 < cycleDays，否则按该约束钳制；
 * history / purchaseOptions 非数组则回退为空数组。
 */
function migrateItem(raw: unknown, fallbackIndex: number): ReplenishmentItem | null {
  if (!isObject(raw)) return null
  const id = asString(raw.id)
  const name = asString(raw.name)
  const category = asString(raw.category)
  // id / name / category 为物品核心标识，缺失则丢弃该物品避免污染列表
  if (!id || !name || !category) return null

  const cycleDaysRaw = asFiniteNumber(raw.cycleDays)
  const cycleDays = cycleDaysRaw !== undefined && cycleDaysRaw >= 1 ? Math.round(cycleDaysRaw) : 1

  // 优先使用 bufferDays；如果缺失但 reminderDaysAhead 存在，则迁移为 bufferDays
  const bufferDaysRaw = asFiniteNumber(raw.bufferDays)
  const reminderDaysAheadRaw = asFiniteNumber(raw.reminderDaysAhead)
  const bufferDays = bufferDaysRaw !== undefined && bufferDaysRaw >= 0
    ? Math.min(Math.max(0, cycleDays - 1), Math.round(bufferDaysRaw))
    : reminderDaysAheadRaw !== undefined && reminderDaysAheadRaw >= 0
      ? Math.min(Math.max(0, cycleDays - 1), Math.round(reminderDaysAheadRaw))
      : Math.max(0, cycleDays - 1)

  const historyEvents = asArray(raw.history)
    .map(migrateHistoryEvent)
    .filter((event): event is RestockEvent => event !== null)
  // 统一 history 顺序为旧到新（按 at 升序），与 domain.restockItem 的 append 约定及
  // 统计函数“末尾为最新”的假设保持一致；修复历史数据中被新流程 prepend 反序的记录
  historyEvents.sort((a, b) => a.at - b.at)

  const purchaseOptions = asArray(raw.purchaseOptions)
    .map(migratePurchaseOption)
    .filter((option): option is PurchaseOption => option !== null)
  const normalizedPurchaseOptions = purchaseOptions.map((option) => ({
    ...option,
    platform: undefined,
    price: undefined,
    review: undefined
  }))

  const now = Date.now()
  const createdAt = asFiniteNumber(raw.createdAt) ?? now
  const updatedAt = asFiniteNumber(raw.updatedAt) ?? createdAt
  const lastRestockedAt = asFiniteNumber(raw.lastRestockedAt) ?? createdAt
  const source = raw.source === "imported" ? "imported" : "manual"
  const confidence: ModelConfidence = raw.confidence === "low" || raw.confidence === "medium" || raw.confidence === "high"
    ? raw.confidence
    : "high"
  const inventoryStatus: InventoryStatus | undefined = ["justRestocked", "plenty", "half", "low", "unknown"].includes(String(raw.inventoryStatus))
    ? raw.inventoryStatus as InventoryStatus
    : undefined

  return {
    id,
    name,
    category,
    type: raw.type === "fixed" ? "fixed" : "learning",
    cycleDays,
    bufferDays,
    lastRestockedAt,
    inventoryDepletionAt: asFiniteNumber(raw.inventoryDepletionAt),
    anchorEstimated: raw.anchorEstimated !== false,
    purchaseOptions: normalizedPurchaseOptions,
    history: historyEvents,
    link: asString(raw.link),
    price: asFiniteNumber(raw.price),
    snoozeUntil: asFiniteNumber(raw.snoozeUntil),
    suggestedCycleDays: asFiniteNumber(raw.suggestedCycleDays),
    learningEnabled: raw.learningEnabled !== false,
    source,
    confidence,
    inventoryStatus,
    modelNote: asString(raw.modelNote),
    lastFeedbackAt: asFiniteNumber(raw.lastFeedbackAt),
    feedbackCount: Math.max(0, Math.round(asFiniteNumber(raw.feedbackCount) ?? 0)),
    unit: asString(raw.unit),
    platform: asString(raw.platform),
    defaultQty: (() => {
      const v = asFiniteNumber(raw.defaultQty)
      return v !== undefined && v > 0 ? v : undefined
    })(),
    createdAt,
    updatedAt
  }
}

/**
 * 最低限度运行时校验 + 容错：
 * - parsed 必须是对象；
 * - items 必须是数组（非法/缺失败回退空数组，而非崩溃）；
 * - settings 通过 migrateSettings 合并默认值；
 * - 单个 item 非法则丢弃（不影响其余）。
 */
function migrateState(raw: unknown): AppState {
  if (!isObject(raw)) {
    return createInitialState()
  }
  const categories = asArray(raw.categories)
    .map(asString)
    .filter((category): category is string => Boolean(category))
  const items = asArray(raw.items)
    .map(migrateItem)
    .filter((item): item is ReplenishmentItem => item !== null)

  return {
    version: 3,
    categories: categories.length ? categories : createInitialState().categories,
    items,
    settings: migrateSettings(raw.settings),
    householdProfile: migrateHouseholdProfile(raw.householdProfile),
    updatedAt: asFiniteNumber(raw.updatedAt) ?? Date.now(),
    // 403：保留 lastAgentMutation（可选字段，旧数据无此字段时为 undefined）
    lastAgentMutation: isObject(raw.lastAgentMutation) ? raw.lastAgentMutation as AppState["lastAgentMutation"] : undefined
  }
}

/**
 * 解析失败时把原始 raw 备份到带时间戳的 key，避免后续 persist 立刻覆盖用户数据。
 * 备份失败也只 warn，不阻断应用启动。
 */
function backupCorruptRaw(raw: string): boolean {
  try {
    const backupKey = `${STORAGE_KEY}_corrupt_backup_${Date.now()}`
    localStorage.setItem(backupKey, raw)
    return true
  } catch (backupError) {
    console.warn("Unable to back up corrupt state", backupError)
    return false
  }
}

export function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      lastLoadUsedFallback = false
      let saved: unknown
      try {
        saved = JSON.parse(raw)
      } catch (parseError) {
        // JSON.parse 失败：备份原始 raw，返回安全初始状态，不在本函数内覆盖原 key
        console.warn("Unable to parse local state JSON, backing up raw value", parseError)
        const backupCreated = backupCorruptRaw(raw)
        pendingLoadIssue = {
          kind: "read",
          message: backupCreated
            ? "本地数据读取失败，已保留损坏数据备份并启用安全状态。建议暂缓大量录入，并尽快备份当前数据。"
            : "本地数据读取失败，且无法创建损坏数据备份。请暂缓录入并尽快备份当前数据。"
        }
        lastLoadUsedFallback = true
        return createInitialState()
      }
      return migrateState(saved)
    }
  } catch (error) {
    // localStorage 读取本身失败（隐私模式 / 配额 / 被禁用等）
    console.warn("Unable to read local state", error)
    pendingLoadIssue = {
      kind: "read",
      message: "无法读取本地数据，当前显示的是安全初始状态。请重启应用后重试，并尽快备份当前数据。"
    }
  }
  lastLoadUsedFallback = true
  return createInitialState()
}

/**
 * 判断状态是否为“有效且非空”的初始状态：用于决定是否可以安全写回主进程。
 * 仅当本次 loadState 走了 fallback，才把无 items 状态视为空初始态，避免误伤用户主动清空后的状态。
 */
function isEmptyInitialCandidate(state: AppState, fromFallback = false): boolean {
  return fromFallback && state.items.length === 0
}

/**
 * 在应用启动时协调 localStorage 与主进程 JSON 两份数据：
 * - 两份数据都有效：选择 updatedAt 较新的版本；
 * - localStorage 异常/为空、主进程有效：恢复主进程数据；
 * - 主进程无数据或浏览器预览模式：继续使用 localStorage；
 * - 协调完成前禁止将空初始状态写回主进程（由调用方在 ready 前阻止 persist）。
 * 远端读取的数据仍须经过 migrateState 迁移与运行时校验。
 */
export async function reconcileState(localState: AppState): Promise<AppState> {
  if (!window.desktop?.loadState) {
    // 浏览器预览模式或 preload 未就绪：继续使用 localStorage
    return localState
  }
  let remoteRaw: unknown = null
  try {
    remoteRaw = await window.desktop.loadState()
  } catch (error) {
    console.warn("Unable to load state from main process", error)
    return localState
  }
  if (!remoteRaw) {
    // 主进程没有数据：继续使用 localStorage
    return localState
  }
  const remoteState = migrateState(remoteRaw)
  const localEmpty = isEmptyInitialCandidate(localState, lastLoadUsedFallback)
  const remoteEmpty = isEmptyInitialCandidate(remoteState, true)

  // localStorage 异常/为空、主进程有效：优先恢复主进程数据
  if (localEmpty && !remoteEmpty) {
    return remoteState
  }
  // 主进程为空但 localStorage 有效：继续使用 localStorage
  if (remoteEmpty && !localEmpty) {
    return localState
  }
  // 两份数据都有效：选择 updatedAt 较新的版本
  return remoteState.updatedAt > localState.updatedAt ? remoteState : localState
}

/**
 * 持久化容错：
 * - localStorage.setItem 失败（配额超限 / 被禁用）不再导致应用崩溃；
 * - Electron 主进程返回桌面备份文件是否写入成功；
 * - 返回结构化问题，由界面提供可见提示与重试。
 */
export async function persistState(state: AppState): Promise<PersistenceIssue | null> {
  let issue: PersistenceIssue | null = null
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch (storageError) {
    console.warn("Unable to persist state to localStorage", storageError)
    issue = {
      kind: "write",
      message: "数据保存失败。请重试；如果问题持续，建议复制当前数据备份后再关闭应用。"
    }
  }

  if (window.desktop) {
    try {
      const result = await window.desktop.syncState(state)
      if (!result.ok && !issue) {
        issue = {
          kind: "sync",
          message: result.error || "数据已保存在当前窗口，但桌面备份文件同步失败。请重试并建议复制当前数据备份。"
        }
      }
    } catch (syncError) {
      console.warn("Unable to sync state to desktop main process", syncError)
      if (!issue) {
        issue = {
          kind: "sync",
          message: "数据已保存在当前窗口，但桌面备份文件同步失败。请重试并建议复制当前数据备份。"
        }
      }
    }
  }

  return issue
}
