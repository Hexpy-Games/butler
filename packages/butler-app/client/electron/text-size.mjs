import { ipcMain, screen } from "electron";
import { readStartupAppearance } from "./startup-appearance.mjs";
import { positionWindowButtons } from "./butler-platform/text-size.mjs";

const factors = { default: 1, large: 1.15, larger: 1.3 };
const windows = new Map();
let selected;

export function currentTextSize() {
  if (!selected) {
    const value = readStartupAppearance().textSize;
    selected = Object.hasOwn(factors, value) ? value : "default";
  }
  return selected;
}
export function appZoomFactor() { return factors[currentTextSize()]; }
export function textSizePreferences() {
  return { zoomFactor: appZoomFactor(), additionalArguments: [`--butler-text-size=${currentTextSize()}`] };
}
function updateWindow(win, options) {
  const factor = appZoomFactor();
  win.webContents.setZoomFactor(factor);
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  if (options.minimum) win.setMinimumSize(Math.min(Math.ceil(options.minimum[0] * factor), area.width),
    Math.min(Math.ceil(options.minimum[1] * factor), area.height));
  if (options.buttons) positionWindowButtons(win, factor, options.buttons);
  if (options.lifecycle) {
    const [width, height] = win.getContentSize();
    win.setContentSize(Math.ceil(width / options.factor * factor), Math.ceil(height / options.factor * factor));
    options.factor = factor;
  }
  win.webContents.send("butler:text-size", factor);
}
/** Only registered App surfaces can change App zoom; web page and frame senders cannot. */
export function registerTextSizeWindow(win, options = {}) {
  options.factor = appZoomFactor();
  windows.set(win.webContents.id, { win, options });
  win.once("closed", () => windows.delete(win.webContents.id));
}
ipcMain.handle("butler:set-text-size", (event, value) => {
  if (!windows.has(event.sender.id) || event.senderFrame !== event.sender.mainFrame) return;
  if (typeof value !== "string" || !Object.hasOwn(factors, value)) throw new Error("invalid_text_size");
  if (selected === value) return;
  selected = value;
  for (const { win, options } of windows.values()) updateWindow(win, options);
});

/** DOM geometry crosses into native DIPs once, before browser layout consumes it. */
export function nativeAppBounds(contents, bounds, fixedViewport = false) {
  if (!bounds || typeof bounds !== "object") return bounds;
  const zoom = contents.getZoomFactor();
  const result = { ...bounds };
  for (const key of ["x", "y", "width", "height", "radius"])
    if (Number.isFinite(result[key])) result[key] *= zoom;
  if (fixedViewport && Number.isFinite(result.scale)) result.scale *= zoom;
  return result;
}
