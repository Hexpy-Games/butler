// This renderer has only a one-way presentation channel, no App or browser tools.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("butlerBrowserOverlay", {
  subscribe(handler) {
    const listener = (_event, frame) => handler(frame);
    ipcRenderer.on("butler-browser:overlay", listener);
    return () => ipcRenderer.removeListener("butler-browser:overlay", listener);
  },
});
