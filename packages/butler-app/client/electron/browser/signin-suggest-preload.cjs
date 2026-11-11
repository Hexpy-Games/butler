const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("butlerSignInSuggest", {
  subscribe(handler) {
    const listener = (_event, frame) => handler(frame);
    ipcRenderer.on("butler-browser:signin-suggest", listener);
    return () => ipcRenderer.removeListener("butler-browser:signin-suggest", listener);
  },
  pick: entryId => ipcRenderer.send("butler-browser:signin-suggest-pick", entryId),
  size: height => ipcRenderer.send("butler-browser:signin-suggest-size", height),
});
