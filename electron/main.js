import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray
} from "electron"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)
const DAY_MS = 24 * 60 * 60 * 1000
const APP_NAME = "403家庭管家"
const APP_ICON = path.join(__dirname, "../build/icons/icon_1024.png")

let mainWindow = null
let tray = null
let isQuitting = false
let latestState = null
let lastNotificationAt = 0
let lastNotificationKey = ""

function stateFile() {
  return path.join(app.getPath("userData"), "reminder-state.json")
}

function saveState(state) {
  latestState = state
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(state), "utf8")
  } catch (error) {
    console.warn("Unable to persist reminder state", error)
  }
}

function loadState() {
  try {
    latestState = JSON.parse(fs.readFileSync(stateFile(), "utf8"))
  } catch {
    latestState = null
  }
}

function createTrayIcon() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <path fill="#111" d="M7 11.5C7 6.8 10.8 3 15.5 3S24 6.8 24 11.5V18l3 4v2H4v-2l3-4v-6.5Z"/>
      <path fill="#111" d="M12 26h7c-.6 2-1.7 3-3.5 3S12.6 28 12 26Z"/>
    </svg>`
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`)
  image.setTemplateImage(true)
  return image.resize({ width: 18, height: 18 })
}

function showWindow() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 650,
    title: APP_NAME,
    icon: APP_ICON,
    backgroundColor: "#f3f1ec",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (isDev) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"))
  }

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })
}

function createTray() {
  tray = new Tray(createTrayIcon())
  tray.setToolTip(APP_NAME)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `打开${APP_NAME}`, click: showWindow },
    { label: "检查提醒", click: () => checkReminders(true) },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ]))
  tray.on("click", showWindow)
}

function calendarDayNumber(timestamp) {
  const date = new Date(timestamp)
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS)
}

function dueAt(item) {
  const date = new Date(item.lastRestockedAt)
  date.setDate(date.getDate() + Number(item.cycleDays || 0) - Number(item.bufferDays || 0))
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function depletionAt(item) {
  const date = new Date(item.lastRestockedAt)
  date.setDate(date.getDate() + Number(item.cycleDays || 0))
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function inQuietHours(now, start, end) {
  const [startHour, startMinute] = String(start || "22:00").split(":").map(Number)
  const [endHour, endMinute] = String(end || "08:00").split(":").map(Number)
  const minute = now.getHours() * 60 + now.getMinutes()
  const startValue = startHour * 60 + startMinute
  const endValue = endHour * 60 + endMinute
  return startValue > endValue
    ? minute >= startValue || minute < endValue
    : minute >= startValue && minute < endValue
}

function getDueItems(state, now = Date.now()) {
  return (state?.items || []).filter((item) => {
    if (Number(item.snoozeUntil || 0) > now) return false
    return calendarDayNumber(now) >= calendarDayNumber(dueAt(item))
  }).sort((a, b) => depletionAt(a) - depletionAt(b))
}

function sendNotification(items, isTest = false) {
  if (!Notification.isSupported()) return
  const item = items[0]
  const urgent = item && calendarDayNumber(Date.now()) >= calendarDayNumber(depletionAt(item))
  const title = isTest
    ? "提醒功能工作正常"
    : urgent
      ? `${item?.name || "物品"}需要补货了`
      : `${item?.name || "物品"}快用完了`
  const body = isTest
    ? "通知已开启"
    : String(item?.category || "家庭用品")
  const actions = process.platform === "darwin"
    ? [
        { type: "button", text: "已买好" },
        { type: "button", text: "明天提醒我" }
      ]
    : []
  const notification = new Notification({
    title,
    body,
    actions,
    closeButtonText: "关闭"
  })

  notification.on("click", () => {
    showWindow()
    mainWindow?.webContents.send("notification:action", { action: "open", itemIds: item ? [item.id] : [] })
  })
  notification.on("action", (_event, index) => {
    if (index === 0 && item) {
      mainWindow?.webContents.send("notification:action", { action: "restock", itemIds: [item.id] })
      return
    }
    if (index === 1 && item) {
      mainWindow?.webContents.send("notification:action", { action: "snooze", itemIds: [item.id] })
      return
    }
    showWindow()
    mainWindow?.webContents.send("notification:action", { action: "open", itemIds: item ? [item.id] : [] })
  })
  notification.show()
}

function checkReminders(force = false) {
  if (!latestState) return
  const now = Date.now()
  const settings = latestState.settings || {}
  const dueItems = getDueItems(latestState, now)
  if (!dueItems.length) {
    lastNotificationKey = ""
    return
  }

  if (!force) {
    if (inQuietHours(new Date(now), settings.quietStart, settings.quietEnd)) return
  }

  const key = dueItems.map((item) => item.id).sort().join(",")
  const repeatMs = Number(settings.reminderIntervalMinutes || 60) * 60 * 1000
  const itemSetChanged = key !== lastNotificationKey
  if (!force && !itemSetChanged && now - lastNotificationAt < repeatMs) return

  sendNotification([dueItems[0]])
  lastNotificationKey = key
  lastNotificationAt = now
}

app.whenReady().then(() => {
  if (process.platform === "darwin") {
    const dockIcon = nativeImage.createFromPath(APP_ICON).resize({ width: 128, height: 128 })
    app.dock.setIcon(dockIcon)
  }
  loadState()
  createWindow()
  createTray()
  setInterval(() => checkReminders(false), 60 * 1000)
  setTimeout(() => checkReminders(false), 2500)
})

app.on("activate", showWindow)
app.on("before-quit", () => {
  isQuitting = true
})
app.on("window-all-closed", (event) => event.preventDefault())

ipcMain.on("state:sync", (_event, state) => {
  saveState(state)
  checkReminders(false)
})
ipcMain.on("window:show", showWindow)
ipcMain.on("notification:test", () => sendNotification([], true))
ipcMain.handle("external:open", (_event, url) => {
  const target = new URL(url)
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error("Only http and https links are supported")
  }
  return shell.openExternal(target.toString())
})
