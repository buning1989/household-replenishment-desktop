const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("desktop", {
  syncState: (state) => ipcRenderer.invoke("state:sync", state),
  loadState: () => ipcRenderer.invoke("state:load"),
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
