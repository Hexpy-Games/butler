/** Button centers follow the titlebar height; native button diameter stays constant. */
export function scaledWindowButtonPosition(factor, base = { x: 20, y: 18 }) {
  return { x: Math.round(base.x * factor), y: Math.round((base.y + 7) * factor - 7) };
}
export function positionWindowButtons(window, factor, base) {
  if (process.platform === "darwin") window.setWindowButtonPosition(scaledWindowButtonPosition(factor, base));
}

/** The macOS application menu supplies the standard Quit and Hide commands. */
export function appMenuPrefix() {
  return process.platform === "darwin" ? [{ role: "appMenu" }] : [];
}

export function usesTextSizeMenu(platform = process.platform) {
  return platform === "darwin";
}

/** Menu-less App windows handle Ctrl zoom keys before Chromium's native zoom. */
export function textSizeShortcut(input, platform = process.platform) {
  if (usesTextSizeMenu(platform) || input.type !== "keyDown" || !input.control || input.alt || input.meta) return;
  if (["=", "+"].includes(input.key) || input.code === "NumpadAdd") return "increase";
  if (input.key === "-" || input.code === "NumpadSubtract") return "decrease";
  if (input.key === "0" || input.code === "Numpad0") return "reset";
}
