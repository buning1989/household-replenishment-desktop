const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("desktop", {
  syncState: (state) => ipcRenderer.invoke("state:sync", state),
  loadState: () => ipcRenderer.invoke("state:load"),
  resetToDemoState: (currentState) => ipcRenderer.invoke("state:reset-to-demo", currentState),
  ocrExtract: (payload) => ipcRenderer.invoke("ocr:extract", payload),
  chatComplete: (payload) => ipcRenderer.invoke("llm:chat", payload),
  openExternal: (url) => ipcRenderer.invoke("external:open", url),
  showWindow: () => ipcRenderer.send("window:show"),
  onNotificationAction: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on("notification:action", listener)
    return () => ipcRenderer.removeListener("notification:action", listener)
  }
})

// 诊断日志：确认 preload 已成功注入，resetToDemoState 方法已暴露
console.log("[demo-reset] preload bridge initialized, resetToDemoState exposed")
