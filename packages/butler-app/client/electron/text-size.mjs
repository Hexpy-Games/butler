import { ipcMain, screen, Menu, MenuItem } from "electron";
import { readStartupAppearance } from "./startup-appearance.mjs";
import { positionWindowButtons, appMenuPrefix, usesTextSizeMenu, textSizeShortcut } from "./butler-platform/text-size.mjs";

const factors = { default: 1, large: 1.15, larger: 1.3 };
const windows = new Map();
let selected;
let settingsContents;
const pendingShortcuts = [];

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
/** Replace native zoom roles too: on macOS, setting a null menu leaves NSApp's menu intact. */
export function installTextSizeMenu() {
  if (!usesTextSizeMenu()) {
    Menu.setApplicationMenu(null);
    return;
  }
  const items = [zoomItem("zoomin", "increase"), zoomItem("zoomout", "decrease"), zoomItem("resetzoom", "reset")];
  const equal = zoomItem("zoomin", "increase", "CommandOrControl+=");
  equal.visible = false;
  equal.acceleratorWorksWhenHidden = true;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...appMenuPrefix(), { role: "editMenu" }, { label: "View", submenu: [...items, equal] }, { role: "windowMenu" },
  ]));
}
function zoomItem(role, command, accelerator) {
  const item = new MenuItem({ role, id: `text-size-${role}${accelerator ? "-equal" : ""}`,
    ...(accelerator ? { accelerator } : {}) });
  const original = item.click;
  item.click = (event, window, contents) => {
    if (!dispatchTextSizeCommand(contents, command)) return original(event, window, contents);
  };
  return item;
}
export function dispatchTextSizeCommand(contents, command) {
  if (!contents || !windows.has(contents.id)) return false;
  if (settingsContents) settingsContents.send("butler:text-size-shortcut", command);
  else pendingShortcuts.push(command);
  return true;
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
  const contents = win.webContents;
  const id = contents.id;
  windows.set(id, { win, options });
  if (!Menu.getApplicationMenu()?.getMenuItemById("text-size-zoomin")) installTextSizeMenu();
  void contents.setVisualZoomLevelLimits(1, 1);
  contents.on("zoom-changed", event => event.preventDefault());
  if (!usesTextSizeMenu()) contents.on("before-input-event", (event, input) => {
    const command = textSizeShortcut(input);
    if (!command) return;
    event.preventDefault();
    dispatchTextSizeCommand(contents, command);
  });
  contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace && settingsContents === contents) settingsContents = undefined;
  });
  win.once("closed", () => {
    if (settingsContents === contents) settingsContents = undefined;
    windows.delete(id);
  });
}
ipcMain.handle("butler:set-text-size", (event, value) => {
  if (!windows.has(event.sender.id) || event.senderFrame !== event.sender.mainFrame) return;
  if (typeof value !== "string" || !Object.hasOwn(factors, value)) throw new Error("invalid_text_size");
  if (windows.get(event.sender.id).options.settings) {
    settingsContents = event.sender;
    for (const command of pendingShortcuts.splice(0)) settingsContents.send("butler:text-size-shortcut", command);
  }
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
