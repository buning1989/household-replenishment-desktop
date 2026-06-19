import { createInitialState } from "./domain"
import type { AppState, PurchaseOption, Rating, ReplenishmentItem, ReminderSettings, RestockEvent } from "./types"

const STORAGE_KEY = "household_replenishment_desktop_v1"

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

const DEFAULT_SETTINGS: ReminderSettings = {
  reminderIntervalMinutes: 60,
  quietStart: "22:00",
  quietEnd: "08:00",
  snoozeUntilHour: 8
}

/** 合并解析后的 settings，缺失字段用默认值兜底；monthlyBudget 仅在正数时保留。 */
function migrateSettings(raw: unknown): ReminderSettings {
  if (!isObject(raw)) return { ...DEFAULT_SETTINGS }
  const interval = raw.reminderIntervalMinutes
  const snoozeRaw = asFiniteNumber(raw.snoozeUntilHour)
  // snoozeUntilHour 是小时（0-23）：非有限数字回退默认值，否则钳制到 [0, 23]
  const snoozeUntilHour = snoozeRaw === undefined
    ? DEFAULT_SETTINGS.snoozeUntilHour
    : Math.min(23, Math.max(0, Math.round(snoozeRaw)))
  return {
    reminderIntervalMinutes: interval === 30 || interval === 60 ? interval : DEFAULT_SETTINGS.reminderIntervalMinutes,
    quietStart: asString(raw.quietStart) ?? DEFAULT_SETTINGS.quietStart,
    quietEnd: asString(raw.quietEnd) ?? DEFAULT_SETTINGS.quietEnd,
    snoozeUntilHour,
    monthlyBudget: asFiniteNumber(raw.monthlyBudget) !== undefined && (asFiniteNumber(raw.monthlyBudget) as number) > 0
      ? asFiniteNumber(raw.monthlyBudget)
      : undefined
  }
}

function migratePurchaseOption(raw: unknown): PurchaseOption | null {
  if (!isObject(raw)) return null
  const id = asString(raw.id)
  const productName = asString(raw.productName)
  const platform = asString(raw.platform)
  const unit = asString(raw.unit)
  // id / productName / platform / unit 为采购选项核心标识，缺失则丢弃该选项避免后续渲染崩溃
  if (!id || !productName || !platform || !unit) return null
  const price = asFiniteNumber(raw.price)
  return {
    id,
    productName,
    platform,
    unit,
    price: price !== undefined && price > 0 ? price : undefined,
    link: asString(raw.link),
    isDefault: raw.isDefault === true
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
  return {
    id: id ?? `event_${at}_${Math.random().toString(36).slice(2, 7)}`,
    at,
    intervalDays: asFiniteNumber(raw.intervalDays),
    price: asFiniteNumber(raw.price),
    qty: qty !== undefined && qty > 0 ? qty : undefined,
    platform: asString(raw.platform),
    rating,
    review: asString(raw.review)
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

  const now = Date.now()
  const createdAt = asFiniteNumber(raw.createdAt) ?? now
  const updatedAt = asFiniteNumber(raw.updatedAt) ?? createdAt
  const lastRestockedAt = asFiniteNumber(raw.lastRestockedAt) ?? createdAt

  return {
    id,
    name,
    category,
    type: raw.type === "fixed" ? "fixed" : "learning",
    cycleDays,
    bufferDays,
    lastRestockedAt,
    anchorEstimated: raw.anchorEstimated !== false,
    purchaseOptions: asArray(raw.purchaseOptions)
      .map(migratePurchaseOption)
      .filter((option): option is PurchaseOption => option !== null),
    history: historyEvents,
    link: asString(raw.link),
    price: asFiniteNumber(raw.price),
    snoozeUntil: asFiniteNumber(raw.snoozeUntil),
    orderedAt: (() => {
      const v = asFiniteNumber(raw.orderedAt)
      return v !== undefined && v > 0 ? v : undefined
    })(),
    suggestedCycleDays: asFiniteNumber(raw.suggestedCycleDays),
    learningEnabled: raw.learningEnabled !== false,
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
    version: 2,
    categories: categories.length ? categories : createInitialState().categories,
    items,
    settings: migrateSettings(raw.settings),
    updatedAt: asFiniteNumber(raw.updatedAt) ?? Date.now()
  }
}

/**
 * 解析失败时把原始 raw 备份到带时间戳的 key，避免后续 persist 立刻覆盖用户数据。
 * 备份失败也只 warn，不阻断应用启动。
 */
function backupCorruptRaw(raw: string): void {
  try {
    const backupKey = `${STORAGE_KEY}_corrupt_backup_${Date.now()}`
    localStorage.setItem(backupKey, raw)
  } catch (backupError) {
    console.warn("Unable to back up corrupt state", backupError)
  }
}

export function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      let saved: unknown
      try {
        saved = JSON.parse(raw)
      } catch (parseError) {
        // JSON.parse 失败：备份原始 raw，返回安全初始状态，不在本函数内覆盖原 key
        console.warn("Unable to parse local state JSON, backing up raw value", parseError)
        backupCorruptRaw(raw)
        return createInitialState()
      }
      return migrateState(saved)
    }
  } catch (error) {
    // localStorage 读取本身失败（隐私模式 / 配额 / 被禁用等）
    console.warn("Unable to read local state", error)
  }
  return createInitialState()
}

/**
 * 持久化容错：
 * - localStorage.setItem 失败（配额超限 / 被禁用）不再导致应用崩溃；
 * - window.desktop?.syncState 失败同样 catch；
 * - 两处失败均只 console.warn，不弹复杂 UI。
 */
export function persistState(state: AppState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch (storageError) {
    console.warn("Unable to persist state to localStorage", storageError)
  }
  try {
    window.desktop?.syncState(state)
  } catch (syncError) {
    console.warn("Unable to sync state to desktop main process", syncError)
  }
}
