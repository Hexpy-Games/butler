// test-category: race
/** The page never moves: hold on/off, waiting, takeover, pop-ups and pick mode keep the native view's bounds. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAppCopy } from "../../packages/butler-i18n/src/index";
import { redesignApp } from "../support/browser-redesign-app";
import { bridgeBrowser, describeBrowser, actConfirm } from "../support/browser-agent-stub";
import { waitBrowser } from "../support/browser-agent-app";
import { nativeAligned } from "../support/browser-shell-acceptance";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence);
mkdirSync(evidence, { recursive: true });
// Baseline runs the same script against an older renderer to measure the shift it had; it asserts nothing.
const baseline = process.env.BUTLER_BAND_BASELINE === "1";
const only = process.env.BUTLER_BAND_MATRIX?.split(",");
// The stub awaits stubReply on every request; only the turn's final reply waits for the gate.
let gate: Promise<void> | null = null, openGate = () => {}, finalReply = false;
const holdTurn = () => { gate = new Promise<void>(done => { openGate = () => { gate = null; done(); }; }); };
const thinking = () => { finalReply = true; return null; };
const app = await redesignApp(evidence, { stubReply: async () => {
  if (finalReply && gate) { finalReply = false; await gate; }
  return "Stub browser task complete.";
} });
type Rect = { x: number; y: number; width: number; height: number };
type Trace = { calls: Array<Rect & { main: boolean }>; samples: Rect[]; detached: number };
type Frame = { rect: Rect | null; tone: string | null; bands: number };
let tab = "";
const tabExpr = () => `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)})`;
const card = (value: string) => waitBrowser(() => app.page.expression(`document.querySelector('[data-slot=page-card]')?.dataset.holder===${JSON.stringify(value)}`), `holder ${value}`);
const tone = (value: string) => waitBrowser(() => app.page.expression(`(document.querySelector('[data-slot=page-band]')?.dataset.tone ?? 'idle')===${JSON.stringify(value)}`), `band ${value}`);
const bandText = (text: string) => waitBrowser(() => app.page.expression(`[...document.querySelectorAll('[data-slot=page-band]')].some(n=>n.textContent.includes(${JSON.stringify(text)}))`), `band text ${text}`);
const openPopup = (url: string) => app.main(`${tabExpr()}.view.webContents.executeJavaScript(${JSON.stringify(`setTimeout(()=>open(${JSON.stringify(url)}),0)`)})`);

async function startTrace() {
  await app.main(`(() => {
    const t=${tabExpr()}, w=${app.win}; globalThis.bandTab=${JSON.stringify(tab)};
    globalThis.bandTrace={calls:[],samples:[],detached:0,holders:[]};
    const b=globalThis.browserAgentSubject;
    if(!b.bandPublish){const publish=b.publish;b.bandPublish=true;b.publish=function(){const t=this.tabs.get(globalThis.bandTab);
      const last=globalThis.bandTrace?.holders.at(-1);
      if(t&&globalThis.bandTrace&&(!last||last.holder!==t.holder||last.sticky!==t.sticky))globalThis.bandTrace.holders.push({holder:t.holder,sticky:t.sticky,stack:new Error().stack.split(String.fromCharCode(10)).slice(2,7).join(' | ')});
      return publish.call(this)}}
    if(!t.view.bandWrapped){const original=t.view.setBounds.bind(t.view);
      t.view.setBounds=r=>{globalThis.bandTrace?.calls.push({main:t.attached===w,...r});return original(r)};t.view.bandWrapped=true;}
    clearInterval(globalThis.bandTimer);
    globalThis.bandTimer=setInterval(()=>{if(t.attached===w)globalThis.bandTrace.samples.push(t.view.getBounds());else globalThis.bandTrace.detached++},8);
    return true;
  })()`);
  await app.page.expression(`(() => {
    window.bandFrames=[];window.bandTracing=true;
    const frame=()=>{if(!window.bandTracing)return;
      const slot=document.querySelector('[data-slot=native-view-frame]')?.getBoundingClientRect();
      window.bandFrames.push({rect:slot?{x:slot.x,y:slot.y,width:slot.width,height:slot.height}:null,
        tone:document.querySelector('[data-slot=page-band]')?.dataset.tone ?? null,bands:document.querySelectorAll('[data-slot=page-band]').length});
      requestAnimationFrame(frame)};
    requestAnimationFrame(frame);
  })()`);
}

async function finishTrace(name: string) {
  const native = await app.main<Trace>("(()=>{clearInterval(globalThis.bandTimer);return globalThis.bandTrace})()");
  const frames = await app.page.expression<Frame[]>("(()=>{window.bandTracing=false;return window.bandFrames})()");
  const delta = (rects: Rect[]) => {
    const anchor = rects[0]; if (!anchor) return { count: 0, max: 0 };
    const max = Math.max(0, ...rects.flatMap(rect => (["x", "y", "width", "height"] as const).map(key => Math.abs(rect[key] - anchor[key]))));
    return { count: rects.length, max };
  };
  const mainCalls = native.calls.filter(call => call.main);
  const rendered = frames.flatMap(frame => frame.rect ? [frame.rect] : []);
  const tones = frames.map(frame => frame.tone ?? "none").filter((value, index, all) => index === 0 || all[index - 1] !== value);
  const summary = { name, anchor: native.samples[0], nativeSamples: delta(native.samples), setBoundsCalls: delta(mainCalls),
    rendererFrames: delta(rendered), detachedSamples: native.detached, maxBands: Math.max(0, ...frames.map(frame => frame.bands)), tones };
  writeFileSync(join(evidence!, `${name}-bounds.json`), JSON.stringify({ summary, native, frames }));
  if (!baseline) {
    assert.equal(summary.nativeSamples.max, 0, `${name}: native view bounds moved`);
    assert.equal(summary.setBoundsCalls.max, 0, `${name}: setBounds moved the page`);
    assert.equal(summary.rendererFrames.max, 0, `${name}: page slot moved`);
    assert.equal(summary.detachedSamples, 0, `${name}: page detached`);
    assert.equal(summary.maxBands, 1, `${name}: one band per tab`);
    for (const value of ["idle", "agent", "waiting", "user", "pick"]) assert.ok(tones.includes(value), `${name}: ${value} band shown`);
    assert.ok(summary.nativeSamples.count > 100 && summary.rendererFrames.count > 100, `${name}: enough frames`);
  }
  return summary;
}

async function closePopups() {
  await app.main(`(() => { const b=globalThis.browserAgentSubject;
    for (const t of [...b.tabs.values()]) if (t.opener===${JSON.stringify(tab)}) { t.allowClose=true; if (t.popupWindow && !t.popupWindow.isDestroyed()) t.popupWindow.destroy(); else b.close(t.id); }
  })()`);
  await waitBrowser(async () => !(await app.call<{ tabs: Array<{ id: string; popup?: unknown }> }>("state")).tabs.find(item => item.id === tab)?.popup, "pop-up closed");
}

async function sequence(language: "ko" | "en", theme: "light" | "dark", width: number) {
  const copy = getAppCopy(language === "ko" ? "ko-KR" : "en-US").browser;
  const prefix = `${language}-${theme}-${width}`;
  await app.settings(language, theme, width); await app.call("activate", { id: tab }); await app.click(language === "ko" ? "브라우저" : "Browser");
  await nativeAligned(app);
  await startTrace();
  await tone("idle"); await app.shot(`${prefix}-1-idle`);
  // Hold on: a real stub turn acts, then the model "thinks" until the gate opens.
  holdTurn();
  app.stub.set([describeBrowser, () => bridgeBrowser("browser_observe", { tab }), actConfirm, thinking]);
  await app.send("Confirm, then keep the turn open"); await card("butler"); await tone("agent");
  await waitBrowser(() => app.main(`${tabExpr()}.pointer?.mode==='parked'`), "action done, turn still open");
  await app.shot(`${prefix}-2-held`);
  // A pop-up blocked by Butler's policy joins the agent band as its detail.
  await openPopup("https://blocked.invalid/");
  await waitBrowser(() => app.main(`${tabExpr()}.blockedPopup?.reason==='popup_policy'`), "agent pop-up blocked");
  await bandText(copy.popupBlocked); await tone("agent"); await app.shot(`${prefix}-3-held-popup`);
  await app.internal("tab.waiting", tab, { value: true }); await card("waiting"); await tone("waiting"); await app.shot(`${prefix}-4-waiting`);
  await app.internal("tab.waiting", tab, { value: false }); await card("butler"); await tone("agent");
  await app.click(copy.takeOver); await card("user"); await tone("user"); await app.shot(`${prefix}-5-takeover`);
  // Your tab now: a pop-up without a click is blocked, and Allow opens it from the band.
  await openPopup(`${app.url}#popup`);
  await waitBrowser(() => app.main(`${tabExpr()}.blockedPopup?.reason==='no_gesture'`), "user pop-up blocked");
  await bandText(copy.allow); await app.shot(`${prefix}-6-user-popup`);
  await app.click(copy.allow);
  await waitBrowser(async () => Boolean((await app.call<{ tabs: Array<{ id: string; popup?: unknown }> }>("state")).tabs.find(item => item.id === tab)?.popup), "pop-up opened from the band");
  await bandText(copy.showPopup); await tone("user");
  await closePopups(); await tone("user");
  // Keyboard: the band's actions are renderer buttons in the tab order; Return on the focused one gives the tab back.
  await app.main(`${app.win}.webContents.focus()`);
  await app.page.expression(`[...document.querySelectorAll('[data-slot=page-band-actions] button')].find(n=>n.textContent.trim()===${JSON.stringify(copy.giveBack)}).focus()`);
  assert.equal(await app.page.expression("document.activeElement?.closest('[data-slot=page-band]') !== null"), true, "band action takes keyboard focus");
  await app.main(`(() => { const c=${app.win}.webContents; for (const type of ["keyDown", "char", "keyUp"]) c.sendInputEvent({ type, keyCode: type === "char" ? "\\r" : "Return" }); })()`);
  // Giving back releases the hold until Butler acts again: the row stays, idle.
  await waitBrowser(() => app.main(`${tabExpr()}.holder==='agent'`), "given back by keyboard"); await card("none"); await tone("idle");
  openGate(); await app.delivered();
  // Hold on again, then stop the task from the band.
  holdTurn();
  app.stub.set([describeBrowser, () => bridgeBrowser("browser_observe", { tab }), thinking]);
  await app.send("Observe, then keep the turn open"); await card("butler"); await tone("agent");
  await app.click(copy.stopTask); await card("none"); await tone("idle");
  openGate();
  await waitBrowser(async () => !(await app.gateway.api<{ active_turn?: { id: string } | null }>("/session-view?session_id=general")).active_turn, "stopped turn ends");
  await app.shot(`${prefix}-7-stopped`);
  await app.call("pick", { id: tab, value: true }); await tone("pick"); await app.shot(`${prefix}-8-pick`);
  // Picking takes the tab for you (non-sticky), so Done leaves your control band; give it back from the band.
  await app.click(copy.finish); await card("user"); await tone("user");
  await app.click(copy.giveBack); await card("none"); await tone("idle");
  await new Promise(done => setTimeout(done, 300));
  return finishTrace(prefix);
}

const summaries: unknown[] = [];
try {
  app.stub.set([describeBrowser, () => bridgeBrowser("browser_open", { url: app.url })]);
  await app.send("Open the browser fixture"); await app.delivered();
  tab = (await app.call<{ tabs: Array<{ id: string; agent: boolean }> }>("state")).tabs.find(item => item.agent)!.id;
  for (const language of ["ko", "en"] as const) for (const theme of ["light", "dark"] as const) for (const width of [1440, 1100]) {
    if (only && !only.includes(`${language}-${theme}-${width}`)) continue;
    summaries.push(await sequence(language, theme, width));
  }
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ ok: true, baseline, summaries }, null, 2));
  console.log(JSON.stringify({ ok: true, baseline, summaries }));
} catch (error) {
  openGate();
  writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), summaries, native: await app.main("globalThis.browserAgentError").catch(() => null),
    holders: await app.main("globalThis.bandTrace?.holders").catch(() => null), diagnostics: await app.page.diagnostics() }));
  throw error;
} finally { await app.stop(); }
