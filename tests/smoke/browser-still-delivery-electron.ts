// test-category: race
/** Real capture queue: close and quit-save join the active capture and all followers. */
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence);
const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<!doctype html><title>Queue</title><button>Ready</button>", { headers: { "content-type": "text/html" } }) });
const app = await browserAgentApp(evidence, () => null);
try {
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en" }) });
  await app.page.reload();
  await app.page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="app-sidebar"]')));
  await app.call("open");
  await app.click("Browser");
  for (const ending of ["close", "quit-save"]) {
    const id = await app.call<string>("create", { url: `http://127.0.0.1:${site.port}/` });
    await waitBrowser(() => app.main<boolean>(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(id)})?.title === "Queue"`), "queue page loaded");
    await waitBrowser(() => app.main<boolean>(`(()=>{const tab=globalThis.browserAgentSubject.tabs.get(${JSON.stringify(id)});return Boolean(tab?.attached && tab.bounds?.width>0)})()`), "queue page attached to its native host");
    const result = await app.main<{ states: string[]; steps: number[]; pending: number; closed: boolean }>(`(async()=>{
      const require=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json');
      const {enqueueStill}=require(${JSON.stringify(resolve("packages/butler-app/client/electron/browser/still-delivery.mjs"))});
      const {saveBrowserForQuit}=require(${JSON.stringify(resolve("packages/butler-app/client/electron/browser/quit.mjs"))});
      const browser=globalThis.browserAgentSubject,tab=browser.tabs.get(${JSON.stringify(id)}),contents=tab.view.webContents;
      if(contents.isLoading())await new Promise(done=>contents.once('did-stop-loading',done));
      let ready,release;
      const requested=new Promise(done=>{ready=done}),held=new Promise(done=>{release=done});
      const original=contents.executeJavaScriptInIsolatedWorld.bind(contents),states=[],steps=[];
      let captures=0;
      contents.executeJavaScriptInIsolatedWorld=async(world,scripts)=>{
        if(scripts.some(script=>script.code.startsWith('new Promise(done=>requestAnimationFrame')) && ++captures===1){ready();await held}
        return original(world,scripts);
      };
      for(let index=0;index<3;index++)enqueueStill(tab,index,tab.epoch,async value=>{states.push(value.still?'attached':value.reason);steps.push(value.step)});
      await requested;
      const pending=tab.stillJobs.size;
      const draining=${JSON.stringify(ending)}==='close'?browser.close(tab.id):saveBrowserForQuit(browser);
      if(!browser.tabs.has(tab.id))throw Error('close destroyed the active capture');
      setTimeout(release,100);
      await draining;
      const closed=!browser.tabs.has(tab.id);
      if(!closed){contents.executeJavaScriptInIsolatedWorld=original;browser.close(tab.id)}
      return {states,steps,pending,closed};
    })()`);
    assert.equal(result.pending, 3, "active capture and both queued followers");
    assert.deepEqual(result.steps, [0, 1, 2]);
    assert.deepEqual(result.states, ["attached", "attached", "attached"]);
    assert.equal(result.closed, ending === "close");
  }
} finally { await app.stop(); site.stop(true); }
