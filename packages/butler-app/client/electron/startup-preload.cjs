const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("butlerStartup", {
  painted: () => ipcRenderer.send("butler:startup-painted"),
  state: () => ipcRenderer.invoke("butler:startup-state"),
  action: (action) => ipcRenderer.invoke("butler:startup-action", action),
  subscribe: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("butler:startup-state", listener);
    return () => ipcRenderer.removeListener("butler:startup-state", listener);
  },
});
