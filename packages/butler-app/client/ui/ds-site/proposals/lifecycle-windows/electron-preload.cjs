// Preload for electron-preview.mjs (proposal tooling only).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lifecyclePreview", {
  resize: (width, height) => ipcRenderer.send("lifecycle-preview:resize", width, height),
  action: (name) => ipcRenderer.send("lifecycle-preview:action", String(name)),
});
