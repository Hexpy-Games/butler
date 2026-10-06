performance.mark("lifecycle_preload");
const { contextBridge, ipcRenderer } = require("electron");
const painted = () => ipcRenderer.send("butler:lifecycle-painted", { card: {
    title: document.querySelector('[data-slot="title"]')?.textContent,
    line: document.querySelector('[data-slot="line"]')?.textContent,
    fontReady: document.fonts.check('14px "Pretendard Variable"'),
    markReady: document.querySelector('[data-slot="mark-rest"]')?.getBoundingClientRect().width === 48 || document.querySelector('[data-slot="mark"]')?.dataset.ready === "1",
    images: document.images.length,
  }, timeOrigin: performance.timeOrigin, marks: performance.getEntriesByType("mark").map(({ name, startTime }) => ({ name, startTime })), navigation: Object.fromEntries(["startTime", "responseEnd", "domInteractive", "domContentLoadedEventStart", "domContentLoadedEventEnd", "loadEventEnd"].map((key) => [key, performance.getEntriesByType("navigation")[0]?.[key]])) });
contextBridge.exposeInMainWorld("butlerLifecycle", {
  state: () => ipcRenderer.invoke("butler:lifecycle-state"),
  action: (action) => ipcRenderer.invoke("butler:lifecycle-action", action),
  layout: (height) => ipcRenderer.send("butler:lifecycle-size", height),
  painted,
  onState: (listener) => ipcRenderer.on("butler:lifecycle-state", (_event, state) => {
    if (state.repaint) { performance.clearMarks(); document.documentElement.dataset.painted = "false"; }
    listener(state);
    if (state.repaint) {
      performance.mark("copy_ready");
      void document.fonts.ready.then(() => {
        performance.mark("font_ready");
        requestAnimationFrame(() => setTimeout(() => {
          document.documentElement.dataset.painted = "true";
          performance.mark("first_frame"); painted();
        }));
      });
    }
  }),
});
