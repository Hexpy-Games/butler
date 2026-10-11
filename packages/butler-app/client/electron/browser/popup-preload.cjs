const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("butlerPopup", {
  call: (op, input) => ipcRenderer.invoke("butler-browser:popup", op, input),
  subscribe: handler => {
    const listener = (_event, value) => handler(value);
    ipcRenderer.on("butler-browser:popup-state", listener);
    ipcRenderer.invoke("butler-browser:popup", "state").then(handler);
    return () => ipcRenderer.removeListener("butler-browser:popup-state", listener);
  },
});
