import { cdpMouse, insertText, routeTarget } from "./frame-input.mjs";
import { parseChord, sendChord } from "./keyboard.mjs";
import { nativeFrameWorld } from "./native-worlds.mjs";
import { setPhoneViewport } from "./agent.mjs";

const KEYS = new Set(["Backspace", "Delete", "Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Space"]);

const FOCUSED = 'document.hasFocus() && !/^i?frame$/u.test(document.activeElement?.localName ?? "")';
const REVEAL = `(() => { let el = document.activeElement; while (el?.contentDocument?.activeElement) el = el.contentDocument.activeElement;
  if (el?.isContentEditable || /^(input|textarea)$/u.test(el?.localName ?? "")) el.scrollIntoView({ block: "center", inline: "nearest" }); return true; })()`;

/** The out-of-process frame that has keyboard focus (its CDP session and preload world), or null: the page's own process. */
async function focusedFrame(tab) {
  for (const [frameId, sessionId] of tab.frameSessions) {
    const world = nativeFrameWorld(tab, frameId);
    if (await world?.executeJavaScriptInIsolatedWorld(9001, [{ code: FOCUSED }]).catch(() => false) === true) return { sessionId, world };
  }
  return null;
}

/** Once the page has taken a shorter viewport (≤ 500 ms), scrolls the focused text field to its middle: the phone keyboard opened over the rest. */
async function revealFocus(tab, height) {
  const page = tab.view.webContents;
  await page.executeJavaScriptInIsolatedWorld(9001, [{ code: `innerHeight === ${Number(height)} || new Promise(done => { addEventListener("resize", () => done(true), { once: true }); setTimeout(() => done(false), 500); })` }]);
  const frame = await focusedFrame(tab);
  await (frame?.world ?? page).executeJavaScriptInIsolatedWorld(9001, [{ code: REVEAL }]);
}

export async function applyEvents(browser, tab, events) {
  let { width, height } = tab.view.getBounds();
  if (!width || !height) return { status: "refused", reason: "live_unavailable" };
  const send = cdpMouse(tab);
  const debuggerApi = tab.view.webContents.debugger;
  async function keyTarget() {
    const frame = await focusedFrame(tab);
    return frame ? routeTarget({}, { sessionId: frame.sessionId, api: { sendCommand: (m, p) => debuggerApi.sendCommand(m, p, frame.sessionId) } }) : {};
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
        case "viewport": {
          if (!browser.phoneLive.feeds.has(tab.id)) break batch;
          const previous = tab.phoneViewport;
          setPhoneViewport(browser, tab, { width: event.width, height: event.height, dpr: event.dpr });
          ({ width, height } = tab.view.getBounds());
          if (!width || !height) return { status: "refused", reason: "live_unavailable" };
          if (previous?.width === event.width && event.height < previous.height) void revealFocus(tab, event.height).catch(() => {});
          break;
        }
        default:
          return { status: "refused", reason: "live_unavailable" };
      }
    }
    return { status: "ok" };
  }
  if (heldPoint) await send({ type: "mouseUp", ...heldPoint, button: "left", clickCount: 1 });
  return { status: "refused", reason: "live_not_held" };
}
