performance.mark("lifecycle_preload");
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("butlerLifecycle", {
  state: () => ipcRenderer.invoke("butler:lifecycle-state"),
  action: (action) => ipcRenderer.invoke("butler:lifecycle-action", action),
  painted: () => ipcRenderer.send("butler:lifecycle-painted", { timeOrigin: performance.timeOrigin, marks: performance.getEntriesByType("mark").map(({ name, startTime }) => ({ name, startTime })), navigation: performance.getEntriesByType("navigation")[0]?.toJSON() }),
  onState: (listener) => ipcRenderer.on("butler:lifecycle-state", (_event, state) => listener(state)),
});
