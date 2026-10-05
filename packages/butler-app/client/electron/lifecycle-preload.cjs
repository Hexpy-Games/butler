const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("butlerLifecycle", {
  state: () => ipcRenderer.invoke("butler:lifecycle-state"),
  action: (action) => ipcRenderer.invoke("butler:lifecycle-action", action),
  painted: () => ipcRenderer.send("butler:lifecycle-painted"),
  onState: (listener) => ipcRenderer.on("butler:lifecycle-state", (_event, state) => listener(state)),
});
