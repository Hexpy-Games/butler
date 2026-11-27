import { cdpMouse, insertText, routeTarget } from "./frame-input.mjs";
import { parseChord, sendChord } from "./keyboard.mjs";

const KEYS = new Set(["Backspace", "Delete", "Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Space"]);

export async function applyEvents(tab, feed, events) {
  const { width, height } = tab.view.getBounds();
  if (!width || !height) return { status: "refused", reason: "live_unavailable" };
  const send = cdpMouse(tab);
  const debuggerApi = tab.view.webContents.debugger;
  async function keyTarget() {
    if (feed.keyTarget) return feed.keyTarget;
    for (const sessionId of tab.frameSessions.values()) {
      const api = { sendCommand: (method, params) => debuggerApi.sendCommand(method, params, sessionId) };
      const focused = await api.sendCommand("Runtime.evaluate", { expression: "document.hasFocus()", returnByValue: true }).catch(() => null);
      if (focused?.result?.value === true) return feed.keyTarget = routeTarget({}, { sessionId, api });
    }
    return feed.keyTarget = {};
  }
  for (const event of events) {
    if (tab.holder !== "user") return { status: "refused", reason: "live_not_held" };
    const point = { x: Math.round(event.x * width), y: Math.round(event.y * height) };
    switch (event.t) {
      case "down":
        feed.keyTarget = null;
        await send({ type: "mouseMove", ...point });
        if (tab.holder !== "user") return { status: "refused", reason: "live_not_held" };
        await send({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
        break;
      case "move":
        await send({ type: "mouseMove", ...point, modifiers: ["leftButtonDown"] });
        break;
      case "up":
        await send({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
        break;
      case "wheel":
        await send({ type: "mouseWheel", ...point, deltaX: event.dx * width, deltaY: event.dy * height });
        break;
      case "text":
      case "key": {
        if (event.t === "key" && !KEYS.has(event.key)) return { status: "refused", reason: "live_unavailable" };
        const target = await keyTarget();
        if (tab.holder !== "user") return { status: "refused", reason: "live_not_held" };
        if (event.t === "text") await insertText(tab, target, event.value);
        else await sendChord(tab, parseChord(event.key), target);
        break;
      }
      default:
        return { status: "refused", reason: "live_unavailable" };
    }
  }
  return { status: "ok" };
}
