import type { AppState } from "./types"

type NotificationAction = {
  action: "open" | "restock" | "snooze"
  itemIds: string[]
}

declare global {
  interface Window {
    desktop?: {
      syncState: (state: AppState) => Promise<{ ok: boolean; error?: string }>
      loadState: () => Promise<AppState | null>
      openExternal: (url: string) => Promise<void>
      showWindow: () => void
      onNotificationAction: (callback: (payload: NotificationAction) => void) => () => void
    }
  }
}

declare module "*.png" {
  const value: string
  export default value
}

declare module "*.jpg" {
  const value: string
  export default value
}

declare module "*.svg" {
  const value: string
  export default value
}

export {}
