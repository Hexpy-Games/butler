// test-category: race
/** Real-App frame correctness and CPU phases; all pages and providers are offline. */
import { strict as assert } from "node:assert";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { cpus } from "node:os";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";

const root = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(root);
const evidence = join(root, "background-ui"); mkdirSync(evidence, { recursive: true });
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new Response(`<!doctype html>
<style>body{margin:0}button{position:fixed;left:0;top:0;width:1280px;height:160px;background:rgb(220,30,30);font-size:40px}canvas{position:fixed;top:160px}main{margin-top:900px}</style>
<button onclick="this.textContent=++window.acts;this.style.background=window.acts%2?'rgb(30,220,30)':'rgb(220,30,30)'">0</button>
<canvas width="1280" height="640"></canvas><main></main><script>window.acts=0;
const root=document.querySelector('main');for(let n=0;n<10000;n++){const e=document.createElement('div');e.textContent='Item '+n;root.append(e)}
const context=document.querySelector('canvas').getContext('2d');let n=0;
function draw(){context.fillStyle='hsl('+n++%360+' 65% 60%)';context.fillRect(0,0,1280,640);${new URL(request.url).pathname.endsWith("animated") ? "requestAnimationFrame(draw)" : ""}}draw();</script>`,
{ headers: { "content-type": "text/html" } }) });
const app = await browserAgentApp(evidence, () => null);
const subject = "globalThis.browserAgentSubject", origin = `http://127.0.0.1:${fixture.port}`;
const tab = (id: string) => `${subject}.tabs.get(${JSON.stringify(id)})`;
type Result = { status: string; tab: string; obs: string; nodes: Array<{ role: string; ref: string }> };
const execute = <T>(op: string, id?: string, args: unknown = {}) => app.main<T>(`${subject}.execute(${JSON.stringify({ op, tab: id, args, session: "background_frames" })})`);
const frameCount = (id: string) => app.page!.expression<number>(`liveCounts[${JSON.stringify(id)}]||0`);
const metrics = () => app.main<Array<{ cpu: { percentCPUUsage: number } }>>("process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').app.getAppMetrics()");
const rows: unknown[] = [];
async function assertFrame(id: string, width: number, green: boolean) {
  try { await waitBrowser(() => app.page!.expression(`liveFrames[${JSON.stringify(id)}]?.width===${width} && liveFrames[${JSON.stringify(id)}]?.green===${green}`), "current complete frame decoded"); }
  catch (error) {
    const frame = await app.page!.expression(`liveFrames[${JSON.stringify(id)}]`);
    const page = await app.main(`${tab(id)}.view.webContents.executeJavaScript("({acts:window.acts,color:getComputedStyle(document.querySelector('button')).backgroundColor,scrollY,viewport:[innerWidth,innerHeight]})")`);
    writeFileSync(join(evidence, "frame-failure.json"), JSON.stringify({ frame, page, expected: { width, green } }, null, 2)); throw error;
  }
  const frame = await app.page!.expression<{ width: number; height: number; masked: boolean; green: boolean }>(`liveFrames[${JSON.stringify(id)}]`);
  assert.equal(frame.height, Math.round(width * 260 / 416)); assert.equal(frame.masked, false); assert.equal(frame.green, green);
}
async function action(id: string, viewer: boolean) {
  const observation = await execute<Result>("tab.observe", id); assert.equal(observation.status, "ok");
  const ref = observation.nodes.find(node => node.role === "button")?.ref; assert.ok(ref);
  const args = { observation: observation.obs, steps: [{ action: "click", ref }] };
  const prepared = await execute<{ status: string; steps: unknown[] }>("tab.prepare", id, args); assert.equal(prepared.status, "ok");
  await app.main(`${tab(id)}.captureCount=0`);
  const before = await frameCount(id);
  const result = await execute<{ status: string; steps: Array<{ status: string; still?: { base64: string } }> }>("tab.act", id, { ...args, prepared_steps: prepared.steps });
  assert.equal(result.steps[0]!.status, "completed"); assert.ok(result.steps[0]!.still);
  const green = await app.main<boolean>(`${tab(id)}.view.webContents.executeJavaScript("window.acts%2===1")`);
  const still = result.steps[0]!.still!;
  const pixels = await app.page!.expression<number[]>(`(async()=>{const image=await createImageBitmap(new Blob([Uint8Array.from(atob(${JSON.stringify(still.base64)}),c=>c.charCodeAt(0))],{type:'image/jpeg'}));const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d');context.drawImage(image,0,0);image.close();return Array.from(context.getImageData(10,10,1,1).data)})()`);
  writeFileSync(join(evidence, "latest-step-still.jpg"), Buffer.from(still.base64, "base64"));
  writeFileSync(join(evidence, "latest-step-pixels.json"), JSON.stringify({ pixels, green, viewer, id }));
  assert.equal(pixels[1]! > 180 && pixels[0]! < 80, green, "step still shows the latest action pixels");
  if (viewer) { await waitBrowser(async () => await frameCount(id) > before, "shared action bitmap delivered"); await assertFrame(id, 416, green); }
  assert.equal(await app.main(`${tab(id)}.captureCount`), 1, "one viewport readback for step still and live");
  assert.equal(await app.main(`${tab(id)}.view.webContents.executeJavaScript("document.querySelector('main').children.length")`), 10000);
}
async function phase(kind: string, id: string, viewer: boolean) {
  if (viewer) {
    await app.page!.expression(`subscribeLive(${JSON.stringify(id)},416)`);
    await assertFrame(id, 416, false);
    await waitBrowser(() => app.main(`!${subject}.live.subscriptions.get(${JSON.stringify(id)}).capturing`), "initial capture settled");
  }
  const before = await frameCount(id);
  await Bun.sleep(2000);
  await app.main(`${tab(id)}.captureCount=0`); await metrics();
  const samples: number[] = [];
  for (let second = 0; second < 4; second++) {
    await Bun.sleep(1000);
    samples.push((await metrics()).reduce((sum, value) => sum + value.cpu.percentCPUUsage, 0) * cpus().length);
  }
  assert.equal(await frameCount(id), before, "settled tab has no periodic frames");
  assert.equal(await app.main(`${tab(id)}.captureCount`), 0, "no idle readback");
  if (viewer) await assertFrame(id, 416, false);
  const actionSamples: number[] = [];
  await metrics();
  for (let index = 0; index < 2; index++) {
    await action(id, viewer); await Bun.sleep(1000);
    actionSamples.push((await metrics()).reduce((sum, value) => sum + value.cpu.percentCPUUsage, 0) * cpus().length);
  }
  if (viewer) {
    const png = await app.page!.expression<string>(`document.getElementById(${JSON.stringify(id)}).toDataURL('image/png')`);
    writeFileSync(join(evidence, `${kind}-live-frame.png`), Buffer.from(png.split(",")[1]!, "base64"));
  }
  rows.push({ kind, viewer, cpuOneCorePercent: samples.reduce((a, b) => a + b, 0) / samples.length, samples,
    idleFrames: 0, idleCaptures: 0, actionCaptures: 1, actionCpuOneCorePercent: actionSamples.reduce((a, b) => a + b, 0) / actionSamples.length, actionSamples, correct: true, domRows: 10000 });
  writeFileSync(join(evidence, "cpu-phases.json"), JSON.stringify({ processorCount: cpus().length, phases: rows }, null, 2));
  if (viewer) await app.page!.expression(`liveStops[${JSON.stringify(id)}]()`);
}
try {
  await app.call("state");
  await app.page!.expression(`(()=>{
    globalThis.liveCounts={};globalThis.liveFrames={};globalThis.liveStops={};
    globalThis.subscribeLive=(id,width)=>{liveStops[id]=window.butlerBrowser.onFrame(id,async frame=>{
      const bitmap=await createImageBitmap(new Blob([frame.bytes],{type:'image/jpeg'}));
      let c=document.getElementById(id);if(!c){c=document.createElement('canvas');c.id=id;document.body.append(c)}
      c.width=bitmap.width;c.height=bitmap.height;c.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
      const p=c.getContext('2d').getImageData(10,10,1,1).data;
      liveFrames[id]={width:c.width,height:c.height,masked:frame.masked,green:p[1]>180&&p[0]<80,pixel:Array.from(p)};
      liveCounts[id]=(liveCounts[id]||0)+1;
    },width)};
  })()`);
  for (const kind of ["static", "animated"]) for (const viewer of [false, true]) {
    const result = await execute<Result>("tab.open", undefined, { url: `${origin}/__o/${kind}`, background: true, policy: { content_origin: origin } });
    assert.equal(result.status, "ok");
    await waitBrowser(() => app.main(`${tab(result.tab)}.loaded && !${tab(result.tab)}.view.webContents.isLoading()`), "fixture loaded");
    await app.main(`(()=>{const t=${tab(result.tab)},contents=t.view.webContents;const capture=contents.capturePage.bind(contents);contents.capturePage=(...args)=>{t.captureCount=(t.captureCount||0)+1;return capture(...args)}})()`);
    assert.equal(await app.main(`${subject}.focusRequest??null`), null, "background open keeps the conversation in place");
    await phase(kind, result.tab, viewer);
    await app.call("close", { id: result.tab });
  }
  // Width is the maximum of current consumers, including a later viewer.
  const narrow = await execute<Result>("tab.open", undefined, { url: `${origin}/__o/static`, background: true, policy: { content_origin: origin } });
  await app.page!.expression(`subscribeLive(${JSON.stringify(narrow.tab)},128)`); await assertFrame(narrow.tab, 128, false);
  await app.page!.expression(`globalThis.wideStop=window.butlerBrowser.onFrame(${JSON.stringify(narrow.tab)},()=>{},416)`);
  await assertFrame(narrow.tab, 416, false);
  await app.page!.expression("wideStop()"); await assertFrame(narrow.tab, 128, false);
  // Read-only calls cannot queue an unrelated capture on an unchanged page.
  await waitBrowser(() => app.main(`!${subject}.live.subscriptions.get(${JSON.stringify(narrow.tab)}).capturing`), "width capture settled");
  const observation = await execute<Result>("tab.observe", narrow.tab);
  await waitBrowser(() => app.main(`(()=>{const state=${subject}.live.subscriptions.get(${JSON.stringify(narrow.tab)});return !state.capturing&&!state.dirty&&!state.timer})()`), "observation bitmap delivered");
  const before = await frameCount(narrow.tab);
  const canvas = observation.nodes.find(node => node.role === "canvas"); assert.ok(canvas);
  const collected = await execute<{ status: string }>("tab.image_collect", narrow.tab, { observation: observation.obs, ref: canvas.ref }); assert.equal(collected.status, "ok");
  for (const op of ["tab.read", "pay.inspect"]) await execute(op, narrow.tab);
  await Bun.sleep(2300); assert.equal(await frameCount(narrow.tab), before, "read-only operations emit no frame");
  await app.page!.expression(`liveStops[${JSON.stringify(narrow.tab)}]()`); await app.call("close", { id: narrow.tab });
  // A viewer may arrive before a user tab has been handed to Butler.
  const handed = await app.call<string>("create", { url: `${origin}/__o/static` });
  await app.page!.expression(`subscribeLive(${JSON.stringify(handed)},416)`);
  await waitBrowser(() => app.main(`${subject}.live.subscriptions.has(${JSON.stringify(handed)})`), "pending ownership subscription retained");
  assert.equal(await app.main(`${subject}.live.subscriptions.get(${JSON.stringify(handed)}).timer`), null, "waiting for ownership has no polling");
  assert.equal(await frameCount(handed), 0);
  await app.call("move", { tabId: handed, toGroupId: "conversation:background_frames", index: 0 }); await app.call("hide");
  const driven = await execute<Result>("tab.observe", handed, { policy: { content_origin: origin } }); assert.equal(driven.status, "ok");
  await assertFrame(handed, 416, false);
  await app.page!.expression(`liveStops[${JSON.stringify(handed)}]()`); await app.call("close", { id: handed });
  console.log(JSON.stringify(rows)); console.log("CPU/correctness phases, bitmap reuse, read-only quiet, viewer widths, ownership arrival, background open: PASS");
} finally { await app.stop(); fixture.stop(true); }
