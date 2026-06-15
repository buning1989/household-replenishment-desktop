import type { AppState } from "./types"

type NotificationAction = {
  action: "open" | "restock" | "snooze"
  itemIds: string[]
}

declare global {
  interface Window {
    desktop?: {
      syncState: (state: AppState) => void
      openExternal: (url: string) => Promise<void>
      showWindow: () => void
      testNotification: () => void
      onNotificationAction: (callback: (payload: NotificationAction) => void) => () => void
    }
  }
}

export {}

