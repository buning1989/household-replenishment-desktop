import { createInitialState } from "./domain"
import type { AppState, ReplenishmentItem } from "./types"

const STORAGE_KEY = "household_replenishment_desktop_v1"
const CARD_STATES_DEMO_KEY = "household_replenishment_card_states_demo_v2"

function demoItem(name: string, category: string, cycleDays: number, bufferDays: number, elapsedDays: number): ReplenishmentItem {
  const now = Date.now()
  const lastRestockedAt = new Date(now)
  lastRestockedAt.setDate(lastRestockedAt.getDate() - elapsedDays)
  lastRestockedAt.setHours(0, 0, 0, 0)
  return {
    id: `demo_${name}_${now}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    category,
    type: "learning",
    cycleDays,
    bufferDays,
    lastRestockedAt: lastRestockedAt.getTime(),
    anchorEstimated: true,
    history: [],
    learningEnabled: true,
    createdAt: now,
    updatedAt: now
  }
}

function addCardStateDemoItems(state: AppState): AppState {
  if (localStorage.getItem(CARD_STATES_DEMO_KEY)) return state
  const findCategory = (...keywords: string[]) => state.categories.find((category) => keywords.some((keyword) => category.includes(keyword)))
  const kitchen = findCategory("厨房") || state.categories[0]
  const bathroom = findCategory("卫生", "浴室") || state.categories[1] || state.categories[0]
  const laundry = findCategory("洗衣") || state.categories[2] || state.categories[0]
  const additions = [
    kitchen && demoItem("食用油", kitchen, 30, 5, 36),
    bathroom && demoItem("洗手液", bathroom, 30, 5, 28),
    laundry && demoItem("洗衣凝珠", laundry, 32, 5, 30),
    bathroom && demoItem("沐浴露", bathroom, 45, 5, 42),
    kitchen && demoItem("保鲜膜", kitchen, 25, 3, 26),
    laundry && demoItem("柔顺剂", laundry, 40, 5, 38),
  ].filter((item): item is ReplenishmentItem => Boolean(item))
    .filter((item) => !state.items.some((current) => current.name === item.name && current.category === item.category))
  localStorage.setItem(CARD_STATES_DEMO_KEY, "1")
  return additions.length ? { ...state, items: [...state.items, ...additions], updatedAt: Date.now() } : state
}

function migrateItem(item: ReplenishmentItem): ReplenishmentItem {
  const migratedHistory = item.history.map((event) => ({
    ...event,
    qty: Number.isFinite(Number(event.qty)) && Number(event.qty) > 0 ? Number(event.qty) : undefined,
    platform: event.platform || undefined,
    rating: event.rating || undefined,
    review: event.review?.trim() || undefined
  }))
  return {
    ...item,
    type: "learning",
    bufferDays: Math.min(Math.max(0, Number(item.cycleDays) - 1), Math.max(0, Number(item.bufferDays) || 0)),
    learningEnabled: item.learningEnabled !== false,
    orderedAt: Number.isFinite(Number(item.orderedAt)) && Number(item.orderedAt) > 0
      ? Number(item.orderedAt)
      : undefined,
    unit: item.unit?.trim() || undefined,
    platform: item.platform?.trim() || undefined,
    defaultQty: Number.isFinite(Number(item.defaultQty)) && Number(item.defaultQty) > 0
      ? Number(item.defaultQty)
      : undefined,
    history: migratedHistory
  }
}

export function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as AppState
      return addCardStateDemoItems({
        ...saved,
        version: 2,
        settings: {
          ...saved.settings,
          monthlyBudget: Number(saved.settings?.monthlyBudget) > 0
            ? Number(saved.settings.monthlyBudget)
            : undefined
        },
        items: saved.items.map(migrateItem)
      })
    }
  } catch (error) {
    console.warn("Unable to read local state", error)
  }
  return addCardStateDemoItems(createInitialState())
}

export function persistState(state: AppState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  window.desktop?.syncState(state)
}