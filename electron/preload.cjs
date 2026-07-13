const { contextBridge, ipcRenderer } = require("electron")
const fs = require("node:fs")
const path = require("node:path")

// 读取构建模式（与 main.js 相同的优先级：env > build-info.json > personal）
// 不导入 src/shared/build-mode.mjs（ESM），直接内联最小逻辑，避免 CJS/ESM 互操作问题。
function readBuildMode() {
  const VALID_MODES = ["personal", "demo"]
  function resolve(value, fallback) {
    return typeof value === "string" && VALID_MODES.includes(value) ? value : (VALID_MODES.includes(fallback) ? fallback : "personal")
  }
  if (process.env.APP_BUILD_MODE) {
    return resolve(process.env.APP_BUILD_MODE, "personal")
  }
  try {
    const infoPath = path.join(__dirname, "build-info.json")
    if (fs.existsSync(infoPath)) {
      const info = JSON.parse(fs.readFileSync(infoPath, "utf8"))
      return resolve(info.mode, "personal")
    }
  } catch {
    // 读取失败，回退到 personal
  }
  return "personal"
}

const buildMode = readBuildMode()

contextBridge.exposeInMainWorld("desktop", {
  syncState: (state) => ipcRenderer.invoke("state:sync", state),
  loadState: () => ipcRenderer.invoke("state:load"),
  resetToDemoState: (currentState) => ipcRenderer.invoke("state:reset-to-demo", currentState),
  ocrExtract: (payload) => ipcRenderer.invoke("ocr:extract", payload),
  chatComplete: (payload) => ipcRenderer.invoke("llm:chat", payload),
  openExternal: (url) => ipcRenderer.invoke("external:open", url),
  showWindow: () => ipcRenderer.send("window:show"),
  buildMode,
  onNotificationAction: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on("notification:action", listener)
    return () => ipcRenderer.removeListener("notification:action", listener)
  }
})

// 诊断日志：确认 preload 已成功注入
console.log(`[preload] bridge initialized, buildMode=${buildMode}`)
