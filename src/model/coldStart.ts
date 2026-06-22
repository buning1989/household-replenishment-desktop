import { calibrateRemainingDays, computeItem, createItem } from "../domain"
import type { ConsumableTemplate, HouseholdProfile, InventoryStatus, ReplenishmentItem } from "../types"
import { calculateHouseholdCycleFactor } from "./householdProfile"

export const INVENTORY_STATUS_OPTIONS: Array<{ value: InventoryStatus; label: string; ratio: number }> = [
  { value: "justRestocked", label: "刚补过", ratio: 0.9 },
  { value: "plenty", label: "还很多", ratio: 0.7 },
  { value: "half", label: "大概一半", ratio: 0.5 },
  { value: "low", label: "快没了", ratio: 0.15 },
  { value: "unknown", label: "不确定", ratio: 0.5 }
]

const STATUS_BY_VALUE = new Map(INVENTORY_STATUS_OPTIONS.map((option) => [option.value, option]))

export function adjustedCycleDays(template: ConsumableTemplate, profile: HouseholdProfile): number {
  const adjusted = Math.round(template.defaultCycleDays * calculateHouseholdCycleFactor(template, profile))
  return Math.min(template.maxCycleDays, Math.max(template.minCycleDays, adjusted))
}

export function createColdStartItem(
  template: ConsumableTemplate,
  profile: HouseholdProfile,
  inventoryStatus: InventoryStatus,
  now = Date.now()
): ReplenishmentItem {
  const cycleDays = adjustedCycleDays(template, profile)
  const status = STATUS_BY_VALUE.get(inventoryStatus) ?? STATUS_BY_VALUE.get("unknown")!
  const remainingDays = Math.max(1, Math.round(cycleDays * status.ratio))
  const created = createItem({
    name: template.name,
    category: template.category,
    cycleDays,
    bufferDays: Math.min(cycleDays - 1, template.bufferDays),
    link: "",
    remainingDays: "",
    learningEnabled: template.learningEnabled,
    unit: template.unit,
    defaultQty: "",
    platform: ""
  }, now)
  const calibrated = calibrateRemainingDays(created, remainingDays, now)
  return {
    ...calibrated,
    source: "onboarding",
    templateId: template.id,
    confidence: template.defaultConfidence,
    inventoryStatus,
    modelNote: `基于家庭画像和“${status.label}”库存状态估算`,
    feedbackCount: 0
  }
}

export function createColdStartItems(
  profile: HouseholdProfile,
  selections: Array<{ template: ConsumableTemplate; inventoryStatus: InventoryStatus }>,
  now = Date.now()
): ReplenishmentItem[] {
  return selections.map(({ template, inventoryStatus }) => createColdStartItem(template, profile, inventoryStatus, now))
}

export function summarizeColdStart(items: ReplenishmentItem[], now = Date.now()) {
  const computed = items.map((item) => computeItem(item, now))
  return {
    created: items.length,
    within7Days: computed.filter((item) => item.daysUntilDepletion <= 7).length,
    within30Days: computed.filter((item) => item.daysUntilDepletion <= 30).length
  }
}

export type ColdStartFeedback = "plenty" | "low" | "later"

export function applyColdStartFeedback(
  item: ReplenishmentItem,
  feedback: ColdStartFeedback,
  now = Date.now(),
  snoozeUntil?: number
): ReplenishmentItem {
  const feedbackCount = (item.feedbackCount || 0) + 1
  if (feedback === "later") {
    return {
      ...item,
      snoozeUntil,
      lastFeedbackAt: now,
      feedbackCount,
      modelNote: "本次只推迟提醒，未改变消耗周期",
      updatedAt: now
    }
  }

  const currentRemaining = Math.max(0, computeItem(item, now).daysUntilDepletion)
  const targetRemaining = feedback === "plenty"
    ? Math.min(item.cycleDays, Math.max(currentRemaining + Math.round(item.cycleDays * 0.4), Math.round(item.cycleDays * 0.5)))
    : Math.min(7, Math.max(3, Math.round(item.cycleDays * 0.1)))
  const calibrated = calibrateRemainingDays(item, targetRemaining, now)
  return {
    ...calibrated,
    inventoryStatus: feedback,
    confidence: feedback === "low" ? "medium" : "low",
    lastFeedbackAt: now,
    feedbackCount,
    modelNote: feedback === "plenty"
      ? "用户反馈还很多，已延后下次检查"
      : "用户反馈快没了，已将提醒窗口调整到 3-7 天",
    snoozeUntil: undefined,
    updatedAt: now
  }
}
