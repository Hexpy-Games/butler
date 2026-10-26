/** Button centers follow the titlebar height; native button diameter stays constant. */
export function scaledWindowButtonPosition(factor, base = { x: 20, y: 18 }) {
  return { x: Math.round(base.x * factor), y: Math.round((base.y + 7) * factor - 7) };
}
export function positionWindowButtons(window, factor, base) {
  if (process.platform === "darwin") window.setWindowButtonPosition(scaledWindowButtonPosition(factor, base));
}
