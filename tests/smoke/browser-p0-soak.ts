import { snapshotFiles, fileDelta } from "./browser-p0-file-snapshot.ts";
import { quietHost } from "./browser-p0-host-load.ts";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { budget, sample, type P0App, type Row, type Sample } from "./browser-p0-measure.ts";

function agentRSS(pid: number): number {
  if (process.platform === "win32") return Number(execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: "utf8" }).trim());
  return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) * 1024;
}
const gpuRSS = (s: Sample) => s.metrics.filter(m => m.type === "GPU").reduce((n, m) => n + m.memory.workingSetSize * 1024, 0);
const gpuCPU = (s: Sample) => s.metrics.filter(m => m.type === "GPU").reduce((n, m) => n + m.cpu.percentCPUUsage, 0);

export async function leakSoak(app: P0App, origin: string, rows: Row[], minutes: number) {
  assert([10, 120].includes(minutes), "Use the 10-minute variant or full 2-hour gate");
  const pid = JSON.parse(readFileSync(join(app.data, "app/runtime/foreground/instance.json"), "utf8")).agent_host_pid;
  assert(Number.isSafeInteger(pid) && pid > 0);
  await Bun.sleep(60_000);
  const initialIdleLoad = await quietHost("initial 10 min idle", app);
  const idleBefore = await snapshotFiles(app, "idle-before");
  await Bun.sleep(600_000);
  const idleAfter = await snapshotFiles(app, "idle-after");
  const initialIdle = fileDelta(idleBefore, idleAfter);
  console.log(JSON.stringify({ initialIdle, initialIdleLoad }));
  const hostLoad = await quietHost("2 h soak", app);
  const warm = await sample(app), agentWarm = agentRSS(pid);
  const baselineCPU: number[] = [];
  for (let i = 0; i < 5; i++) { await Bun.sleep(1000); baselineCPU.push(gpuCPU(await sample(app))); }
  const startedAt = Date.now(), end = startedAt + minutes * 60_000;
  let iterations = 0;
  const paths = ["nodes", "cpu", "network"], fixtureVisits = { nodes: 0, cpu: 0, network: 0 };
  while (Date.now() < end) {
    const id = `soak-${iterations}`;
    const path = paths[iterations % paths.length]! as keyof typeof fixtureVisits;
    await app.main.evaluate(`browserP0.open('${id}', '${origin}/${path}')`);
    fixtureVisits[path]++;
    await app.main.evaluate(`browserP0.step('${id}')`);
    await app.main.evaluate(`browserP0.close('${id}')`);
    iterations++;
    if (iterations % 50 === 0) await visitRealSite(app, iterations);
    if (iterations % 50 === 0) console.log(JSON.stringify({ soakIterations: iterations, fixtureVisits }));
    await Bun.sleep(1000);
  }
  const elapsedMs = Date.now() - startedAt;
  const after = await sample(app);
  budget(rows, "soak", "main RSS growth MiB", (after.mainRSS - warm.mainRSS) / 1048576, 64, "Electron main JS/native allocations", "Inspect retained views/listeners before fallback");
  budget(rows, "soak", "Agent RSS growth MiB", (agentRSS(pid) - agentWarm) / 1048576, 32, "Butler Agent (not Chromium trace)", "Inspect runtime allocations");
  budget(rows, "soak", "GPU RSS growth MiB", (gpuRSS(after) - gpuRSS(warm)) / 1048576, 128, "GPU", "Disable agent WebGL/WebGPU, repeat");
  for (const key of ["contents", "listeners", "debuggers"] as const) rows.push({ test: "soak", metric: `${key} delta`, value: after.resources[key] - warm.resources[key], budget: 0, status: after.resources[key] === warm.resources[key] ? "PASS" : "FAIL", attribution: "Electron main lifetime", mitigation: "Release views/listeners/debugger sessions" });
  // User video remains open as required. Compare GPU idle against that baseline.
  const afterSoak = fileDelta(idleAfter, await snapshotFiles(app, "soak-after"));
  console.log(JSON.stringify({ elapsedMs, iterations, afterSoak, rows: rows.filter(r => r.test === "soak") }));
  const idleHostLoad = await quietHost("post-soak 10 min idle", app);
  const beforeWrites = await snapshotFiles(app, "post-idle-before");
  console.log(JSON.stringify({ soakLoopClosed: iterations, fixtureVisits, idleObservationMinutes: 10 }));
  await Bun.sleep(600_000);
  const idleCPU: number[] = [];
  for (let i = 0; i < 5; i++) { await Bun.sleep(1000); idleCPU.push(gpuCPU(await sample(app))); }
  const mean = (ns: number[]) => ns.reduce((a, b) => a + b, 0) / ns.length;
  budget(rows, "soak", "GPU CPU delta percentage points after close", mean(idleCPU) - mean(baselineCPU), 1, "GPU", "Disable agent WebGL/WebGPU");
  const postIdle = fileDelta(beforeWrites, await snapshotFiles(app, "post-idle-after"));
  for (const [label, delta] of [["initial idle", initialIdle], ["post-soak idle", postIdle]] as const) {
    const data = delta.scopes.find(s => s.scope === "data")!;
    rows.push({ test: "soak", metric: `${label} Butler DATA changed files`, value: delta.writers.Butler ?? data.changedFiles, budget: 0, status: delta.writers.Butler === 0 ? "PASS" : "FAIL" });
    rows.push({ test: "soak", metric: `${label} unresolved writer changed files`, value: delta.writers.unresolved ?? 0, budget: 0, status: delta.writers.unresolved ? "UNAVAILABLE" : "PASS" });
    rows.push({ test: "soak", metric: `${label} Chromium profile deltas`, value: JSON.stringify(delta), budget: "report internal flushes", status: "DESCRIPTIVE" });
  }
  return { minutes, elapsedMs, iterations, fixtureVisits, initialIdle, afterSoak, postIdle, idleCPU, baselineCPU, hostLoad, initialIdleLoad, idleHostLoad, realSites: Math.floor(iterations / 50), shortVariant: minutes === 10 };
}

async function visitRealSite(app: P0App, iteration: number) {
  const origin = iteration % 100 === 0 ? "https://www.iana.org/domains/reserved" : "https://www.iana.org/help/example-domains";
  await app.main.evaluate(`browserP0.open('real', '${origin}')`);
  try {
    const result = await app.main.evaluate("browserP0.step('real')");
    console.log(JSON.stringify({ realSite: origin, verified: !!result }));
  } finally { await app.main.evaluate("browserP0.close('real')"); }
}
