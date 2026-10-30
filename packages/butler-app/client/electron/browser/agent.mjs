import { browserEvent, drainEvents } from "./events.mjs";
import { randomUUID } from "node:crypto";
import { startUse, endUse, finishUse, tabInUse, bindUse, releaseHold, pauseHold } from "./usage.mjs";
import { noteNativeContext } from "./native-worlds.mjs";
import { wireDialogs, pendingDialog, answerDialog, requestClose, resolveDialog } from "./dialogs.mjs";
import { BrowserWindow } from "electron";
import { guardUrl, installNavigationGuard } from "./guard.mjs";
import { agentPopupAllowed } from "./popup-policy.mjs";
import { observeTab } from "./observe.mjs";
import { readTab } from "./reader-render.mjs";
import { prepareBatch, actBatch } from "./act.mjs";
import { screenshotTab, collectImage } from "./capture.mjs";
import { zoomTab } from "./zoom.mjs";
import { applySignedInPolicy, revokeSignedInSite, signedInPlace } from "./signed-in.mjs";
import { fillSignIn } from "./signin-fill.mjs";
import { fillPay, inspectPay } from "./pay-fill.mjs";
import { makeAgentRoom } from "./capacity.mjs";
import { DEVTOOLS_OPS, devtoolsCall, noteUserHold, onLocalPage, watchDevtools } from "./devtools.mjs";
import { attachView } from "./view-capture.mjs";

export function controlTab(browser, tab, holder, sticky = false) {
  if (!tab || tab.owner === "mine") return;
  // A pop-up the user took somewhere Butler may not go closes instead of returning.
  if (holder === "agent" && tab.opener && tab.holder === "user" && tab.url && !agentPopupAllowed(tab.policy ?? {}, tab.popupParentUrl, tab.url)) { browser.close(tab.id); return; }
  if (holder === "user") { if (tab.holder === "agent") pauseHold(browser, tab); releaseHold(browser, tab); hearTab(tab); noteUserHold(tab); } else tab.pausedTurns = null;
  if (tab.dialog) void resolveDialog(browser, tab, { accept: false }, "control_changed");
  tab.holder = holder; tab.sticky = sticky; tab.epoch++; tab.observation = null; tab.waiting = Boolean(tab.dialog);
  if (holder === "agent") { tab.signinStep = null; tab.payStep = null; }
  browser.publish();
}
/** A tab Butler opened plays sound from the user's first takeover until it closes. */
export function hearTab(tab) {
  if (!tab.muted) return;
  tab.muted = false;
  if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.setAudioMuted(false);
}
export function wireAgentTab(browser, tab) {
  const contents = tab.view.webContents;
  // A new document can get a new page widget without the emulated metrics, and
  // the page would then perceive the pane's size: every committed document
  // gets them again, wherever the tab is attached.
  contents.on("did-finish-load", () => { tab.loaded = true; emulation(tab); });
  contents.on("dom-ready", () => emulation(tab));
  contents.setBackgroundThrottling(false);

  contents.on("did-frame-navigate", () => { tab.epoch++; tab.observation = null; browser.publish(); });
  contents.on("did-navigate-in-page", () => { tab.epoch++; tab.observation = null; browser.publish(); });
  // A new top-level page holds no field Butler filled from a saved item.
  contents.on("did-navigate", () => { tab.vaultFilled = false; emulation(tab); });
  const takeover = input => {
    if (!tab.expectedInputs?.some(expected => expected.type === input.type && (expected.x === undefined || expected.x === input.x && expected.y === input.y)) && tab.holder === "agent" && ["mouseDown", "keyDown"].includes(input.type)) controlTab(browser, tab, "user");
  };
  contents.on("input-event", (_event, input) => takeover(input));
  contents.on("before-input-event", (event, input) => {
    if (tab.holder === "agent" && (tab.busy || tabInUse(browser, tab)) && !tab.expectedInputs?.some(expected => expected.type === input.type)) event.preventDefault();
    else takeover(input);
  });
  watchDevtools(tab);
  installNavigationGuard(tab, popupUrl => {
    if (popupUrl) browserEvent(browser, tab, "popup_blocked", { url: popupUrl, reason: "popup_policy" });
    tab.epoch++; tab.observation = null; tab.policyViolation = true; contents.stop();
    // The user's own handed-over page is fenced back to them, never closed.
    if (tab.agent) browser.close(tab.id); else controlTab(browser, tab, "user", true);
  });
}
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true };
/** CDP serves only Butler's own automation of a tab; its identity never needs it. */
export function connectDebugger(browser, tab) {
  const contents=tab.view.webContents;
  if (tab.debuggerReady) return;
  if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
  wireDialogs(browser,tab);
  tab.frameSessions=new Map();tab.frameAttachPromises=new Map();
  contents.debugger.on("message",(_event,method,value,sessionId)=>{
    noteNativeContext(tab,method,value,sessionId);
    if (method === "Target.attachedToTarget") void contents.debugger.sendCommand("Target.setAutoAttach", AUTO_ATTACH, value.sessionId).catch(() => {});
    if(method==="Target.attachedToTarget" && value.targetInfo.type==="iframe") {
      const ready=(async()=>{
        await contents.debugger.sendCommand("Page.enable",{},value.sessionId);
        const {frameTree}=await contents.debugger.sendCommand("Page.getFrameTree",{},value.sessionId);
        tab.frameSessions.set(frameTree.frame.id,value.sessionId);
        await contents.debugger.sendCommand("Runtime.enable",{},value.sessionId);
      })();
      tab.frameAttachPromises.set(value.sessionId,ready);void ready.catch(()=>{});
    }
    if(method==="Target.detachedFromTarget") {tab.frameAttachPromises.delete(value.sessionId);for(const [id,session] of tab.frameSessions)if(session===value.sessionId)tab.frameSessions.delete(id);}
  });
  // A view Butler created has no renderer until its first load, and renderer-scoped
  // commands need one. A pop-up's view is already opening its own page. Loads wait
  // for the web identity, so decide only once it is ready: a page queued behind it
  // has started by then and must not be raced by a blank load.
  const renderer = tab.identityReady.then(() => contents.getURL() || contents.isLoading() || tab.opener ? undefined : contents.loadURL("about:blank"));
  tab.debuggerReady = renderer.then(() => contents.debugger.sendCommand("Target.setAutoAttach", AUTO_ATTACH))
    .then(() => contents.debugger.sendCommand("Runtime.enable"));
  void tab.debuggerReady.then(() => contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled",{enabled:true})).catch(()=>{});
}
export function emulation(tab) {
  if (!tab.agent || !tab.view || !tab.loaded) return;
  const scale = tab.bounds?.scale ?? 1;
  tab.view.webContents.enableDeviceEmulation({ screenPosition: "desktop", screenSize: { width: 1280, height: 800 },
    viewSize: { width: 1280, height: 800 }, deviceScaleFactor: 1, viewPosition: { x: 0, y: 0 }, scale });
}
export function backgroundTab(browser, tab) {
  if (tab.agent) viewedTab(browser, tab, false);
  if (!tab.agent && !tab.driven || !tab.view || tab.attached || tab.status === "crashed") return;
  if (!browser.agentWindow || browser.agentWindow.isDestroyed()) {
    browser.agentWindow = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  }
  // Hidden agent pages use the full logical viewport, not the last pane's
  // scale (which can be zero while its slot unmounts). Tools and frames share it.
  if (tab.agent) tab.bounds = { x: 0, y: 0, width: 1280, height: 800, scale: 1, visible: false };
  attachView(tab, browser.agentWindow, -1, () => {
    tab.view.setBounds({ x: 0, y: 0, width: tab.agent ? 1280 : Math.round(tab.bounds?.width ?? 1280), height: tab.agent ? 800 : Math.round(tab.bounds?.height ?? 800) }); emulation(tab);
  }, () => { if (browser.tabs.get(tab.id) === tab) browser.sync(tab); });
}
function armExpiry(browser, tab) {
  if (!tab.agent || tab.owner === "mine" || tab.userViewed) {clearTimeout(tab.expiry);tab.expiry=null;return;}
  if (tab.expiry) return;
  const remaining=Math.max(0,10*60*1000-(Date.now()-(tab.lastAgentCall ?? Date.now())));
  tab.expiry = setTimeout(() => browser.close(tab.id), remaining);
}
function touch(browser, tab) {
  tab.lastAgentCall=Date.now();clearTimeout(tab.expiry);tab.expiry=null;
  armExpiry(browser,tab);
}
export function viewedTab(browser, tab, visible) {
  tab.viewed = visible;
  if(visible) tab.userViewed=true;
  armExpiry(browser, tab);
}
export async function executeBrowser(browser, frame) {
  if (frame.op === "preview.closed") {
    for (const tab of [...browser.tabs.values()]) if (tab.owner === `conversation:${frame.session}` && tab.preview === frame.args.preview_id) browser.close(tab.id);
    return { status: "ok" };
  }
  if (frame.op === "use.started") { startUse(browser, frame); return; }
  if (frame.op === "use.ended") { endUse(browser, frame.args.id, frame.args.abort); return; }
  if (frame.op === "use.revoked") {
    const tab = browser.tabs.get(frame.tab);
    if (tab?.owner === `conversation:${frame.session}`) { if (tab.agent) browser.close(frame.tab); else controlTab(browser, tab, "user", true); }
    return;
  }
  if (frame.op === "use.signin_revoked") { if (typeof frame.args?.site === "string") revokeSignedInSite(browser, frame.args.site, controlTab); return; }
  if (frame.op === "use.finished") { finishUse(browser, frame.session, frame.turn_id, frame.args?.close_read_tabs === true); return; }
  const tracked = ["tab.open", "tab.observe", "tab.read", "tab.zoom", "tab.screenshot", "tab.image_collect", "tab.devtools_place", "tab.devtools", "tab.prepare", "tab.act", "tab.dialog", "tab.close", "signin.fill", "pay.inspect", "pay.fill", "autofill.fill"].includes(frame.op);
  // Direct main-only harness calls have no gateway id, but use the same lifetime.
  if (tracked && !frame.id) { frame = { ...frame, id: randomUUID() }; startUse(browser, frame); }
  try { return await executeCall(browser, frame, tracked); }
  finally { if (tracked) endUse(browser, frame.id); }
}
async function executeCall(browser, frame, tracked) {
  const result = tracked && !browser.uses.has(frame.id) ? { status: "unknown", reason: "cancelled" } : await executeFrame(browser, frame);
  const count = frame.op === "tab.act" ? frame.args?.steps?.length : 0;
  if (count >= 1 && count <= 10 && !Array.isArray(result.steps) && result.status !== "dialog_pending") {
    const status = result.status === "unknown" ? "unknown" : "not_dispatched";
    result.steps = Array.from({length: count}, (_, index) => ({index, status, reason: result.reason ?? "browser_refused"}));
    if (status === "unknown") result.observe_required = true;
  }
  return drainEvents(browser, frame, result);
}
async function executeFrame(browser, frame) {
  if (browser.disposing || !browser.enabled()) return { status: "refused", reason: "browsing_disabled" };
  const { op, session, args = {} } = frame;
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(session ?? "")) return { status: "refused", reason: "invalid_session" };
  const owner = `conversation:${session}`;
  if (op === "tabs.list") return { tabs: browser.snapshot().tabs.filter(tab => tab.owner === owner).map(({ saveOffer: _offer, agentAt: _at, ...tab }) => tab) };
  if (op === "owner.closed") {
    for (const tab of [...browser.tabs.values()]) if (tab.owner === owner) browser.close(tab.id);
    browser.events?.delete(owner); return { status: "ok" };
  }
  if (op === "tab.open") return openAgent(browser, frame);
  const tab = browser.tabs.get(frame.tab);
  if (!tab || tab.closeDrain || tab.owner !== owner) return { status: "refused", reason: "not_your_tab" };
  if (INTERACTIONS.has(op)) tab.acted = true;
  if (op === "tab.selection") return browser.selection.result(tab, session);
  // A loopback page is read where it is: never driven, whoever holds the tab.
  if (DEVTOOLS_OPS.has(op) && onLocalPage(tab)) return tab.dialog && op === "tab.devtools" && args.read === "dom" ? pendingDialog(tab) : devtoolsCall(tab, op, args);
  if (tab.profile === "signed_in" && !["tab.cancel", "tab.wait", "tab.waiting"].includes(op) && !applySignedInPolicy(tab, args.policy))
    return { status: "not_dispatched", reason: args.policy?.mode === "signed_in" ? "navigation_denied" : "signed_in_unavailable" };
  if (op === "tab.cancel") { if (tab.callId === args.call_id) tab.cancelled = true; return { status: "ok" }; }
  // A durable wait hands the tab to the user (as a sign-in step does); only their hand-back resumes it.
  if (op === "tab.wait") {
    if (!tab.dialog && tab.holder !== "user") controlTab(browser, tab, "user", true);
    tab.waitingTurn = frame.turn_id; tab.waiting = Boolean(tab.dialog) || tab.holder === "user"; browser.publish();
    return { status: tab.holder === "user" ? "user_control" : "ready", tab: tab.id, epoch: tab.epoch };
  }
  if (op === "tab.waiting") { tab.waitingTurn = frame.turn_id; tab.waiting = Boolean(tab.dialog) || args.value === true; browser.publish(); return { status: "ok" }; }
  if (tab.holder === "user") return { status: "not_dispatched", reason: "user_control" };
  if (op === "tab.close") return requestClose(browser,tab);
  if (op === "tab.dialog") return answerDialog(browser,tab,args,frame.deliverStill);
  if (tab.dialog) return pendingDialog(tab);
  touch(browser, tab);
  browser.pointer.action(tab, frame.pointer);
  if (!tab.view || tab.status === "crashed") return { status: "unknown", reason: "tab_crashed" };
  if (!tab.agent && !tab.driven) {
    tab.policy=args.policy ?? {};
    if (!await guardUrl(tab.url,tab.view.webContents.session,tab.policy)) return {status:"not_dispatched",reason:"navigation_denied"};
    if (!makeAgentRoom(browser, tab)) return {status:"not_dispatched",reason:"tab_budget_exhausted"};
    tab.driven=true;tab.onPointer=(step,target)=>browser.pointer.step(tab,step,target);tab.loaded=!tab.view.webContents.isLoading();
    wireAgentTab(browser,tab);backgroundTab(browser,tab);
    await new Promise(resolve=>setTimeout(resolve,0));
    connectDebugger(browser,tab);emulation(tab);browser.publish();
  }
  if (!browser.uses.has(frame.id)) return { status: "unknown", reason: "cancelled" };
  if (op === "tab.observe") return observeTab(tab, args);
  if (op === "tab.read") return readTab(tab);
  if (DEVTOOLS_OPS.has(op)) return devtoolsCall(tab, op, args);
  if (op === "tab.image_collect") return collectImage(tab, args);
  if (op === "tab.screenshot") return screenshotTab(tab, args);
  if (op === "tab.zoom") return zoomTab(tab, args);
  if (op === "tab.prepare") return prepareBatch(tab, args);
  if (op === "signin.fill") return fillSignIn(browser, tab, args, controlTab);
  if (op === "pay.inspect") return inspectPay(browser, tab, args, controlTab);
  if (op === "pay.fill" || op === "autofill.fill") return fillPay(browser, tab, args, controlTab);
  if (op === "tab.act") {
    // Tabs act independently; only a second batch on a tab whose batch still runs is refused.
    if (tab.busy) return { status: "not_dispatched", reason: "browser_busy" };
    tab.busy = true; tab.cancelled = false; tab.callId = frame.call_id; browser.publish();
    try {
      tab.activeAct = actBatch(tab, { ...args, deliveryId: frame.id, deliverStill: frame.deliverStill, deadline_ms: frame.deadline_ms }, session);
      return await tab.activeAct;
    } finally { tab.activeAct = null; tab.busy = false; browser.publish(); }
  }
  return { status: "refused", reason: "unsupported_op" };
}
// Resolves once the new document is parsed (or fully loaded, if that comes
// first). Images and late scripts finish while the model reads the result;
// the next observation settles a page that is still loading.
function parsed(contents, url) {
  const loading = contents.loadURL(url);
  const ready = new Promise(resolve => contents.once("dom-ready", resolve));
  void loading.catch(() => {});
  return Promise.race([loading, ready]);
}
/** Ops that act in a page or hand it to the user; a tab with none was only read. */
const INTERACTIONS = new Set(["tab.act", "tab.dialog", "tab.wait", "signin.fill", "pay.inspect", "pay.fill", "autofill.fill"]);
async function openAgent(browser, { session, args, id: callId, turn_id: turn }, source) {
  const signedIn = args.profile === "signed_in" || args.signed_in === true;
  if (signedIn && (args.policy?.mode !== "signed_in" || signedInPlace(args.url, args.policy) !== "granted")) return { status: "refused", reason: "signed_in_unavailable" };
  if (!makeAgentRoom(browser)) return { status: "refused", reason: "tab_budget_exhausted" };
  return openTab(browser, { session, args, callId, signedIn, source, turn });
}
async function openTab(browser, { session, args, callId, signedIn, source, turn }) {
  const id = browser.create({ owner: `conversation:${session}`, url: args.url, preview_id: args.preview_id, agent: true, policy: args.policy, partition: source?.partition, profile: source?.profile ?? (signedIn ? "signed_in" : undefined) }, false);
  const tab = browser.tabs.get(id);
  tab.openedTurn = typeof turn === "string" ? turn : null;
  tab.onPointer=(step,target)=>browser.pointer.step(tab,step,target);
  const use = browser.uses.get(callId);
  bindUse(browser, use, tab);
  browser.materialize(tab); backgroundTab(browser, tab);
  // Attach only after the native host owns the view, as in output checks.
  await new Promise(resolve => setTimeout(resolve, 0));
  connectDebugger(browser,tab);
  if (!await guardUrl(args.url, tab.view.webContents.session, tab.policy)) { browser.close(id); return { status: "refused", reason: "navigation_denied" }; }
  if (callId && browser.uses.get(callId) !== use) { browser.close(id); return { status: "unknown", reason: "cancelled" }; }
  try { await tab.identityReady; await tab.debuggerReady; await parsed(tab.view.webContents, args.url); }
  catch { browser.close(id); return { status: "unknown", reason: "navigation_failed" }; }
  if (callId && browser.uses.get(callId) !== use) { browser.close(id); return { status: "unknown", reason: "cancelled" }; }
  touch(browser, tab);
  browser.publish();
  return { status: "ok", tab: id, url: tab.url, title: tab.title, epoch: tab.epoch, profile: tab.profile };
}
