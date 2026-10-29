const { contextBridge, ipcRenderer } = require("electron");
ipcRenderer.on("butler:text-size", (_event, factor) => {
  if (typeof factor === "number" && Number.isFinite(factor) && factor > 0) document.documentElement.style.setProperty("--ui-scale", String(factor));
});
contextBridge.exposeInMainWorld("butlerApp", { initialTextSize: process.argv.find(arg => arg.startsWith("--butler-text-size="))?.split("=")[1] ?? "default" });
contextBridge.exposeInMainWorld("butlerPopup", {
  call: (op, input) => ipcRenderer.invoke("butler-browser:popup", op, input),
  subscribe: handler => {
    const listener = (_event, value) => handler(value);
    ipcRenderer.on("butler-browser:popup-state", listener);
    ipcRenderer.invoke("butler-browser:popup", "state").then(handler);
    return () => ipcRenderer.removeListener("butler-browser:popup-state", listener);
  },
});
