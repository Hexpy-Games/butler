// test-category: race
/** Real stub turn, model gaps, terminal release and native compositor evidence. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redesignApp } from "../support/browser-redesign-app";
import { bridgeBrowser, describeBrowser, actConfirm } from "../support/browser-agent-stub";
import { pointerAction } from "../support/browser-control-actions";
import { waitBrowser } from "../support/browser-agent-app";
import { nativeAligned } from "../support/browser-shell-acceptance";
import { startHoldTrace, finishHoldTrace, windowFrames, pointerFrames, verifyPointerGlide } from "../support/browser-hold-trace";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence);
mkdirSync(evidence, { recursive: true });
const baseline = process.env.BUTLER_HOLD_DIAGNOSE === "1";
const failureOnly = process.env.BUTLER_HOLD_CASE === "failure";
const glideOnly = process.env.BUTLER_HOLD_CASE === "glide";
assert.ok(!process.env.BUTLER_HOLD_CASE || failureOnly || glideOnly, "Unknown hold case");
let summary: unknown;
let gap = 0, replies = 0, failReply = false;
const app = await redesignApp(evidence, { stubReply: async () => {
  if (gap) await new Promise(done => setTimeout(done, 1000 + (replies++ % 3) * 1000));
  if (failReply) throw new Error("Injected stub provider failure");
  return "Stub browser task complete.";
} });
let tab = "";
const card = (value: string) => waitBrowser(() => app.page.expression(`document.querySelector('[data-slot=page-card]')?.dataset.holder===${JSON.stringify(value)}`), `holder ${value}`);
try {
  app.stub.set([describeBrowser, () => bridgeBrowser("browser_open", { url: app.url })]);
  await app.send("Open the browser fixture"); await app.delivered();
  tab = (await app.call<{ tabs: Array<{ id: string; agent: boolean }> }>("state")).tabs.find(item => item.agent)!.id;
  await app.settings("en", "light", 1440); await app.call("activate", { id: tab }); await app.click("Browser");
  await nativeAligned(app);
  if (glideOnly) {
    summary = await verifyPointerGlide(app, tab, evidence);
  } else {
  if (!failureOnly) {
  // Presenter fixture isolates DS motion; subsequent functional checks use actual stub turns.
  await app.main(`globalThis.browserAgentSubject.execute({op:'use.started',id:'animation-probe',session:'general',tab:${JSON.stringify(tab)}})`);
  await pointerAction(app, tab, "click");
  await waitBrowser(() => app.main("Boolean(globalThis.browserAgentSubject.pointer.ready)"), "pointer loaded");
  await new Promise(done => setTimeout(done, 450));
  const geometry = pointerFrames(app);
  const images = windowFrames(app, evidence, "target-observe");
  await app.internal("tab.observe", tab);
  writeFileSync(join(evidence, "target-observe-geometry.json"), JSON.stringify(await geometry));
  await images;
  await app.main("globalThis.browserAgentSubject.execute({op:'use.ended',args:{id:'animation-probe'}})");

  await startHoldTrace(app); gap = 1;
  app.stub.set([describeBrowser, ...Array.from({ length: 5 }, () => [
    () => bridgeBrowser("browser_observe", { tab }), actConfirm,
  ]).flat()]);
  await app.send("Confirm five times, observing before each action");
  await card("butler");
  await windowFrames(app, evidence, "first-action");
  await app.shot("gap-early");
  await app.delivered(); gap = 0;
  await card("none");
  await new Promise(done => setTimeout(done, 100));
  summary = await finishHoldTrace(app, evidence, "multi-step", baseline);
  const native = await app.main<{ pointer: unknown; uses: number }>(`({pointer:globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)}).pointer,uses:globalThis.browserAgentSubject.uses.size})`);
  assert.equal(native.pointer, null); assert.equal(native.uses, 0);
  await app.shot("turn-done");
  }
  if (!baseline) {
    await startHoldTrace(app); gap = 1;
    app.stub.set([describeBrowser, () => bridgeBrowser("browser_observe", { tab })]);
    await app.send("Observe then fail the stub provider"); await card("butler");
    await waitBrowser(() => app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)}).pointer?.mode==='parked'`), "observe finished before provider failure");
    failReply = true;
    await waitBrowser(async () => ["failed", "runtime_fault"].includes((await app.gateway.api<{ latest_turn: { state: string } }>("/session-view?session_id=general")).latest_turn.state), "provider failure terminates the real turn");
    gap = 0; failReply = false; await card("none");
    await new Promise(done => setTimeout(done, 100));
    const failed = await finishHoldTrace(app, evidence, "failed-turn", false, 1);
    if (failureOnly) summary = failed;
  }
  // Host lifecycle fixture; public delegation mapping is covered by browser_delegation E2E.
  if (!baseline) {
    await app.main(`globalThis.browserAgentSubject.execute({op:'use.started',id:'child-action',session:'general',turn_id:'child-run',tab:${JSON.stringify(tab)}})`);
    await app.main("globalThis.browserAgentSubject.execute({op:'use.ended',args:{id:'child-action'}})");
    await card("butler");
    await app.main("globalThis.browserAgentSubject.execute({op:'use.finished',session:'general',turn_id:'unrelated',args:{}})");
    await card("butler");
    await app.main("globalThis.browserAgentSubject.execute({op:'use.finished',session:'general',turn_id:'child-run',args:{}})");
    await card("none");
  }
  // Before/after matrix covers held, parked, user and released states in the real App.
  for (const language of failureOnly ? [] : ["ko", "en"]) for (const theme of ["light", "dark"]) for (const width of [1440, 1100]) {
    await app.settings(language, theme, width); await app.call("activate", { id: tab }); await app.click(language === "ko" ? "브라우저" : "Browser");
    await nativeAligned(app); await startHoldTrace(app); gap = 1;
    app.stub.set([describeBrowser, () => bridgeBrowser("browser_observe", { tab }), actConfirm]);
    await app.send("Confirm with a pause between browser actions"); await card("butler");
    const prefix = `${language}-${theme}-${width}`;
    await app.shot(`${prefix}-held`);
    if (!baseline) {
      await waitBrowser(() => app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)}).pointer?.mode==='parked'`), "pointer parks between actions");
      const parked = await app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)}).pointer.at`);
      await app.shot(`${prefix}-gap`);
      assert.deepEqual(await app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)}).pointer.at`), parked);
      await app.click(language === "ko" ? "직접 조작" : "Take over"); await card("user");
      assert.equal((await app.call<{ tabs: Array<{ id: string; inUse: boolean }> }>("state")).tabs.find(item=>item.id===tab)?.inUse, false);
      await app.shot(`${prefix}-takeover`);
    }
    await app.delivered(); gap = 0;
    await app.call("control", { id: tab, holder: "agent" }); await card("none");
    await app.shot(`${prefix}-done`);
    await app.page.expression("(()=>{window.holdTracing=false;window.holdObserver.disconnect()})()");
  }
  }
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ ok: true, baseline, summary }));
  console.log(JSON.stringify({ ok: true, baseline, summary }));
} catch (error) {
  writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), native: await app.main("globalThis.browserAgentError").catch(()=>null), diagnostics: await app.page.diagnostics() }));
  throw error;
} finally { await app.stop(); }
