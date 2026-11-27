import { cdpMouse, insertText, routeTarget } from "./frame-input.mjs";
import { parseChord, sendChord } from "./keyboard.mjs";
import { nativeFrameWorld } from "./native-worlds.mjs";
import { setPhoneViewport } from "./agent.mjs";

const KEYS = new Set(["Backspace", "Delete", "Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Space"]);

export async function applyEvents(browser, tab, events) {
  let { width, height } = tab.view.getBounds();
  if (!width || !height) return { status: "refused", reason: "live_unavailable" };
  const send = cdpMouse(tab);
  const debuggerApi = tab.view.webContents.debugger;
  async function keyTarget() {
    for (const [frameId, sessionId] of tab.frameSessions) {
      const focused = await nativeFrameWorld(tab, frameId)?.executeJavaScriptInIsolatedWorld(9001, [{ code: 'document.hasFocus() && !/^i?frame$/u.test(document.activeElement?.localName ?? "")' }]).catch(() => false);
      if (focused === true) return routeTarget({}, { sessionId, api: { sendCommand: (m, p) => debuggerApi.sendCommand(m, p, sessionId) } });
    }
    return {};
  }
  let target = null;
  let heldPoint = null;
  batch: {
    for (const event of events) {
      if (tab.holder !== "user") break batch;
      const point = { x: Math.round(event.x * width), y: Math.round(event.y * height) };
      switch (event.t) {
        case "down":
          target = null;
          await send({ type: "mouseMove", ...point });
          if (heldPoint) heldPoint = point;
          if (tab.holder !== "user") break batch;
          await send({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
          heldPoint = point;
          break;
        case "move":
          await send({ type: "mouseMove", ...point, modifiers: ["leftButtonDown"] });
          if (heldPoint) heldPoint = point;
          break;
        case "up":
          await send({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
          heldPoint = null;
          break;
        case "wheel":
          await send({ type: "mouseWheel", ...point, deltaX: event.dx * width, deltaY: event.dy * height });
          if (heldPoint) heldPoint = point;
          break;
        case "text":
        case "key": {
          if (event.t === "key" && !KEYS.has(event.key)) return { status: "refused", reason: "live_unavailable" };
          target ??= await keyTarget();
          if (tab.holder !== "user") break batch;
          if (event.t === "text") await insertText(tab, target, event.value);
          else {
            await sendChord(tab, parseChord(event.key), target);
            target = null;
          }
          break;
        }
        case "viewport":
          setPhoneViewport(browser, tab, { width: event.width, height: event.height, dpr: event.dpr });
          ({ width, height } = tab.view.getBounds());
          if (!width || !height) return { status: "refused", reason: "live_unavailable" };
          break;
        default:
          return { status: "refused", reason: "live_unavailable" };
      }
    }
    return { status: "ok" };
  }
  if (heldPoint) await send({ type: "mouseUp", ...heldPoint, button: "left", clickCount: 1 });
  return { status: "refused", reason: "live_not_held" };
}
