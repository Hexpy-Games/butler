import { traceProcessStats } from "./browser-p0-trace.ts";
import { strict as assert } from "node:assert";
import type { launchP0App } from "./browser-p0-app.ts";
export type P0App = Awaited<ReturnType<typeof launchP0App>>;
export type Sample = { at: number; mainPID: number; uiPID: number; mainRSS: number; versions: { electron: string }; gpu: Record<string, string>; metrics: Array<{ pid: number; type: string; cpu: { percentCPUUsage: number }; memory: { workingSetSize: number } }>; gone: Array<{ type: string; at: number }>; crashes: Array<{ id: string; code: string }>; initial: Resources; resources: Resources; loop: { p99Ms: number; maxMs: number } };
type Resources = { contents: number; listeners: number; debuggers: number };
export type Row = { test: string; metric: string; value: number | string | null; budget: number | string; status: "PASS" | "FAIL" | "UNAVAILABLE" | "DESCRIPTIVE"; attribution?: string; mitigation?: string };
export function budget(rows: Row[], test: string, metric: string, value: number, limit: number, attribution: string, mitigation: string) {
  rows.push({ test, metric, value, budget: limit, status: value <= limit ? "PASS" : "FAIL", ...(value > limit ? { attribution, mitigation } : {}) });
}
export function percentile(values: number[], quantile: number) {
  assert(values.length > 0, "No measurement samples");
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * quantile) - 1]!;
}
export const sample = (app: P0App) => app.main.evaluate<Sample>("browserP0.sample()");

/** rAF intervals detect UI freezes; presentation evidence comes from the trace. */
export async function startFrames(app: P0App) {
  await app.page.expression("(()=>{window.p0Frames=[];const epoch=window.p0FrameEpoch=(window.p0FrameEpoch||0)+1;let last=performance.now();function tick(now){if(epoch!==window.p0FrameEpoch)return;window.p0Frames.push(now-last);last=now;requestAnimationFrame(tick)}requestAnimationFrame(tick)})()");
}
export async function frames(app: P0App) {
  return app.page.expression<number[]>("window.p0Frames");
}
export async function prepareTyping(app: P0App) {
  await app.page.expression("document.querySelector('[data-slot=\"composer-compact-preview\"]')?.click()");
  await app.page.waitForFunction(() => Boolean(document.querySelector('[contenteditable="true"]')));
  await app.page.expression("(()=>{const e=document.querySelector('[contenteditable=\"true\"]');if(!e)throw Error('Composer missing');e.focus();window.p0Input=[];document.addEventListener('input',()=>{const at=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>window.p0Input.push(performance.now()-at)))},true)})()");
  await app.main.evaluate("browserP0.beginTyping()");
}
export async function typing(app: P0App, count = 60, prepared = false) {
  if (!prepared) await prepareTyping(app);
  // Chromium IME preedit and commit use the trusted input path.
  const painted: number[] = [];
  try { for (let i = 0; i < count; i++) {
    const samples = await app.main.evaluate<number[]>("browserP0.insertTextPaint('한')");
    assert.equal(samples.length, 4, "Each Korean syllable has three preedit paints and one committed paint");
    painted.push(...samples);
    await Bun.sleep(50);
  }
  } finally { await app.main.evaluate("browserP0.endTyping()"); }
  await Bun.sleep(100);
  const values = await app.page.expression<number[]>("window.p0Input");
  const text = await app.page.expression<string>("document.querySelector('[contenteditable=\"true\"]').textContent");
  assert.equal(painted.length, count * 4, "Every native insertion has a completed compositor capture");
  assert.equal((text.match(/한/gu) || []).length, count, "Every Korean character retained");
  return { values: painted, domInputEvents: values.length, inputToRafP95: percentile(painted, 0.95) };
}

/** Inclusive trace buckets are diagnostic evidence, never additive CPU totals. */
export function attributeTrace(trace: { traceEvents: Array<{ name: string; ph: string; dur?: number; pid: number; tid: number; args?: any }> }, uiPID: number, mainPID: number) {
  const events = trace.traceEvents;
  const totals = (pattern: RegExp, pid?: number) => events.filter(e => e.ph === "X" && (pid === undefined || e.pid === pid) && pattern.test(e.name)).reduce((n, e) => n + (e.dur || 0) / 1000, 0);
  return { processStats: traceProcessStats(events as any),
    uiLongTasks: events.filter(e=>e.pid===uiPID && e.ph==="X" && (e.dur||0)>=100000).sort((a,b)=>(b.dur||0)-(a.dur||0)).slice(0,12).map(e=>({name:e.name,ms:(e.dur||0)/1000})),
    mainLongTasks: events.filter(e=>e.pid===mainPID && e.ph==="X" && (e.dur||0)>=30000).sort((a,b)=>(b.dur||0)-(a.dur||0)).slice(0,12).map(e=>({name:e.name,ms:(e.dur||0)/1000})),
    memoryShape: events.filter(e=>e.ph==="v").slice(0,2).map(e=>({name:e.name,pid:e.pid,keys:Object.keys(e.args||{}),dumpKeys:Object.keys(e.args?.dumps||{}),processTotals:e.args?.dumps?.process_totals})), butlerJSms: totals(/FunctionCall|EvaluateScript|V8.Execute/, uiPID), blinkMs: totals(/Layout|Paint|UpdateLayoutTree|PrePaint/, uiPID), gpuMs: totals(/Gpu|GPU|DrawFrame|SwapBuffers/),
    processes: events.filter(e => e.name === "process_name").map(e => ({ pid: e.pid, name: e.args?.name })),
    memoryDumps: events.filter(e => e.ph === "v").length, eventCount: events.length };
}
