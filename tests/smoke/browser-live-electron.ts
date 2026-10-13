// test-category: security
/** Offline real-App acceptance for the after-action frame service. */
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cpus } from "node:os";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { startWriteTrace } from "./browser-p0-write-trace";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence);
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
  const path = new URL(request.url).pathname;
  if (path.endsWith("resource")) {
    await Bun.sleep(6000);
    return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="blue"/></svg>', { headers: { "content-type": "image/svg+xml" } });
  }
  if (path.endsWith("loading")) return new Response('<h1>Loading</h1><img src="resource">', { headers: { "content-type": "text/html" } });
  return new Response(path.endsWith("vault")
  ? "<!doctype html><style>body{margin:0}input{box-sizing:border-box;width:1280px;height:300px;background:white;font-size:80px}</style><input autocomplete=\"cc-number\" aria-label=\"Card number\">"
  : `<!doctype html><style>body{margin:0}button{font-size:40px}</style><button onclick="this.textContent=++window.acts">0</button><canvas width="1280" height="700"></canvas>
<script>window.acts=0;const c=document.querySelector('canvas').getContext('2d');let n=0;
function draw(){c.fillStyle='hsl('+n++%360+' 65% 60%)';c.fillRect(0,0,1280,700);requestAnimationFrame(draw)}draw()</script>`,
  { headers: { "content-type": "text/html" } });
} });
const app = await browserAgentApp(evidence, () => null);
const subject = "globalThis.browserAgentSubject";
const origin = `http://127.0.0.1:${fixture.port}`;
const execute = <T>(op: string, tab?: string, args: unknown = {}) => app.main<T>(`${subject}.execute(${JSON.stringify({ op, tab, args, session: "live_frames" })})`);
type Result = { status: string; tab: string; obs: string; nodes: Array<{ ref: string; role: string }> };
const counts = () => app.page!.expression<Record<string, number>>("globalThis.liveCounts");
const changed = async (id: string) => {
  const observation = await execute<Result>("tab.observe", id);
  assert.equal(observation.status, "ok");
  const ref = observation.nodes.find(node => node.role === "button")?.ref; assert.ok(ref);
  const args = { observation: observation.obs, steps: [{ action: "click", ref }] };
  const prepared = await execute<{ status: string; steps: unknown[] }>("tab.prepare", id, args);
  assert.equal(prepared.status, "ok");
  const result = await execute<{ steps: Array<{ status: string; reason?: string }> }>("tab.act", id, { ...args, prepared_steps: prepared.steps });
  assert.equal(result.steps[0].status, "completed", result.steps[0].reason);
};
async function quiet(ids: string[], expression: string) {
  await app.main(expression);
  await waitBrowser(() => app.main(`![...${subject}.live.subscriptions.values()].some(state=>state.capturing)`), "paused capture settled");
  await waitBrowser(() => app.page!.expression("Object.keys(liveCounts).every(id=>liveCounts[id]===liveDraws[id])"), "delivered frames drawn before pause count");
  const before = await counts();
  await Bun.sleep(2300);
  const after = await counts();
  for (const id of ids) assert.equal(after[id], before[id], `paused ${id}`);
}
try {
  await app.call("state");
  // The owner may be asleep: control the OS idle signal only in this offline harness.
  await app.main("(()=>{const power=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').powerMonitor;globalThis.liveIdle=0;power.getSystemIdleTime=()=>globalThis.liveIdle})()");
  const ids: string[] = [];
  for (let index = 0; index < 3; index++) {
    const result = await execute<Result>("tab.open", undefined, { url: `${origin}/__o/busy`, background: true, policy: { content_origin: origin } });
    assert.equal(result.status, "ok"); ids.push(result.tab);
  }
  await app.page!.expression(`(()=>{
    const panel=document.createElement('div');panel.id='live-frame-consumer';
    panel.style.cssText='position:fixed;right:16px;top:60px;z-index:999999;display:grid;gap:8px';document.body.append(panel);
    globalThis.liveCounts={};globalThis.liveFrames={};globalThis.liveStops={};globalThis.liveDraws={};
    globalThis.subscribeLive=id=>{liveStops[id]=window.butlerBrowser.onFrame(id,async frame=>{
      liveCounts[id]=(liveCounts[id]||0)+1;liveFrames[id]={seq:frame.seq,masked:frame.masked,bytes:Array.from(frame.bytes)};
      const bitmap=await createImageBitmap(new Blob([frame.bytes],{type:'image/jpeg'}));
      let canvas=document.getElementById(id);if(!canvas){canvas=document.createElement('canvas');canvas.id=id;document.getElementById('live-frame-consumer').append(canvas)}
      canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
      liveDraws[id]=(liveDraws[id]||0)+1;
    })};
  })()`);
  // No subscriptions: no live capture and no frame cache.
  assert.equal(await app.main(`${subject}.live.subscriptions.size`), 0);
  await app.page!.expression(`${JSON.stringify(ids)}.forEach(subscribeLive)`);
  await waitBrowser(async () => Object.keys(await counts()).length === 3, "three subscribed frames");
  for (const id of ids) await changed(id);
  const processorCount = cpus().length;
  const metrics = () => app.main<Array<{ pid: number; cpu: { percentCPUUsage: number } }>>("process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').app.getAppMetrics()");
  await metrics(); const samples: number[] = [];
  const disk = startWriteTrace((await metrics()).map(metric => metric.pid), 10);
  for (let second = 0; second < 10; second++) {
    if (second % 2 === 0) for (const id of ids) await changed(id);
    await Bun.sleep(1000);
    samples.push((await metrics()).reduce((total, metric) => total + metric.cpu.percentCPUUsage, 0) * processorCount);
  }
  const result = { cpuOneCorePercent: samples.reduce((a, b) => a + b, 0) / samples.length, processorCount, frames: await counts(), disk: await disk };
  writeFileSync(join(evidence, "measurements.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  await waitBrowser(() => app.page!.expression("Object.keys(liveCounts).every(id=>liveCounts[id]===liveDraws[id])"), "every JPEG drawn");
  writeFileSync(join(evidence, "frames.png"), await app.page!.screenshot());
  await quiet(ids, `globalThis.liveIdle=120;for(const id of ${JSON.stringify(ids)})${subject}.live.changed(${subject}.tabs.get(id))`);
  await app.main("globalThis.liveIdle=0"); await Bun.sleep(2300);
  await quiet(ids, `${subject}.live.visibility(false);for(const id of ${JSON.stringify(ids)})${subject}.live.changed(${subject}.tabs.get(id))`);
  await app.main(`${subject}.live.visibility(true)`); await Bun.sleep(2300);
  await quiet(ids, `${app.win}.hide();for(const id of ${JSON.stringify(ids)})${subject}.live.changed(${subject}.tabs.get(id))`);
  await app.main(`${app.win}.show()`); await Bun.sleep(2300);
  await app.call("activate", { id: ids[0] }); await app.call("open");
  assert.equal(await app.main(`${subject}.areaVisible`), true);
  await quiet([ids[0]], `${subject}.live.changed(${subject}.tabs.get(${JSON.stringify(ids[0])}))`);
  await app.call("hide"); await Bun.sleep(2300);
  await app.page!.expression(`${JSON.stringify(ids)}.forEach(id=>liveStops[id]())`); await Bun.sleep(100);
  await quiet(ids, `for(const id of ${JSON.stringify(ids)})${subject}.live.changed(${subject}.tabs.get(id))`);
  assert.equal(await app.main(`${subject}.live.subscriptions.size`), 0);
  await app.page!.expression(`${JSON.stringify(ids)}.forEach(id=>document.getElementById(id)?.remove())`);
  for (const id of ids) await app.call("close", { id });
  const vault = await execute<Result>("tab.open", undefined, { url: `${origin}/__o/vault`, background: true, policy: { content_origin: origin } });
  await app.main(`${subject}.pullVault=async()=>({values:{number:'4111111111111111'}})`);
  const filled = await execute<{ status: string; filled: string[] }>("pay.fill", vault.tab, { top_origin: origin, frame_origins: [], fill_token: "0".repeat(32) });
  assert.equal(filled.status, "filled"); assert.ok(filled.filled.length);
  assert.equal(await app.main(`${subject}.tabs.get(${JSON.stringify(vault.tab)}).vaultFilled`), true);
  await app.page!.expression(`subscribeLive(${JSON.stringify(vault.tab)})`);
  await waitBrowser(() => app.page!.expression(`liveFrames[${JSON.stringify(vault.tab)}]?.masked===true && liveDraws[${JSON.stringify(vault.tab)}]===1`), "vault frame masked and drawn");
  const black = await app.page!.expression<number>(`(()=>{const c=document.getElementById(${JSON.stringify(vault.tab)});const p=c.getContext('2d').getImageData(10,10,350,60).data;let n=0;for(let i=0;i<p.length;i+=4)if(p[i]<10&&p[i+1]<10&&p[i+2]<10)n++;return n})()`);
  assert.equal(black, 350 * 60, "card rectangle is opaque black");
  await quiet([vault.tab], `${subject}.live.changed(${subject}.tabs.get(${JSON.stringify(vault.tab)}))`);
  // A later consumer of a frozen tab gets the masked still without a new capture.
  const replayed = await app.page!.expression<{ masked: boolean; seq: number }>(`new Promise(done=>{const stop=window.butlerBrowser.onFrame(${JSON.stringify(vault.tab)},frame=>{stop();done({masked:frame.masked,seq:frame.seq})})})`);
  assert.deepEqual(replayed, { masked: true, seq: (await app.page!.expression<{ seq: number }>(`liveFrames[${JSON.stringify(vault.tab)}]`)).seq });
  writeFileSync(join(evidence, "masked.png"), await app.page!.screenshot());
  const png = await app.page!.expression<string>(`document.getElementById(${JSON.stringify(vault.tab)}).toDataURL('image/png')`);
  writeFileSync(join(evidence, "masked-frame.png"), Buffer.from(png.split(",")[1], "base64"));
  // The freeze follows the sensitive state, not the first masked frame.
  await app.main(`(()=>{const tab=${subject}.tabs.get(${JSON.stringify(vault.tab)});tab.vaultFilled=false;${subject}.publish()})()`);
  await waitBrowser(() => app.page!.expression(`liveFrames[${JSON.stringify(vault.tab)}]?.masked===false`), "unmasked frame after the sensitive state clears");
  await app.page!.expression(`liveStops[${JSON.stringify(vault.tab)}]()`);
  await app.call("close", { id: vault.tab });
  const loading = await execute<Result>("tab.open", undefined, { url: `${origin}/__o/loading`, background: true, policy: { content_origin: origin } });
  await app.page!.expression(`subscribeLive(${JSON.stringify(loading.tab)})`);
  try { await waitBrowser(() => app.page!.expression(`liveCounts[${JSON.stringify(loading.tab)}]>=2`), "slow refresh while loading"); }
  catch (error) {
    const facts = await app.main(`(()=>{const service=${subject}.live;const state=service.subscriptions.get(${JSON.stringify(loading.tab)});const tab=${subject}.tabs.get(${JSON.stringify(loading.tab)});return {documentVisible:service.documentVisible,areaVisible:${subject}.areaVisible,allowed:service.allowed(tab,state),loading:tab.view.webContents.isLoading(),url:tab.url,seq:state.seq,frozen:state.frozen,dirty:state.dirty,capturing:state.capturing,attemptedAt:state.attemptedAt}})()`);
    writeFileSync(join(evidence, "loading-failure.json"), JSON.stringify(facts)); throw error;
  }
  await waitBrowser(() => app.main(`(()=>{const state=${subject}.live.subscriptions.get(${JSON.stringify(loading.tab)});return !state.dirty&&!state.capturing&&!state.timer&&!${subject}.tabs.get(${JSON.stringify(loading.tab)}).view.webContents.isLoading()})()`), "loading stopped and final frame delivered");
  const idleCount = (await counts())[loading.tab]; await Bun.sleep(2300);
  assert.equal((await counts())[loading.tab], idleCount, "idle tab has no periodic captures");
  await app.page!.expression(`liveStops[${JSON.stringify(loading.tab)}]()`);
  console.log("subscribe/unsubscribe, visibility, system idle, area-open, vault masking, loading refresh and idle stop: PASS");
} finally { await app.stop(); fixture.stop(true); }
