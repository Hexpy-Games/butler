import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { cpus, loadavg } from "node:os";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchP0App, waitFor } from "./browser-p0-app.ts";
import { seedP0OwnerScale } from "./browser-p0-owner-scale.ts";

// Real App/stub smoke. Build UI + Electron first and provide the native Agent.
// BUTLER_SCROLL_OUTPUT must be outside the repository. No WebContentsView harness.
const output = process.env.BUTLER_SCROLL_OUTPUT;
if (output) assert(!resolve(output).startsWith(`${process.cwd()}/`));
const app = await launchP0App({ harness: false });
let tracing = false;
try {
  const scale = seedP0OwnerScale(app.data);
  await app.main.evaluate(`globalThis.require=process.getBuiltinModule('module').createRequire(process.cwd()+'/main.mjs');
    globalThis.scrollWindow=require('electron').BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('app://butler/'));true`);
  await app.page.reload();
  await waitFor(() => app.page.expression("Array.from(document.querySelectorAll('[data-test-class=\"tree-row\"]')).some(e=>e.textContent.includes('P0 대화 599'))"), "sidebar");
  await app.page.expression("Array.from(document.querySelectorAll('[data-test-class=\"tree-row\"]')).find(e=>e.textContent.includes('P0 대화 599')).click()");
  await waitFor(() => app.page.expression("document.body.textContent.includes('메시지 2999')"), "latest", 60_000);
  const source = await app.page.expression<any>("window.butlerApp.listMessages({chatId:'p0-c599',cursor:0})");
  const messages = Array.isArray(source) ? source : source.messages;
  assert.equal(messages.length, 200, "Existing native response window retains every message");
  for (const [offset, message] of messages.entries()) {
    const index = 2800 + offset;
    assert.equal(message.id, `p0-m${index}`);
    assert.equal(message.text, `메시지 ${index}\n${"한글".repeat(16200)}`);
  }
  await app.page.expression("(()=>{window.scrollSettled=false;let last,stable=0;function tick(now){stable=last!==undefined&&now-last<100?stable+1:0;last=now;if(stable>=120)window.scrollSettled=true;else requestAnimationFrame(tick)}requestAnimationFrame(tick);return true})()");
  await waitFor(() => app.page.expression("window.scrollSettled"), "settled transcript");
  const ownPids = await app.main.evaluate<number[]>("require('electron').app.getAppMetrics().map(p=>p.pid)");
  let host = readHost([process.pid, ...ownPids]);
  await waitFor(async () => {
    host = readHost([process.pid, ...ownPids]);
    return host.load1 < host.cores * 0.7 && host.otherCpuMax < 80 && host.otherCpuTotal < host.cores * 30;
  }, "idle measurement host");
  console.log(JSON.stringify({ scale, host }));
  await app.main.evaluate("scrollWindow.focus();require('electron').contentTracing.startRecording({included_categories:['devtools.timeline','disabled-by-default-devtools.timeline','disabled-by-default-devtools.timeline.stack','v8.execute','blink','toplevel','disabled-by-default-v8.cpu_profiler']})");
  tracing = true;
  await app.page.expression("(()=>{window.scrollResult=null;const e=document.querySelector('[data-test-class~=\"conversation-scroll\"]');const start=e.scrollTop;const frames=[];let last,n=0;function tick(now){if(last!==undefined)frames.push(now-last);last=now;e.scrollTop=Math.max(0,e.scrollTop-400);if(++n<121)requestAnimationFrame(tick);else window.scrollResult={frames,distance:start-e.scrollTop}}e.dispatchEvent(new WheelEvent('wheel',{deltaY:-400,bubbles:true}));requestAnimationFrame(tick);return true})()");
  await waitFor(() => app.page.expression("window.scrollResult"), "120 scroll frames");
  const result = await app.page.expression<any>("window.scrollResult");
  const pid = await app.main.evaluate<number>("scrollWindow.webContents.getOSProcessId()");
  const tracePath = join(app.dir, "scroll-trace.json");
  await app.main.evaluate(`require('electron').contentTracing.stopRecording(${JSON.stringify(tracePath)})`);
  tracing = false;
  const trace = JSON.parse(readFileSync(tracePath, "utf8"));
  const renderer = trace.traceEvents.filter((e: any) => e.pid === pid);
  const tid = renderer.find((e: any) => e.name === "thread_name" && e.args.name === "CrRendererMain").tid;
  const tasks = renderer.filter((e: any) => e.ph === "X" && e.tid === tid);
  const sorted = [...result.frames].sort((a, b) => a - b);
  const metrics = { host, scale, ...result, p95: sorted[Math.ceil(sorted.length * .95) - 1],
    max: Math.max(...sorted), rendererCpuPercent: traceCpu(tasks),
    longestTaskMs: Math.max(...tasks.filter((e: any) => e.name === "RunTask").map((e: any) => e.dur)) / 1000,
    forcedLayouts: tasks.filter((e: any) => e.name === "Layout" && e.dur > 100000)
      .map((e: any) => ({ ms: e.dur / 1000, stack: e.args.beginData.stackTrace })) };
  console.log(JSON.stringify({ host: metrics.host, p95: metrics.p95, max: metrics.max,
    rendererCpuPercent: metrics.rendererCpuPercent, longestTaskMs: metrics.longestTaskMs, forcedLayoutCount: metrics.forcedLayouts.length }));
  if (output) {
    mkdirSync(output, { recursive: true });
    copyFileSync(tracePath, join(output, "trace.json"));
    writeFileSync(join(output, "result.json"), JSON.stringify(metrics));
  }
  assert.equal(result.frames.length, 120);
  assert(result.distance >= 48000, "Scroll traverses the requested content");
  assert(metrics.max <= 100, `Scroll frame ${metrics.max.toFixed(1)}ms exceeds 100ms`);
} finally {
  if (tracing) await app.main.evaluate(`require('electron').contentTracing.stopRecording(${JSON.stringify(join(app.dir, "failed-trace.json"))})`).catch(() => {});
  await app.stop();
}

function traceCpu(tasks: Array<{ ts: number; dur: number; tts?: number; tdur?: number }>) {
  const intervals = tasks.filter(e => e.tts !== undefined && e.tdur !== undefined)
    .map(e => [e.tts!, e.tts! + e.tdur!]).sort((a, b) => a[0] - b[0]);
  let used = 0, start = 0, end = 0;
  for (const [nextStart, nextEnd] of intervals) {
    if (nextStart > end) { used += end - start; start = nextStart; }
    end = Math.max(end, nextEnd);
  }
  used += end - start;
  const duration = Math.max(...tasks.map(e => e.ts + e.dur)) - Math.min(...tasks.map(e => e.ts));
  return 100 * used / duration;
}

function readHost(ownPids: number[]) {
  const rows = execFileSync("ps", ["-Ao", "pid,pcpu,comm", "-r"], { encoding: "utf8" }).trim().split("\n").slice(1);
  const others = rows.filter(row => !ownPids.includes(Number(row.trim().split(/\s+/u)[0])));
  const cpu = others.map(row => Number(row.trim().split(/\s+/u)[1]));
  return { load1: loadavg()[0], cores: cpus().length, otherCpuMax: Math.max(...cpu),
    otherCpuTotal: cpu.reduce((sum, value) => sum + value, 0), otherProcesses: others.slice(0, 15) };
}
