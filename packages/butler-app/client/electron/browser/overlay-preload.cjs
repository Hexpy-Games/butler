// This renderer has only a one-way presentation channel, no App or browser tools.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("butlerBrowserOverlay", {
  chrome: (id, rect) => ipcRenderer.send("butler-browser:selection-chrome", id, rect),
  command: (op, id, point) => ipcRenderer.send("butler-browser:selection-command", op, id, point),
  subscribe(handler) {
    const listener = (_event, frame) => handler(frame);
    ipcRenderer.on("butler-browser:overlay", listener);
    return () => ipcRenderer.removeListener("butler-browser:overlay", listener);
  },
});

// Capture stays in the overlay across native-view boundaries during a held drag.
// The untrusted page never owns this bridge or receives App IPC capabilities.
window.addEventListener("DOMContentLoaded", () => {
  const root = document.documentElement;
  root.addEventListener("pointerdown", event => {
    if (event.button === 0 && !event.target.closest("button")) root.setPointerCapture(event.pointerId);
  }, true);
  for (const type of ["mousedown", "mouseup", "mousemove", "mouseenter", "mouseleave", "wheel"]) {
    root.addEventListener(type, event => {
      // Descendant enter/leave events (including capture retargeting) are not
      // page-boundary crossings and must not interrupt a forwarded click.
      if ((type === "mouseenter" || type === "mouseleave") && event.target !== root) return;
      // The presenter must never start its own text/image drag or steal focus.
      if (type === "mousedown" && !event.target.closest('[data-slot="selection-bar"]')) event.preventDefault();
      const modifiers = ["shift", "control", "alt", "meta"].filter(key => event[`${key === "control" ? "ctrl" : key}Key`]);
      for (const [mask, name] of [[1, "left"], [2, "right"], [4, "middle"]]) {
        if (event.buttons & mask) modifiers.push(`${name}buttondown`);
      }
      const input = { type, x: event.clientX, y: event.clientY, button: ["left", "middle", "right"][event.button],
        clickCount: event.detail, modifiers, movementX: event.movementX, movementY: event.movementY };
      if (type === "wheel") {
        // DOM deltas point opposite to Chromium's native wheel deltas.
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
        Object.assign(input, { deltaX: -event.deltaX * unit, deltaY: -event.deltaY * unit,
          canScroll: true, hasPreciseScrollingDeltas: event.deltaMode === 0 });
        event.preventDefault();
      }
      ipcRenderer.send("butler-browser:pointer-input", input);
    }, { capture: true, passive: false });
  }
  root.addEventListener("contextmenu", event => event.preventDefault());
  root.addEventListener("dragstart", event => event.preventDefault());
});
