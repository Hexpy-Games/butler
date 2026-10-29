// test-category: race
import { appLocaleFromLanguage, getAppCopy } from "../../packages/butler-i18n/src/index";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { browserStub, describeBrowser, bridgeBrowser, latestBrowser } from "../support/browser-agent-stub";
import { shellReady } from "../support/browser-shell-acceptance";
import { runSmokeCases } from "../support/smoke-browser";
const root = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(root);
const cells = ["ko-light", "ko-dark", "en-light", "en-dark"];
if (await runSmokeCases(cells, "BUTLER_STILL_TIMELINE_CASE", import.meta.filename, { isolate: true })) process.exit(0);
const cell = process.env.BUTLER_STILL_TIMELINE_CASE!;
const [caseLanguage, caseTheme] = cell.split("-") as [string, string];
const evidence = join(root, cell);
const baseline = process.env.BUTLER_BROWSER_BASELINE === "1";
const stub = browserStub(), app = await browserAgentApp(evidence, stub.handler);
const sessionTitle = "Timeline work";
let sessionId: string;
async function send(text: string) {
  const old = (await app.gateway.api<any>(`/session-view?session_id=${sessionId}`)).latest_turn?.id;
  await app.gateway.api("/messages", { method: "POST", body: JSON.stringify({ chat_id: sessionId, text, client_message_id: crypto.randomUUID() }) });
  await waitBrowser(async () => {
    const turn = (await app.gateway.api<any>(`/session-view?session_id=${sessionId}`)).latest_turn;
    return turn?.id !== old && turn?.state === "delivered";
  }, "timeline fixture turn delivered");
}
try {
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ access_mode: "full_access", language: "en" }) });
  sessionId = (await app.gateway.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: sessionTitle }) })).session.id;
  stub.set([() => ({ name: "write_file", arguments: { path: "timeline/index.html", create_parents: true, content: "<!doctype html><title>Steps</title><button>Ready</button>" } }),
    () => ({ name: "output_publish", arguments: { path: "timeline", title: "Steps" } })]);
  await send("Publish steps");
  const artifacts = await app.gateway.api<any>(`/artifacts?session_id=${sessionId}`);
  const web = artifacts.artifacts.find((item: any) => item.kind === "web"); assert.ok(web);
  const view = await app.gateway.api<any>(`/outputs/${web.id}/view`);
  stub.set([describeBrowser, () => bridgeBrowser("browser_open", { url: view.url }), request => bridgeBrowser("browser_observe", { tab: latestBrowser(request, "tab").tab })]);
  await send("Open steps");
  const tabs = await app.call<{ tabs: { id: string; agent: boolean }[] }>("state");
  const id = tabs.tabs.find(tab => tab.agent)!.id;
  await app.main(`(()=>{
    const tab=globalThis.browserAgentSubject.tabs.get(${JSON.stringify(id)}),contents=tab.view.webContents;
    const capture=contents.capturePage.bind(contents);let index=0;
    contents.capturePage=async(...args)=>{if(tab.stillJobs?.size && ++index===2)await new Promise(done=>{globalThis.releaseTimelineStill=done});return capture(...args)};
    globalThis.restoreTimelineCapture=()=>{contents.capturePage=capture};
  })()`);
  stub.set([describeBrowser, () => bridgeBrowser("browser_observe", { tab: id }), request => {
    const observation = latestBrowser(request, "obs");
    return bridgeBrowser("browser_act", { tab: id, observation: observation.obs, steps: [{ action: "wait", value: "50" }, { action: "wait", value: "50" }] });
  }]);
  // Each turn's provider request includes the last observation's unchanged history.
  await send("Take two steps");
  writeFileSync(join(evidence, "fixture-state.json"), JSON.stringify({ stubFailures: stub.results.filter((value: any) => value?.stubFailure).length,
    pendingCapture: await app.main("Boolean(globalThis.releaseTimelineStill)") }));
  await waitBrowser(() => app.main("Boolean(globalThis.releaseTimelineStill)"), "last still held before timeline screenshot");
  if (!baseline) await app.main(`(async()=>{
    const contents=${app.win}.webContents,debuggerApi=contents.debugger,attached=debuggerApi.isAttached();
    if(!attached)debuggerApi.attach('1.3');await debuggerApi.sendCommand('Network.enable');
    globalThis.timelineReads=0;
    const listener=(_event,method,params)=>{if(method==='Network.requestWillBeSent' && /\\/(browser-stills|operations)\\//.test(new URL(params.request.url).pathname))globalThis.timelineReads++};
    debuggerApi.on('message',listener);
    globalThis.stopTimelineReads=()=>{debuggerApi.removeListener('message',listener);if(!attached)debuggerApi.detach()};
  })()`);
  let settledReads = 0;
  const facts: unknown[] = [];
  for (const phase of baseline ? ["pending", "attached"] : ["pending", "failed", "attached"]) {
    if (phase === "failed") {
      const view = await app.gateway.api<any>(`/session-view?session_id=${sessionId}`);
      const rows: any[] = [];
      const collect = (value: any) => { if (!value || typeof value !== "object") return; if (value.safe_tool_name === "browser_act" && value.tool_result_id) rows.push(value); Object.values(value).forEach(collect); };
      collect(view);
      const row = rows.at(-1); assert.ok(row);
      const raw = await app.gateway.api<any>(`/turns/${row.turn_id ?? view.latest_turn.id}/operations/${row.tool_call_id}/output?result_id=${row.tool_result_id}&offset=0`);
      const admin = JSON.parse(await Bun.file(join(app.gateway.butlerData, "app/runtime/auth/local-admin.json")).text()).secret;
      await app.gateway.api("/internal/browser-host/stills", { method: "POST", headers: { "x-butler-admin": admin }, body: JSON.stringify({ act_id: raw.browser_stills.act_id, session: sessionId, tab: id, step: 1, reason: "capture_failed" }) });
      const copy = getAppCopy(appLocaleFromLanguage(caseLanguage)).browser;
      const label = copy.stillFailure.capture_failed;
      await waitBrowser(() => app.page.expression(`document.querySelector('[data-test-class=browser-step-still] [aria-disabled=true]')?.textContent.includes(${JSON.stringify(label)})`), "failed still is disabled");
      const reads = await app.main<number>("globalThis.timelineReads");
      assert.ok(reads > 0, "CDP observes real bridge requests");
      settledReads = reads;
      await app.page.expression("new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(true))))");
      assert.equal(await app.main("globalThis.timelineReads"), reads, "settled failure stops polling");
      const point = await app.page.expression<{ x: number; y: number }>("(()=>{const box=document.querySelector('[data-test-class=browser-step-still] [aria-disabled=true]').getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2}})()");
      await app.page.movePointer(point.x, point.y);
      await waitBrowser(() => app.page.expression(`document.querySelector('[data-slot=tooltip-content]')?.textContent.includes(${JSON.stringify(copy.stillFailure.capture_failed)})`), "localized failure reason tooltip");
      await app.page.movePointer(900, 24);
    }
    if (phase === "attached") {
      const priorSource = await app.page.expression("document.querySelector('[data-test-class=browser-step-still] img')?.src");
      await app.main("globalThis.releaseTimelineStill?.();globalThis.restoreTimelineCapture?.()");
      await waitBrowser(() => app.page.expression(`document.querySelectorAll('[data-test-class=browser-step-still] img').length>=${baseline ? 1 : 2}${baseline ? ` && document.querySelector('[data-test-class=browser-step-still] img')?.src!==${JSON.stringify(priorSource)}` : ''}`), "all step images attached");
      if (!baseline) assert.ok(await app.main<number>("globalThis.timelineReads") > settledReads, "arrival refreshes a settled row");
    }
    for (const language of [caseLanguage]) for (const theme of [caseTheme]) {
      if (phase === "pending") {
      await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language, appearance_theme: theme }) });
      await app.page.reload();
      await app.page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="app-sidebar"]')));
      await shellReady(app, language);
      await app.page.clickText(sessionTitle, '[data-test-class="app-sidebar"] button, [data-test-class="app-sidebar"] [role="button"]');
      await app.page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="browser-step-still"]')));
      }
      facts.push(await app.page.expression(`(()=>{const nodes=[...document.querySelectorAll('[data-test-class=browser-step-still] [data-slot=media-frame]')];return {phase:${JSON.stringify(phase)},language:${JSON.stringify(language)},theme:${JSON.stringify(theme)},frames:nodes.map(node=>({width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height,state:node.getAttribute('data-fit')}))}})()`));
      await app.shot(`${phase}-${language}-${theme}`);
    }
  }
  writeFileSync(join(evidence, "timeline-states.json"), JSON.stringify(facts, null, 2));
} finally { await app.main("globalThis.releaseTimelineStill?.();globalThis.restoreTimelineCapture?.();globalThis.stopTimelineReads?.()").catch(() => {}); await app.stop(); }
