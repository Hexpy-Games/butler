// Preload for electron-preview.mjs (proposal tooling only).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lifecyclePreview", {
  action: (name) => ipcRenderer.send("lifecycle-preview:action", String(name)),
});
