import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { waitBrowser, type browserAgentApp } from "./browser-agent-app";
import { describeBrowser, bridgeBrowser, actConfirm, type browserStub } from "./browser-agent-stub";

/** Two hours of real guided observe/ref-act turns, with user tabs and video. */
export async function soakBrowser(
  app: Awaited<ReturnType<typeof browserAgentApp>>,
  stub: ReturnType<typeof browserStub>,
  tab: string,
  evidence: string,
  send: (text: string) => Promise<void>,
  delivered: () => Promise<void>,
) {
  const video = process.env.BUTLER_BROWSER_SOAK_VIDEO;
  assert.ok(video, "explicit video URL required for the soak");
  const userTabs: string[] = [];
  for (const url of ["https://www.iana.org/domains/reserved", "https://www.iana.org/protocols", video]) {
    userTabs.push(await app.call<string>("create", { url }));
  }
  await app.call("activate", { id: tab });
  const videoTab=userTabs.at(-1)!;
  await waitBrowser(()=>app.main<boolean>(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(videoTab)}).view.webContents.executeJavaScript("Boolean(document.querySelector('video') && document.querySelector('video').readyState>=2)")`).catch(()=>false),"soak video ready");
  await app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(videoTab)}).view.webContents.executeJavaScript("(async()=>{const v=document.querySelector('video');if(!v)throw new Error('video missing');v.muted=true;v.loop=true;await v.play();return !v.paused})()")`);
  await app.main("(()=>{globalThis.browserAgentLoop=process.getBuiltinModule('node:perf_hooks').monitorEventLoopDelay({resolution:10});globalThis.browserAgentLoop.enable()})()");
  await app.page.expression("document.addEventListener('pointerdown',()=>{const start=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>{globalThis.__browserInputPaintMs=performance.now()-start}))},true)");
  const resourceSnapshot = () => app.main<{rss:number;heap:number;listeners:number;webContents:number}>(`(()=>{
    const e=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(process.cwd(),"packages/butler-app/client/electron/package.json"))})('electron');
    const contents=e.webContents.getAllWebContents(),emitters=[e.app,process,...e.BrowserWindow.getAllWindows(),...contents];
    return {rss:process.memoryUsage().rss,heap:process.memoryUsage().heapUsed,webContents:contents.length,
      listeners:emitters.reduce((sum,target)=>sum+target.eventNames().reduce((n,event)=>n+target.listenerCount(event),0),0)};
  })()`);
  const baseline = await resourceSnapshot();
  const started = Date.now(), rows: Array<{elapsedMs:number;turnMs:number;loadAverage1m:number;inputPaintMs:number;loop:{p99Ms:number;maxMs:number};video:{paused:boolean;time:number};proof:unknown;metrics:unknown;resources:Awaited<ReturnType<typeof resourceSnapshot>>}> = [];
  let lastVideoTime=-1,stage="start";
  try {
  while (Date.now() - started < 2 * 60 * 60 * 1000) {
    const loadAverage1m = loadavg()[0], before = Date.now();
    stage="guided turn";
    stub.set([describeBrowser, () => bridgeBrowser("browser_observe", { tab }), actConfirm]);
    await send("Observe the current page and click Confirm by its fresh ref.");
    await delivered();
    stage="native confirm proof";
    const proof = await app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)}).view.webContents.executeJavaScript("({result:document.querySelector('#result').textContent,width:innerWidth,height:innerHeight})")`);
    assert.deepEqual(proof, { result: "Confirmed", width: 1280, height: 800 });
    const state = await app.call<{ tabs: Array<{ id: string; status: string }> }>("state");
    assert.ok([tab, ...userTabs].every(id => state.tabs.some(t => t.id === id && t.status !== "crashed")));
    stage="UI input";
    await app.click("Browser");
    await app.page.evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));
    const inputPaintMs=await app.page.expression<number>("globalThis.__browserInputPaintMs");
    stage="event loop histogram";
    const loop=await app.main<{p99Ms:number;maxMs:number}>("(()=>{const h=globalThis.browserAgentLoop;const result={p99Ms:h.percentile(99)/1e6,maxMs:h.max/1e6};h.reset();return result})()");
    stage="background playback";
    const playback=await app.main<{paused:boolean;time:number}>(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(videoTab)}).view.webContents.executeJavaScript("({paused:document.querySelector('video').paused,time:document.querySelector('video').currentTime})")`);
    assert.equal(playback.paused,false);assert.notEqual(playback.time,lastVideoTime,"video keeps advancing during agent turns");lastVideoTime=playback.time;
    stage="process metrics";
    const metrics = await app.main(`${app.win}.constructor.getAllWindows && process.getBuiltinModule('module').createRequire(${JSON.stringify(join(process.cwd(),"packages/butler-app/client/electron/package.json"))})('electron').app.getAppMetrics()`);
    stage="resource snapshot";
    const resources=await resourceSnapshot();
    rows.push({ resources, elapsedMs: Date.now() - started, turnMs: Date.now() - before, loadAverage1m, inputPaintMs, loop, video:playback, proof, metrics });
    writeFileSync(join(evidence, "soak.json"), JSON.stringify({ head:process.env.BUTLER_TEST_HEAD, started, baseline, rows }, null, 2));
    // Each yield is bounded so the caller can communicate throughout the soak.
    await new Promise(done => setTimeout(done, 30_000));
  }
  }catch(error){
    const mainHealth=await app.main("({rss:process.memoryUsage().rss,loopMaxMs:globalThis.browserAgentLoop.max/1e6})").catch(()=>null);
    const turn=await app.gateway.api<{latest_turn?:{state:string}}>("/session-view?session_id=general").then(view=>view.latest_turn?.state).catch(()=>null);
    writeFileSync(join(evidence,"soak-failure.json"),JSON.stringify({stage,error:String(error),mainHealth,turn,elapsedMs:Date.now()-started,completeLoops:rows.length},null,2));
    throw error;
  }
  await app.main("globalThis.browserAgentLoop.disable()");
  const final=await resourceSnapshot();
  writeFileSync(join(evidence,"soak-deltas.json"),JSON.stringify({head:process.env.BUTLER_TEST_HEAD,elapsedMs:Date.now()-started,completeLoops:rows.length,baseline,final,
    deltas:{rss:final.rss-baseline.rss,heap:final.heap-baseline.heap,listeners:final.listeners-baseline.listeners,webContents:final.webContents-baseline.webContents}},null,2));
  assert.equal(final.webContents,baseline.webContents,"no leaked webContents");
  assert.equal(final.listeners,baseline.listeners,"no leaked listeners");
  const p95=rows.map(row=>row.inputPaintMs).sort((a,b)=>a-b)[Math.ceil(rows.length*.95)-1]!;
  const failures=[];
  if(p95>100) failures.push(`input paint p95 ${p95}`);
  for(const [index,row] of rows.entries()) if(row.loop.p99Ms>30 || row.loop.maxMs>200)failures.push(`loop ${index}: p99 ${row.loop.p99Ms} max ${row.loop.maxMs}`);
  writeFileSync(join(evidence,"soak-budget.json"),JSON.stringify({p95,failures,loadAverage1m:loadavg()[0]},null,2));
  assert.deepEqual(failures,[],"UI under browser load");
  assert.ok(rows.length >= 120, "at least 120 complete guided loops");
}
