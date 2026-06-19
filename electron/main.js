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

// ---- 主进程全局异常兜底：仅记录日志，不弹 UI、不退出、不重启 ----
process.on("uncaughtException", (error) => {
  console.error("[main] uncaughtException", error)
})
process.on("unhandledRejection", (reason) => {
  console.error("[main] unhandledRejection", reason)
})

let mainWindow = null
let tray = null
let isQuitting = false
let latestState = null
let lastNotificationAt = 0
let lastNotificationKey = ""

function stateFile() {
  return path.join(app.getPath("userData"), "reminder-state.json")
}

function stateTmpFile() {
  return path.join(app.getPath("userData"), "reminder-state.json.tmp")
}

// 轻量 state 校验：只做最低限度检查，不复制 renderer store.ts 的完整迁移逻辑。
// 返回 { valid: boolean, reason?: string }
function validateState(state) {
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    return { valid: false, reason: "state is not an object" }
  }
  if (!Array.isArray(state.items)) {
    return { valid: false, reason: "state.items is not an array" }
  }
  for (let i = 0; i < state.items.length; i++) {
    const item = state.items[i]
    if (item === null || typeof item !== "object") {
      return { valid: false, reason: `items[${i}] is not an object` }
    }
    if (
      typeof item.id !== "string" || item.id.trim() === "" ||
      typeof item.name !== "string" || item.name.trim() === "" ||
      typeof item.category !== "string" || item.category.trim() === ""
    ) {
      return { valid: false, reason: `items[${i}] has invalid id/name/category` }
    }
    if (!Number.isFinite(Number(item.cycleDays))) {
      return { valid: false, reason: `items[${i}].cycleDays is not finite` }
    }
    if (!Number.isFinite(Number(item.bufferDays))) {
      return { valid: false, reason: `items[${i}].bufferDays is not finite` }
    }
    if (!Number.isFinite(Number(item.lastRestockedAt))) {
      return { valid: false, reason: `items[${i}].lastRestockedAt is not finite` }
    }
  }
  if (state.settings !== undefined && state.settings !== null) {
    if (typeof state.settings !== "object" || Array.isArray(state.settings)) {
      return { valid: false, reason: "state.settings is not an object" }
    }
  }
  return { valid: true }
}

function saveState(state) {
  // 原子写入：先写临时文件，成功后 rename 到正式路径。
  // 写入失败时保留旧文件，不影响 latestState 内存值。
  try {
    fs.writeFileSync(stateTmpFile(), JSON.stringify(state), "utf8")
    fs.renameSync(stateTmpFile(), stateFile())
  } catch (error) {
    console.warn("[main] saveState: failed to persist state", error)
    // 尝试清理残留的 tmp 文件（忽略错误）
    try { fs.unlinkSync(stateTmpFile()) } catch { /* ignore */ }
    return false
  }
  return true
}

function loadState() {
  try {
    const raw = fs.readFileSync(stateFile(), "utf8")
    const parsed = JSON.parse(raw)
    const result = validateState(parsed)
    if (!result.valid) {
      console.warn("[main] loadState: invalid state on disk, ignoring:", result.reason)
      latestState = null
      return
    }
    latestState = parsed
  } catch (error) {
    console.warn("[main] loadState: failed to read/parse state file", error)
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

  // ---- 导航安全：阻止主窗口跳转到外部 URL ----
  mainWindow.webContents.on("will-navigate", (event, url) => {
    try {
      const parsed = new URL(url)
      // dev 模式允许 Vite dev server；production 允许 file:// 协议
      const allowed = isDev
        ? parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && parsed.port === "5173"
        : parsed.protocol === "file:"
      if (!allowed) {
        // 对合法 http/https 外链，委托系统浏览器打开而非主窗口导航
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          shell.openExternal(parsed.toString()).catch((error) => {
            console.warn("Unable to open external link via will-navigate", error)
          })
        }
        event.preventDefault()
      }
    } catch {
      // URL 解析失败（非法 URL），一律阻止
      event.preventDefault()
    }
  })

  // ---- 阻止 window.open / target=_blank 在应用内打开新窗口 ----
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        shell.openExternal(parsed.toString()).catch((error) => {
          console.warn("Unable to open external link via window.open", error)
        })
      }
    } catch {
      // 非法 URL，静默忽略
    }
    return { action: "deny" }
  })

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
      ? `${item?.name || "物品"}预计已用完了`
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
  const result = validateState(state)
  if (!result.valid) {
    console.warn("[main] state:sync: rejected invalid state:", result.reason)
    return
  }
  // 校验合法：先更新内存，再尝试写文件。
  // 写入失败不影响当前运行时提醒，但不会破坏旧文件（原子写入保证）。
  latestState = state
  saveState(state)
  checkReminders(false)
})
ipcMain.on("window:show", showWindow)
ipcMain.on("notification:test", () => sendNotification([], true))
ipcMain.handle("external:open", async (_event, url) => {
  let target
  try {
    target = new URL(url)
  } catch {
    return { ok: false, error: "Invalid URL" }
  }
  if (!['http:', 'https:'].includes(target.protocol)) {
    return { ok: false, error: "Only http and https links are supported" }
  }
  try {
    await shell.openExternal(target.toString())
    return { ok: true }
  } catch (openError) {
    return { ok: false, error: openError.message }
  }
})
