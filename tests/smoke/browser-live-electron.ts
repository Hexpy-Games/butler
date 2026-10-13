// test-category: race
/** Single offline real-App P0 experiment, not a production stream service. */
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cpus } from "node:os";
import { browserAgentApp } from "../support/browser-agent-app";
import { startWriteTrace } from "./browser-p0-write-trace";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence);
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(`<!doctype html><title>Live fixture</title>
<style>body{margin:0;background:#eef}button{font-size:40px;position:absolute;bottom:0}canvas{display:block}</style><button onclick="this.textContent=++window.acts;draw()">0</button><canvas width="1280" height="700"></canvas>
<script>window.busy=true;window.acts=0;const c=document.querySelector('canvas').getContext('2d');let n=0;
function draw(){c.fillStyle='hsl('+n++%360+' 65% 60%)';c.fillRect(0,0,1280,700);c.fillStyle='black';c.font='48px sans-serif';c.fillText(n,40,80);
const at=Date.now();for(let bit=0;bit<42;bit++){c.fillStyle=Math.floor(at/2**bit)%2?'white':'black';c.fillRect(bit*30,100,30,30)}}
let raf;function paint(){draw();raf=requestAnimationFrame(paint)}
window.setBusy=value=>{cancelAnimationFrame(raf);window.busy=value;if(value)paint()};paint()</script>`, { headers: { "content-type": "text/html" } }) });
const app = await browserAgentApp(evidence, () => null);
type Metric = { pid: number; cpu: { percentCPUUsage: number }; memory: { workingSetSize: number } };
type Sample = { stats: { frames: Record<string, number>; drawn: Record<string, number>; handlerMs: number[]; latencies: number[]; captureMs: number[]; captureCpuMs: number[]; errors: string[] }; metrics: Metric[]; rss: number };
const results: Record<string, unknown> = {};
const main = <T>(expression: string) => app.main<T>(`globalThis.liveSpike.${expression}`);
async function measure(name: string, seconds: number, trace = false) {
  await main("reset()");
  const before = await main<Sample>("sample()");
  const disk = trace ? startWriteTrace(before.metrics.map(m => m.pid), seconds) : undefined;
  const samples: Sample[] = [];
  const start = performance.now();
  for (let i = 0; i < seconds; i++) { await Bun.sleep(1000); samples.push(await main<Sample>("sample()")); }
  const elapsedSeconds = (performance.now() - start) / 1000;
  await main("drain()"); const last = await main<Sample>("sample()");
  const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
  const median = (values: number[]) => sorted(values)[Math.floor(values.length / 2)] ?? null;
  const cpu = samples.map(s => s.metrics.reduce((n, m) => n + m.cpu.percentCPUUsage, 0));
  // Electron divides percentCPUUsage by the logical processor count.
  const cpuMachinePercent = cpu.reduce((a, b) => a + b, 0) / cpu.length;
  const result = { seconds, elapsedSeconds, processorCount: cpus().length, cpuMachinePercent,
    fps: Object.fromEntries(Object.entries(last.stats.frames).map(([id, count]) => [id, count / elapsedSeconds])), frames: last.stats.frames, drawn: last.stats.drawn, cpuOneCorePercent: cpuMachinePercent * cpus().length,
    handlerMedianMs: median(last.stats.handlerMs), handlerMaxMs: Math.max(0, ...last.stats.handlerMs),
    paintToCanvasMedianMs: median(last.stats.latencies), captureMedianMs: median(last.stats.captureMs), captureCpuMedianMs: median(last.stats.captureCpuMs),
    memoryBeforeKiB: before.metrics.reduce((n, m) => n + m.memory.workingSetSize, 0), memoryAfterKiB: last.metrics.reduce((n, m) => n + m.memory.workingSetSize, 0),
    memoryMedianKiB: median(samples.map(s => s.metrics.reduce((n, m) => n + m.memory.workingSetSize, 0))),
    mainRssDeltaBytes: last.rss - before.rss, disk: await disk, errors: last.stats.errors };
  results[name] = result; writeFileSync(join(evidence!, "measurements.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ phase: name, ...result })); return result;
}
try {
  await app.call("state");
  const module = `process.getBuiltinModule('module').createRequire(${JSON.stringify(resolve("packages/butler-app/client/electron/package.json"))})`;
  await app.main(`(async()=>{globalThis.liveSpike=await ${module}(${JSON.stringify(resolve("tests/smoke/browser-live-harness.mjs"))}).installLiveSpike(globalThis.browserAgentSubject,${JSON.stringify(`http://127.0.0.1:${fixture.port}`)})})()`);
  results.facts = await main("facts()");
  console.log(JSON.stringify(results.facts));
  await Bun.sleep(2000);
  const baseline = await measure("busyWithoutConsumer", 10);
  await main("subscribe()"); await Bun.sleep(2000);
  results.subscribedFacts = await main("facts()");
  const stream = await measure("busyScreencast", 60, true);
  results.addedCpuOneCorePercent = stream.cpuOneCorePercent - baseline.cpuOneCorePercent;
  await main(`screenshot(${JSON.stringify(join(evidence, "consumer.png"))})`);
  await main("busy(false)"); await Bun.sleep(2000);
  const idle = await measure("staticScreencast", 10);
  await main("stop()"); await Bun.sleep(1000);
  results.unsubscribedFacts = await main("facts()");
  const stopped = await measure("unsubscribed", 3);
  await main("fallback()");
  const fallback = await measure("afterActionFallback", 10, true);
  await main("stop()");
  writeFileSync(join(evidence, "measurements.json"), JSON.stringify(results, null, 2));
  assert.deepEqual(stream.errors, []); assert.deepEqual(fallback.errors, []);
  assert.equal(Object.keys(stream.frames).length, 3, "all three hidden tabs deliver frames");
  assert.deepEqual(stream.frames, stream.drawn, "every forwarded frame is decoded and drawn");
  assert.ok(stream.paintToCanvasMedianMs !== null && stream.paintToCanvasMedianMs >= 0 && stream.paintToCanvasMedianMs <= 300, "paint timestamp survives encoding and reaches canvas within budget");
  assert.equal(Object.values(idle.frames).reduce((a, b) => a + b, 0), 0, "static page emits zero frames");
  assert.deepEqual(stopped.frames, {}, "unsubscribe stops delivery");
  assert.equal(Object.keys(fallback.frames).length, 3, "after-action capture works for each hidden tab");
} finally {
  await main("dispose()").catch(() => {}); await app.stop(); fixture.stop(true);
}
