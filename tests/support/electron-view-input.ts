import type { ShellApp } from "./browser-shell-acceptance";
import { waitBrowser } from "./browser-agent-app";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export async function pageShownBeforeNativeInput(app: ShellApp, contents: string) {
  // Poll from outside the page: hidden documents can suspend rAF indefinitely.
  // Each document/visibility transition must get its own two frame callbacks.
  const code = `(()=>{
    if (!globalThis.nativeInputPresentation) {
      const state=globalThis.nativeInputPresentation={generation:0,ready:false};
      const changed=()=>{
        const generation=++state.generation;state.ready=false;
        if(document.visibilityState==='visible') requestAnimationFrame(()=>requestAnimationFrame(()=>{
          if(state.generation===generation && document.visibilityState==='visible') state.ready=true;
        }));
      };
      document.addEventListener('visibilitychange',changed);changed();
    }
    return document.visibilityState==='visible' && globalThis.nativeInputPresentation.ready;
  })()`;
  try {
    await waitBrowser(() => app.main(`${contents}.executeJavaScriptInIsolatedWorld(9002,[{code:${JSON.stringify(code)}}])`), "page shown before native input");
  } catch (error) {
    const expression = app.lastMain();
    const presentation = await nativeInputPresentation(app, contents).catch(diagnosticError => ({ error: String(diagnosticError) }));
    const evidence = process.env.BUTLER_BROWSER_EVIDENCE;
    const failure: Record<string, unknown> = { expression, presentation };
    const record = () => {
      if (evidence) writeFileSync(join(evidence, "native-input-failure.json"), JSON.stringify(failure, null, 2));
    };
    // Persist the untouched failure before even inspecting other windows or trying remedies.
    try {
      record();
      failure.environment = await nativeInputEnvironment(app);
      record();
      await nativeInputRemedies(app, contents, failure, record);
    } catch (diagnosticError) {
      failure.diagnosticError = String(diagnosticError);
      try { record(); }
      catch (recordError) { console.error("Could not record native input diagnostics:", recordError); }
    }
    throw error;
  }
}

/** Read only on failure; never capture or toggle a wedged view before recording it. */
async function nativeInputPresentation(app: ShellApp, contents: string) {
  return app.main(`(async()=>{
    const contents=${contents}, browser=globalThis.browserAgentSubject;
    const tab=[...browser.tabs.values()].find(t=>t.view?.webContents===contents);
    if(!tab) return {destroyed:contents.isDestroyed(),tabFound:false};
    const win=tab.popupWindow??browser.getWindow(), attached=tab.attached;
    const windowState=w=>w&&!w.isDestroyed()?{id:w.id,visible:w.isVisible(),focused:w.isFocused(),bounds:w.getBounds()}:null;
    return {id:tab.id,status:tab.status,covered:tab.covered,dialog:tab.dialog?.type??null,
      nativeCovers:browser.nativeCovers,areaVisible:browser.areaVisible,active:browser.activeId===tab.id,
      attached:windowState(attached),window:windowState(win),child:!!attached?.contentView.children.includes(tab.view),
      slot:tab.slot,bounds:tab.view.getBounds(),viewVisible:tab.view.getVisible(),
      attachWait:!!tab.attachWait,placeHold:!!tab.placeHold,capture:!!tab.capture,
      captures:[...tab.captures?.values()??[]].map(startedHidden=>({startedHidden})),
      backgroundThrottling:contents.getBackgroundThrottling(),beingCaptured:contents.isBeingCaptured(),
      page:await contents.executeJavaScriptInIsolatedWorld(9002,[{code:
        "({visibility:document.visibilityState,readyState:document.readyState,presentation:globalThis.nativeInputPresentation??null})"}])};
  })()`);
}

/** Failure-only inventory: keep display coordinates and window ordering intact. */
async function nativeInputEnvironment(app: ShellApp) {
  const root = resolve(process.env.BUTLER_SMOKE_ELECTRON_APP ?? "packages/butler-app/client/electron");
  return app.main(`(() => {
    const {BrowserWindow,screen}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(root, "package.json"))})('electron');
    return {windows:BrowserWindow.getAllWindows().map(w=>({id:w.id,visible:w.isVisible(),
      focused:w.isFocused(),bounds:w.getBounds(),isVisibleOnAllWorkspaces:w.isVisibleOnAllWorkspaces(),
      displayId:screen.getDisplayMatching(w.getBounds()).id})),displays:screen.getAllDisplays(),
      electron:process.versions.electron,chrome:process.versions.chrome,argv:process.argv};
  })()`);
}

async function nativeInputRemedies(app: ShellApp, contents: string, failure: Record<string, unknown>, record: () => void) {
  const page = () => app.main<any>(`${contents}.executeJavaScriptInIsolatedWorld(9002,[{code:${JSON.stringify(`(() => {
    if (!globalThis.nativeInputVisibilityDiagnostic) {
      const events=globalThis.nativeInputVisibilityDiagnostic=[];
      document.addEventListener('visibilitychange',()=>events.push({visibility:document.visibilityState,at:performance.now()}));
    }
    return {visibility:document.visibilityState,presentation:globalThis.nativeInputPresentation??null,
      events:[...globalThis.nativeInputVisibilityDiagnostic]};
  })()`)} }])`);
  const remedies: unknown[] = [];
  failure.remedies = remedies;
  for (const action of ["view-visible", "reattach", "invalidate", "window-bounds", "window-show-inactive", "window-focus"]) {
    const result: Record<string, any> = { action };
    remedies.push(result);
    try {
      result.before = await page();
      try { await app.main(`(${nativeInputRemedy.toString()})(${contents},${JSON.stringify(action)})`); }
      catch (error) { result.actionError = String(error); }
      // Poll outside the renderer, just like the presentation wait: hidden pages suspend rAF.
      // This bounded observation is diagnostic only; recovery never turns the failure green.
      const deadline = Date.now() + 500;
      do {
        result.after = await page();
        if (result.after.events.length > result.before.events.length) break;
        await new Promise(done => setTimeout(done, 100));
      } while (Date.now() < deadline);
      result.visibilityChanged = result.after.events.length > result.before.events.length;
    } catch (error) { result.error = String(error); }
    record();
  }
}

/** Serialized only after the original failure has been written. Preserve child order. */
function nativeInputRemedy(contents: any, action: string) {
  const browser = (globalThis as any).browserAgentSubject;
  const tab = [...browser.tabs.values()].find((t: any) => t.view?.webContents === contents) as any;
  if (!tab?.attached || tab.attached.isDestroyed()) throw new Error("No attached window for diagnostic remedy");
  const win = tab.attached, view = tab.view;
  if (action === "view-visible") { view.setVisible(false); view.setVisible(true); }
  else if (action === "reattach") {
    const index = win.contentView.children.indexOf(view);
    win.contentView.removeChildView(view); win.contentView.addChildView(view, index);
  } else if (action === "invalidate") contents.invalidate();
  else if (action === "window-bounds") win.setBounds(win.getBounds());
  else if (action === "window-show-inactive") win.showInactive();
  else if (action === "window-focus") win.focus();
}

type Point = { x: number; y: number };

/** Content DIP coordinates routed through the native view stack. DOM pointer
 * capture keeps cross-view gestures in their origin until release or detachment.
 * HTML5 drags use Chromium's intercepted data, never fabricated product payloads.
 */
export function electronViewInput(app: ShellApp) {
  const state = "globalThis[Symbol.for('butler.smoke.view-input')]";
  const ready = app.main(`(${install.toString()})(${app.win})`);
  const send = async (type: string, point: Point, extra: Record<string, unknown> = {}) => {
    await ready;
    await app.main(`${state}.send(${JSON.stringify({ type, ...point, ...extra })})`);
  };
  return async (action: string, from: Point, to?: Point | string) => {
    await ready;
    await app.main(`${state}.activate()`);
    if (action === "key") {
      await app.main(`${state}.key(${JSON.stringify(to)})`);
      return;
    }
    const modifiers = action === "altdrag" ? 1 : 0;
    if (action === "up") { await send("mouseReleased", from, { button: "left", buttons: 0, clickCount: 1 }); return; }
    if (action === "dragmove") { await send("mouseMoved", from, { button: "left", buttons: 1 }); return; }
    await send("mouseMoved", from, { buttons: 0, modifiers });
    if (action === "move") return;
    if (action === "wheel") { await send("mouseWheel", from, { deltaX: 0, deltaY: 300 }); return; }
    const button = action === "right" ? "right" : "left", buttons = button === "right" ? 2 : 1;
    for (let clickCount = 1; clickCount <= (action === "double" ? 2 : 1); clickCount++) {
      await send("mousePressed", from, { button, buttons, clickCount, modifiers });
      if (action === "down") return;
      try {
        if (action === "drag" || action === "altdrag") {
          if (!to || typeof to === "string") throw new Error("Drag destination required");
          for (let step = 1; step <= 24; step++) {
            await send("mouseMoved", { x: from.x + (to.x - from.x) * step / 24, y: from.y + (to.y - from.y) * step / 24 }, { button, buttons, modifiers });
            await new Promise(done => setTimeout(done, 20));
          }
        }
      } finally {
        await send("mouseReleased", typeof to === "object" ? to : from, { button, buttons: 0, clickCount, modifiers });
      }
    }
  };
}

/** Serialized into the main inspector. Only Electron and DOM input APIs are used. */
function install(win: any) {
  const attached = new Set<any>();
  let pressed: any, drag: any, dragTarget: any;
  const contains = (b: any, p: Point) => p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height;
  const views = () => {
    const result: any[] = [];
    const visit = (view: any, origin: Point) => {
      if (!view.getVisible()) return;
      const b = view.getBounds(), at = { x: origin.x + b.x, y: origin.y + b.y };
      if (view.webContents && !view.webContents.isDestroyed()) result.push({ contents: view.webContents, ...at, width: b.width, height: b.height });
      for (const child of view.children) visit(child, at);
    };
    for (const child of win.contentView.children) visit(child, { x: 0, y: 0 });
    const b = win.getContentBounds();
    return [{ contents: win.webContents, x: 0, y: 0, width: b.width, height: b.height }, ...result];
  };
  const connect = async (contents: any) => {
    if (attached.has(contents)) return;
    if (contents.debugger.isAttached()) throw new Error("Input target already has a debugger");
    contents.debugger.attach("1.3");
    attached.add(contents);
    contents.debugger.on("message", (_event: unknown, method: string, params: any) => {
      if (method === "Input.dragIntercepted") drag = params.data;
    });
    await contents.debugger.sendCommand("Input.setInterceptDrags", { enabled: true });
    const source = `(() => {
      const state = { pointer: null, captured: false };
      globalThis[Symbol.for('butler.smoke.pointer-capture')] = state;
      document.addEventListener('pointerdown', event => state.pointer = event.pointerId, true);
      document.addEventListener('gotpointercapture', () => state.captured = true, true);
      document.addEventListener('lostpointercapture', () => state.captured = false, true);
    })()`;
    await contents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source });
    await contents.debugger.sendCommand("Runtime.evaluate", { expression: source });
  };
  const captured = async () => {
    if (!pressed || pressed.contents.isDestroyed()) return false;
    const result = await pressed.contents.debugger.sendCommand("Runtime.evaluate", {
      // hasPointerCapture includes a pending capture before gotpointercapture.
      expression: "(() => {const s=globalThis[Symbol.for('butler.smoke.pointer-capture')];return s?.captured || s?.pointer != null && [...document.querySelectorAll('*')].some(n=>n.hasPointerCapture(s.pointer))})()", returnByValue: true,
    });
    return result.result.value === true;
  };
  const state = {
    activate() {
      const focused = views().findLast(v => v.contents.isFocused())?.contents;
      win.show(); win.focus(); win.moveTop();
      focused?.focus();
    },
    async send(event: any) {
      const stack = views();
      for (const view of stack) await connect(view.contents);
      const hit = stack.findLast(view => contains(view, event));
      if (!hit) throw new Error(`No WebContents under ${event.x}, ${event.y}`);
      // A detached view loses native capture, exposing the view below it.
      const origin = stack.find(v => v.contents === pressed?.contents);
      const target = !drag && origin && await captured() ? origin : hit;
      const params = { ...event, x: (event.x - target.x) / target.contents.getZoomFactor(), y: (event.y - target.y) / target.contents.getZoomFactor() };
      if (drag && ["mouseMoved", "mouseReleased"].includes(event.type)) {
        const send = (type: string) => target.contents.debugger.sendCommand("Input.dispatchDragEvent", { type, x: params.x, y: params.y, data: drag, modifiers: event.modifiers ?? 0 });
        if (dragTarget !== target.contents) { await send("dragEnter"); dragTarget = target.contents; }
        await send("dragOver");
        if (event.type === "mouseReleased") { await send("drop"); drag = undefined; dragTarget = undefined; pressed = undefined; }
        return;
      }
      if (event.type === "mousePressed") { pressed = target; target.contents.focus(); }
      await target.contents.debugger.sendCommand("Input.dispatchMouseEvent", params);
      if (event.type === "mouseReleased") pressed = undefined;
    },
    // Keys enter like a real keystroke: through the browser process, where `before-input-event`
    // sees them first (pick mode and shortcuts handle keys there). CDP Input.dispatchKeyEvent
    // reaches the page DOM without that event, so the App never sees the key.
    async key(key: string) {
      const codes: Record<string, string> = { Enter: "Enter", Escape: "Escape", ArrowUp: "Up" };
      if (!codes[key]) throw new Error(`Unsupported key: ${key}`);
      const target = views().findLast(v => v.contents.isFocused());
      if (!target) {
        const targets = await Promise.all(views().map(async ({ contents }) => ({
          id: contents.id, focused: contents.isFocused(), zoom: contents.getZoomFactor(),
          visibility: await contents.executeJavaScript("document.visibilityState").catch(() => null),
        })));
        throw new Error(`No focused WebContents for key input: ${JSON.stringify(targets)}`);
      }
      // Enter also types its character, as the keystroke does.
      for (const type of ["keyDown", ...(key === "Enter" ? ["char"] : []), "keyUp"]) target.contents.sendInputEvent({ type, keyCode: codes[key] });
    },
  };
  (globalThis as any)[Symbol.for("butler.smoke.view-input")] = state;
}
