const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("desktop", {
  syncState: (state) => ipcRenderer.send("state:sync", state),
  openExternal: (url) => ipcRenderer.invoke("external:open", url),
  showWindow: () => ipcRenderer.send("window:show"),
  testNotification: () => ipcRenderer.send("notification:test"),
  onNotificationAction: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on("notification:action", listener)
    return () => ipcRenderer.removeListener("notification:action", listener)
  }
})

