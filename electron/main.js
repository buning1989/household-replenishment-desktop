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
import {
  evaluateBudgetNotification,
  getBudgetNotificationState,
  resetBudgetNotificationState
} from "./budget-notifier.mjs"
import { performDemoReset } from "../src/shared/demo/demo-reset-core.mjs"

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

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on("second-instance", () => {
    showWindow()
  })
}

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
  const date = new Date(depletionAt(item))
  date.setDate(date.getDate() - Number(item.bufferDays || 0))
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function depletionAt(item) {
  const inventoryDepletionAt = Number(item.inventoryDepletionAt)
  if (Number.isFinite(inventoryDepletionAt)) {
    const inventoryDate = new Date(inventoryDepletionAt)
    inventoryDate.setHours(0, 0, 0, 0)
    return inventoryDate.getTime()
  }
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

// 预算提醒状态机已提取到 ./budget-notifier.mjs
// 保留 getMonthlySpending 用于计算当月支出

function getMonthlySpending(state) {
  if (!state || !Array.isArray(state.items)) return 0
  const now = new Date()
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime()
  let total = 0
  for (const item of state.items) {
    if (!Array.isArray(item.history)) continue
    for (const event of item.history) {
      // 与 domain.ts calculateMonthlySpend 保持一致：包含月份上界过滤
      if (event.at >= currentMonthStart && event.at < nextMonth && Number.isFinite(Number(event.price))) {
        total += Number(event.price)
      }
    }
  }
  return total
}

// 四档阈值各自独立标识，90% 和 100% 使用不同 level，避免 90→100 不触发
// 已迁移到 ./budget-notifier.mjs

function sendBudgetNotification(percent, spent, budget, settings) {
  if (!Notification.isSupported()) return
  const now = new Date()
  evaluateBudgetNotification(percent, spent, budget, settings, now, ({ title, body }) => {
    const notification = new Notification({ title, body, closeButtonText: "关闭" })
    notification.on("click", () => showWindow())
    notification.show()
  })
}

function checkBudgetNotification(state) {
  if (!state) return
  if (state.settings?.notificationEnabled === false) return
  const budget = Number(state.settings?.monthlyBudget || 0)
  if (budget <= 0) {
    // 预算被清空后状态复位
    resetBudgetNotificationState()
    return
  }
  const spent = getMonthlySpending(state)
  const percent = Math.round((spent / budget) * 100)
  sendBudgetNotification(percent, spent, budget, state.settings)
}

function sendNotification(items) {
  if (!Notification.isSupported()) return
  const item = items[0]
  const urgent = item && calendarDayNumber(Date.now()) >= calendarDayNumber(depletionAt(item))
  const title = urgent
    ? `${item?.name || "物品"}预计已用完了`
    : `${item?.name || "物品"}快用完了`
  const body = String(item?.category || "家庭用品")
  const actions = process.platform === "darwin"
    ? [
        { type: "button", text: "已买好" },
        { type: "button", text: "稍后提醒我" }
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
    // 任务三：通知点击后打开对话面板，并预置一条与该物品相关的管家消息
    mainWindow?.webContents.send("notification:action", { action: "openChat", itemIds: item ? [item.id] : [] })
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
    // 任务三：通知点击后打开对话面板，并预置一条与该物品相关的管家消息
    mainWindow?.webContents.send("notification:action", { action: "openChat", itemIds: item ? [item.id] : [] })
  })
  notification.show()
}

function checkReminders(force = false) {
  if (!latestState) return
  const now = Date.now()
  const settings = latestState.settings || {}
  if (settings.notificationEnabled === false) return
  const dueItems = getDueItems(latestState, now)
  if (!dueItems.length) {
    lastNotificationKey = ""
    return
  }

  if (!force) {
    if (inQuietHours(new Date(now), settings.quietStart, settings.quietEnd)) return
  }

  const key = dueItems.map((item) => item.id).sort().join(",")
  const reminderIntervalHours = Math.min(24, Math.max(1, Number(settings.reminderIntervalHours) || 1))
  const repeatMs = reminderIntervalHours * 60 * 60 * 1000
  const itemSetChanged = key !== lastNotificationKey
  if (!force && !itemSetChanged && now - lastNotificationAt < repeatMs) return

  sendNotification([dueItems[0]])
  lastNotificationKey = key
  lastNotificationAt = now
}

if (hasSingleInstanceLock) {
  app.whenReady().then(() => {
    if (process.platform === "darwin") {
      const dockIcon = nativeImage.createFromPath(APP_ICON).resize({ width: 128, height: 128 })
      app.dock.setIcon(dockIcon)
    }
    loadState()
    createWindow()
    createTray()
    setInterval(() => {
      checkReminders(false)
      checkBudgetNotification(latestState)
    }, 60 * 1000)
    setTimeout(() => {
      checkReminders(false)
      checkBudgetNotification(latestState)
    }, 2500)
  })
}

app.on("activate", showWindow)
app.on("before-quit", () => {
  isQuitting = true
})
app.on("window-all-closed", (event) => event.preventDefault())

ipcMain.handle("state:load", () => {
  // 返回主进程内存中的最新状态（已在 loadState 时经过 validateState 校验）。
  // renderer 侧负责与 localStorage 协调，避免空初始状态覆盖桌面备份。
  return latestState
})

ipcMain.handle("state:sync", (_event, state) => {
  const result = validateState(state)
  if (!result.valid) {
    console.warn("[main] state:sync: rejected invalid state:", result.reason)
    return { ok: false, error: "数据校验失败，未写入桌面备份。请检查商品名称和补货设置后重试。" }
  }
  // 校验合法：先更新内存，再尝试写文件。
  // 写入失败不影响当前运行时提醒，但不会破坏旧文件（原子写入保证）。
  latestState = state
  const saved = saveState(state)
  checkReminders(false)
  checkBudgetNotification(state)
  return saved
    ? { ok: true }
    : { ok: false, error: "数据已保存在当前窗口，但桌面备份文件写入失败。请重试并建议复制当前数据备份。" }
})

ipcMain.handle("state:reset-to-demo", (_event, currentState) => {
  console.log("[demo-reset] ipc request received")
  const file = stateFile()
  const backupDir = path.join(app.getPath("userData"), "demo-backups")
  const result = performDemoReset(currentState, file, backupDir)
  if (!result.ok) {
    console.log("[demo-reset] failed:", result.error, "rolledBack:", result.rolledBack)
    return { ok: false, error: result.error, rolledBack: result.rolledBack }
  }
  console.log("[demo-reset] backup completed:", result.backupPath)
  console.log("[demo-reset] state written and verified")
  // 更新主进程内存中的 state
  latestState = result.state
  checkReminders(false)
  checkBudgetNotification(result.state)
  return { ok: true, state: result.state, backupPath: result.backupPath }
})
// ---- 订单截图识别：代理 DashScope 请求，避免 renderer 侧 CORS 限制 ----
// 只做转发，不在主进程记录 apiKey / 图片内容。
const OCR_ENDPOINT = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
const OCR_TIMEOUT_MS = 90 * 1000
const LLM_CHAT_TIMEOUT_MS = 45 * 1000

ipcMain.handle("ocr:extract", async (_event, payload) => {
  const { apiKey, model, imageDataUrl, prompt } = payload || {}
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return { ok: false, error: "缺少 API Key，请先在设置中填写。" }
  }
  if (typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/")) {
    return { ok: false, error: "图片数据无效，请重新选择截图。" }
  }
  if (typeof prompt !== "string" || !prompt.trim()) {
    return { ok: false, error: "识别指令无效。" }
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS)
  const startedAt = Date.now()
  try {
    const basePayload = {
      model: typeof model === "string" && model.trim() ? model.trim() : "qwen3-vl-plus",
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageDataUrl } },
            { type: "text", text: prompt }
          ]
        }
      ],
      // 提取任务不需要思维链：关闭思考模式可大幅降低延迟，输出上限防止啰嗦
      enable_thinking: false,
      max_tokens: 1280,
      temperature: 0.1
    }
    const doRequest = (payload) => fetch(OCR_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey.trim()}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    })
    let response = await doRequest(basePayload)
    // 个别模型不接受 enable_thinking 参数：报参数错误时去掉该字段重试一次
    if (response.status === 400) {
      const errText = await response.clone().text().catch(() => "")
      if (/enable_thinking/i.test(errText)) {
        const { enable_thinking: _removed, ...fallbackPayload } = basePayload
        response = await doRequest(fallbackPayload)
      }
    }
    if (!response.ok) {
      let detail = ""
      try {
        const errBody = await response.json()
        detail = errBody?.error?.message || errBody?.message || ""
      } catch { /* ignore */ }
      if (response.status === 401 || response.status === 403) {
        return { ok: false, error: "API Key 无效或没有权限，请在设置中检查后重试。" }
      }
      if (response.status === 429) {
        return { ok: false, error: "识别服务请求过于频繁，请稍后重试。" }
      }
      return { ok: false, error: `识别服务返回错误（${response.status}）${detail ? `：${detail.slice(0, 200)}` : "，请稍后重试。"}` }
    }
    const data = await response.json()
    const message = data?.choices?.[0]?.message
    const content = message?.content
    // 计时与 token 用量日志：completion_tokens 异常大（接近 max_tokens）说明思考模式没被关掉
    const usage = data?.usage || {}
    const hasReasoning = typeof message?.reasoning_content === "string" && message.reasoning_content.length > 0
    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.log(`[main] ocr:extract elapsed=${elapsedSeconds}s prompt_tokens=${usage.prompt_tokens ?? "?"} completion_tokens=${usage.completion_tokens ?? "?"} reasoning=${hasReasoning}`)
    if (typeof content !== "string" || !content.trim()) {
      return {
        ok: false,
        error: hasReasoning
          ? "模型只输出了思考过程没有给出结果，请在设置中确认使用的是非思考型视觉模型。"
          : "识别服务没有返回内容，请换一张更清晰的截图重试。"
      }
    }
    return { ok: true, content, diagnostics: { elapsedSeconds: Number(elapsedSeconds), promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, hasReasoning } }
  } catch (error) {
    if (error?.name === "AbortError") {
      return { ok: false, error: "识别超时（90 秒），请检查网络后重试。" }
    }
    console.warn("[main] ocr:extract failed", error?.message)
    return { ok: false, error: "无法连接识别服务，请检查网络后重试。" }
  } finally {
    clearTimeout(timeout)
  }
})

ipcMain.handle("llm:chat", async (_event, payload) => {
  const { apiKey, model, messages } = payload || {}
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return { ok: false, error: "缺少 API Key，请先在设置中填写。" }
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, error: "对话内容为空，请输入问题后重试。" }
  }

  const sanitizedMessages = messages
    .map((message) => ({
      role: message?.role === "assistant" || message?.role === "system" ? message.role : "user",
      content: typeof message?.content === "string" ? message.content.slice(0, 12000) : ""
    }))
    .filter((message) => message.content.trim())

  if (!sanitizedMessages.length) {
    return { ok: false, error: "对话内容为空，请输入问题后重试。" }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), LLM_CHAT_TIMEOUT_MS)
  try {
    const response = await fetch(OCR_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey.trim()}`
      },
      body: JSON.stringify({
        model: typeof model === "string" && model.trim() ? model.trim() : "qwen-plus",
        messages: sanitizedMessages,
        temperature: 0.2
      }),
      signal: controller.signal
    })
    if (!response.ok) {
      let detail = ""
      try {
        const errBody = await response.json()
        detail = errBody?.error?.message || errBody?.message || ""
      } catch { /* ignore */ }
      if (response.status === 401 || response.status === 403) {
        return { ok: false, error: "API Key 无效或没有权限，请在设置中检查后重试。" }
      }
      if (response.status === 429) {
        return { ok: false, error: "对话服务请求过于频繁，请稍后重试。" }
      }
      return { ok: false, error: `对话服务返回错误（${response.status}）${detail ? `：${detail.slice(0, 200)}` : "，请稍后重试。"}` }
    }
    const data = await response.json()
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== "string" || !content.trim()) {
      return { ok: false, error: "对话服务没有返回内容，请换个问法重试。" }
    }
    return { ok: true, content }
  } catch (error) {
    if (error?.name === "AbortError") {
      return { ok: false, error: "对话超时（45 秒），请检查网络后重试。" }
    }
    console.warn("[main] llm:chat failed", error?.message)
    return { ok: false, error: "无法连接对话服务，请检查网络后重试。" }
  } finally {
    clearTimeout(timeout)
  }
})

ipcMain.on("window:show", showWindow)
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
