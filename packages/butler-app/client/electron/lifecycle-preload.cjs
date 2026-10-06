performance.mark("lifecycle_preload");
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("butlerLifecycle", {
  state: () => ipcRenderer.invoke("butler:lifecycle-state"),
  action: (action) => ipcRenderer.invoke("butler:lifecycle-action", action),
  layout: (height) => ipcRenderer.send("butler:lifecycle-size", height),
  painted: () => ipcRenderer.send("butler:lifecycle-painted", { card: {
    title: document.querySelector('[data-slot="title"]')?.textContent,
    line: document.querySelector('[data-slot="line"]')?.textContent,
    fontReady: document.fonts.check('14px "Pretendard Variable"'),
    markReady: document.querySelector('[data-slot="mark"]')?.dataset.ready === "1",
    images: document.images.length,
  }, timeOrigin: performance.timeOrigin, marks: performance.getEntriesByType("mark").map(({ name, startTime }) => ({ name, startTime })), navigation: Object.fromEntries(["startTime", "responseEnd", "domInteractive", "domContentLoadedEventStart", "domContentLoadedEventEnd", "loadEventEnd"].map((key) => [key, performance.getEntriesByType("navigation")[0]?.[key]])) }),
  onState: (listener) => ipcRenderer.on("butler:lifecycle-state", (_event, state) => listener(state)),
});
