// Type declarations for pure-logic.mjs.
// 这些纯函数同时被 renderer (TS) 和 .mjs 测试引用，
// 因此实现放在 .mjs 中以便 Node 直接 import，类型在这里声明。

import type { AppState, PricingMode, ReplenishmentItem, DeleteCategoryOptions } from "./types"

export type { DeleteCategoryOptions } from "./types"

export interface CanConfirmRestockInput {
  qty: number | ''
  price: number | ''
  restockDateValid: boolean
  usesMeasurePricing: boolean
  measureAmount: number | ''
  measureUnit: string
}

export function canConfirmRestock(input: CanConfirmRestockInput): boolean

export interface ApplyDeleteCategoryResult {
  ok: boolean
  reason?: string
  state: AppState
}

export function applyDeleteCategory(
  state: AppState,
  category: string,
  options?: DeleteCategoryOptions
): ApplyDeleteCategoryResult

export function calculateMonthlySpend(items: ReplenishmentItem[], now?: number): number
export function startOfDay(timestamp: number): number

export function addDays(timestamp: number, days: number): number

export function differenceInDays(later: number, earlier: number): number

export interface RestockItemCoreInput {
  item: ReplenishmentItem
  eventId: string
  now?: number
  price?: number
  qty?: number
  platform?: string
  purchaseOptionId?: string
  purchaseProductName?: string
  purchaseUnit?: string
  purchasePricingMode?: PricingMode
  purchaseMeasureBaseAmount?: number
  purchaseMeasureAmount?: number
  purchaseMeasureUnit?: string
  review?: string
  restockDate?: number
}

export function restockItemCore(input: RestockItemCoreInput): ReplenishmentItem
