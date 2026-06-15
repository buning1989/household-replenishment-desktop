import { createInitialState } from "./domain"
import type { AppState, ReplenishmentItem } from "./types"

const STORAGE_KEY = "household_replenishment_desktop_v1"
const CARD_STATES_DEMO_KEY = "household_replenishment_card_states_demo_v1"
const DAY_MS = 24 * 60 * 60 * 1000

function demoItem(name: string, category: string, cycleDays: number, bufferDays: number, elapsedDays: number, orderedDaysAgo?: number): ReplenishmentItem {
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
    orderedAt: orderedDaysAgo === undefined ? undefined : now - orderedDaysAgo * DAY_MS,
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
    kitchen && demoItem("食用油", kitchen, 30, 5, 31),
    bathroom && demoItem("洗手液", bathroom, 30, 5, 26),
    laundry && demoItem("洗衣凝珠", laundry, 32, 5, 29, 1)
  ].filter((item): item is ReplenishmentItem => Boolean(item))
    .filter((item) => !state.items.some((current) => current.name === item.name && current.category === item.category))
  localStorage.setItem(CARD_STATES_DEMO_KEY, "1")
  return additions.length ? { ...state, items: [...state.items, ...additions], updatedAt: Date.now() } : state
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
        items: saved.items.map((item) => ({
          ...item,
          type: "learning",
          bufferDays: Math.min(Math.max(0, Number(item.cycleDays) - 1), Math.max(0, Number(item.bufferDays) || 0)),
          learningEnabled: item.learningEnabled !== false,
          orderedAt: Number.isFinite(Number(item.orderedAt)) && Number(item.orderedAt) > 0
            ? Number(item.orderedAt)
            : undefined
        }))
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
