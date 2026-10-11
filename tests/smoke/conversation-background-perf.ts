// test-category: race
// Real Electron, isolated native stub gateway, one recording per requested period.
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserAgentApp } from "../support/browser-agent-app";

const out = process.env.BUTLER_BACKGROUND_PERF_OUT;
assert(out, "Temporary evidence destination required"); mkdirSync(out, { recursive: true });
// Inherit the idle probe without replacing the adapter's offline provider environment.
process.env.BUTLER_E2E_IDLE_PROBE = "1";
const app = await browserAgentApp(out, () => null, undefined, {
  stubReply: () => Array.from({ length: 100 }, (_, i) => `Paragraph ${i + 1}: Synthetic scroll content.`).join("\n\n"),
});
const results: Record<string, unknown> = {};
const failures: string[] = [];
const check = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
function files(root: string, relative = ""): Record<string, { size: number; modified: number; hash: string }> {
  const result: ReturnType<typeof files> = {};
  for (const name of readdirSync(join(root, relative))) {
    const path = join(relative, name), stat = statSync(join(root, path));
    if (stat.isDirectory()) Object.assign(result, files(root, path));
    else result[path] = { size: stat.size, modified: stat.mtimeMs, hash: createHash("sha256").update(readFileSync(join(root, path))).digest("hex") };
  }
  return result;
}
async function instrument() {
  await app.page.expression(`(() => {
    const state = globalThis.__backgroundPerf = { draws:0,raf:0,shaders:0,fades:0,pending:false,canvas:document.querySelector('[data-test-class~="conversation-wallpaper"]') };
    const draw = WebGL2RenderingContext.prototype.drawArrays, compile = WebGL2RenderingContext.prototype.compileShader;
    WebGL2RenderingContext.prototype.drawArrays = function(...args) {
      if(this.canvas === state.canvas && !state.pending) { state.draws++;state.pending=true;queueMicrotask(()=>state.pending=false); }
      return draw.apply(this,args);
    };
    WebGL2RenderingContext.prototype.compileShader = function(...args) { if(this.canvas === state.canvas) state.shaders++;return compile.apply(this,args); };
    const raf = requestAnimationFrame;
    window.requestAnimationFrame = function(callback) { state.raf++;return raf.call(window,callback); };
    new MutationObserver(records=>state.fades+=records.length).observe(document.querySelector('[data-drift-layer="top"]'),{attributes:true,attributeFilter:['style']});
  })()`);
}
const counts = () => app.page.expression<{ draws: number; raf: number; shaders: number; fades: number }>("(({draws,raf,shaders,fades})=>({draws,raf,shaders,fades}))(__backgroundPerf)");
async function idle(module: string) {
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ conversation_background: { source: { kind: "live", module }, overlay: 70 } }) });
  await app.page.waitForFunction(() => document.querySelector('[data-test-class~="conversation-wallpaper"]')?.getAttribute("data-wallpaper-state") === "painted");
  await new Promise(done => setTimeout(done, 7000));
  const before = await counts(); const disk = files(app.gateway.butlerData);
  await app.main(`(() => { const d=${app.win}.webContents.debugger;if(!d.isAttached()) d.attach('1.3');
    globalThis.__backgroundTrace=[];globalThis.__backgroundTraceDone=null;
    globalThis.__backgroundTraceListener=(event,method,params)=>{if(method==='Tracing.dataCollected') __backgroundTrace.push(...params.value);if(method==='Tracing.tracingComplete') __backgroundTraceDone?.();};
    d.on('message',globalThis.__backgroundTraceListener);
    return d.sendCommand('Tracing.start',{categories:'benchmark,cc,devtools.timeline,disabled-by-default-devtools.timeline.frame',transferMode:'ReportEvents'});
  })()`);
  await app.main(`process.getBuiltinModule('module').createRequire(${JSON.stringify(join(process.cwd(), "packages/butler-app/client/electron/package.json"))})('electron').app.getAppMetrics()`);
  await new Promise(done => setTimeout(done, 60_000));
  const after = await counts();
  const cpu = await app.main<Array<{ type: string; cpu: { percentCPUUsage: number } }>>(`process.getBuiltinModule('module').createRequire(${JSON.stringify(join(process.cwd(), "packages/butler-app/client/electron/package.json"))})('electron').app.getAppMetrics()`);
  const compositorFrames = await app.main<number>(`(async()=>{ const d=${app.win}.webContents.debugger;
    const complete=new Promise(done=>globalThis.__backgroundTraceDone=done);await d.sendCommand('Tracing.end');await complete;
    d.removeListener('message',globalThis.__backgroundTraceListener);return __backgroundTrace.filter(e=>e.name==='DrawFrame').length;
  })()`);
  const current = files(app.gateway.butlerData);
  const changedFiles = [...new Set([...Object.keys(disk), ...Object.keys(current)])].filter(path => JSON.stringify(disk[path]) !== JSON.stringify(current[path]));
  const row = { seconds: 60, frames: after.draws-before.draws, raf: after.raf-before.raf, fadeSteps: after.fades-before.fades,
    compositorFrames, shaders: after.shaders-before.shaders, cpu: cpu.filter(p => p.type === "Tab" || p.type === "GPU").map(p => ({ type: p.type, percent: p.cpu.percentCPUUsage })), changedFiles };
  results[module] = row; writeFileSync(join(out!, "perf.json"), JSON.stringify(results, null, 2));
  check(changedFiles.length === 0, `${module}: Zero data file writes in idle`);
  if (module === "butler.riso-print") { check(row.frames >= 6 && row.frames <= 8, "Riso keyframe budget"); check(row.raf === 0, "Riso idle has zero rAF"); }
  else check(row.raf <= row.frames * 1.1, "Bloom rAF per minute tracks frames");
  return row;
}
async function scroll() {
  const before = await counts();
  const timing = await app.page.expression<{ fps: number; p95: number; frames: number }>(`(async()=>{
    const root=document.querySelector('[data-test-class~="message-virtual-scroll"]');
    if(root.scrollHeight<=root.clientHeight) throw new Error('Complete fixture must scroll');
    const deltas=[];let last=performance.now(),start=last,direction=-1;
    while(performance.now()-start<6000) { await new Promise(requestAnimationFrame);const now=performance.now();deltas.push(now-last);last=now;
      root.scrollTop+=30*direction;if(root.scrollTop<=0 || root.scrollTop>=root.scrollHeight-root.clientHeight-1) direction*=-1; }
    const elapsed=performance.now()-start;deltas.sort((a,b)=>a-b);return {fps:deltas.length*1000/elapsed,p95:deltas[Math.floor(deltas.length*.95)],frames:deltas.length};
  })()`);
  const after = await counts(); results.scroll = { ...timing, wallpaperFrames:after.draws-before.draws };
  writeFileSync(join(out!, "perf.json"), JSON.stringify(results, null, 2));
  check(Math.round(timing.fps) >= 60, "60fps scroll"); check(timing.p95 <= 18.5, "Scroll p95 budget");
  check(after.draws-before.draws <= 1, "Scroll never causes wallpaper redraws");
}
try {
  await app.page.waitForFunction(() => !!document.querySelector('[data-test-class~="conversation-wallpaper"]'));
  await app.page.waitForFunction(() => document.querySelector('[data-test-class~="conversation-wallpaper"]')?.getAttribute("data-painted-module") === "butler.riso-print");
  assert.equal(await app.page.expression("devicePixelRatio"), 2);
  await instrument();
  const before = await counts();
  if (await app.page.expression("(document.querySelector('[data-slot=\"composer-compact-preview\"]')?.getBoundingClientRect().width ?? 0) > 0")) await app.page.clickSelector('[data-slot="composer-compact-preview"]');
  await app.page.waitForFunction(() => {
    const node = document.querySelector('[data-test-class~="composer-card"] [contenteditable="true"]');
    const r = node?.getBoundingClientRect();
    return node && r && r.width > 0 && r.height > 0 && node.contains(document.elementFromPoint(r.x+r.width/2, r.y+r.height/2));
  });
  await app.page.clickSelector('[data-test-class~="composer-card"] [contenteditable="true"]');
  await app.page.insertText("Create the complete synthetic scrolling fixture."); await app.click("전송");
  await app.page.waitForFunction(() => !!document.querySelector('[data-test-class~="message-list"]'));
  await app.page.waitForFunction(() => document.body.textContent?.includes("Paragraph 100: Synthetic scroll content."));
  const after = await counts();
  const same = await app.page.expression("__backgroundPerf.canvas === document.querySelector('[data-test-class~=\"conversation-wallpaper\"]')");
  results.firstSend = { sameCanvas: same, shaderCompiles: after.shaders-before.shaders };
  assert(same); assert.equal(after.shaders-before.shaders, 0, "No shader recompile on first send");
  await idle("butler.riso-print"); await scroll(); await idle("butler.bloom");
  results.failures = failures; assert.deepEqual(failures, [], "All recorded budgets pass");
} catch (error) {
  writeFileSync(join(out, "failure.png"), await app.page.screenshot());
  results.error = String(error); results.diagnostics = await app.page.diagnostics(); throw error;
} finally {
  writeFileSync(join(out, "perf.json"), JSON.stringify(results, null, 2)); await app.stop();
}
console.log(JSON.stringify(results));
