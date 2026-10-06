import { startWriteTrace } from "./browser-p0-write-trace.ts";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { budget, sample, type P0App, type Row, type Sample } from "./browser-p0-measure.ts";

function writesSnapshot(root: string, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of readdirSync(root)) {
    const path = join(root, name), key = join(prefix, name), stat = statSync(path);
    if (stat.isDirectory()) Object.assign(result, writesSnapshot(path, key));
    else result[key] = `${stat.size}:${stat.mtimeMs}`;
  }
  return result;
}

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
  const warm = await sample(app), agentWarm = agentRSS(pid);
  const baselineCPU: number[] = [];
  for (let i = 0; i < 5; i++) { await Bun.sleep(1000); baselineCPU.push(gpuCPU(await sample(app))); }
  const end = Date.now() + minutes * 60_000;
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
    if (iterations % 50 === 0) console.log(JSON.stringify({ soakIterations: iterations, fixtureVisits }));
    await Bun.sleep(1000);
  }
  const after = await sample(app);
  budget(rows, "soak", "main RSS growth MiB", (after.mainRSS - warm.mainRSS) / 1048576, 64, "Electron main JS/native allocations", "Inspect retained views/listeners before fallback");
  budget(rows, "soak", "Agent RSS growth MiB", (agentRSS(pid) - agentWarm) / 1048576, 32, "Butler Agent (not Chromium trace)", "Inspect runtime allocations");
  budget(rows, "soak", "GPU RSS growth MiB", (gpuRSS(after) - gpuRSS(warm)) / 1048576, 128, "GPU", "Disable agent WebGL/WebGPU, repeat");
  for (const key of ["contents", "listeners", "debuggers"] as const) rows.push({ test: "soak", metric: `${key} delta`, value: after.resources[key] - warm.resources[key], budget: 0, status: after.resources[key] === warm.resources[key] ? "PASS" : "FAIL", attribution: "Electron main lifetime", mitigation: "Release views/listeners/debugger sessions" });
  // User video remains open as required. Compare GPU idle against that baseline.
  const beforeWrites = writesSnapshot(app.data);
  const writeTrace = startWriteTrace([warm.mainPID, pid], 600);
  console.log(JSON.stringify({ soakLoopClosed: iterations, fixtureVisits, idleObservationMinutes: 10 }));
  await Bun.sleep(600_000);
  const idleCPU: number[] = [];
  for (let i = 0; i < 5; i++) { await Bun.sleep(1000); idleCPU.push(gpuCPU(await sample(app))); }
  const mean = (ns: number[]) => ns.reduce((a, b) => a + b, 0) / ns.length;
  budget(rows, "soak", "GPU CPU delta percentage points after close", mean(idleCPU) - mean(baselineCPU), 1, "GPU", "Disable agent WebGL/WebGPU");
  const afterWrites = writesSnapshot(app.data);
  const changed = [...new Set([...Object.keys(beforeWrites), ...Object.keys(afterWrites)])].filter(k => beforeWrites[k] !== afterWrites[k]);
  const traced = await writeTrace;
  rows.push({ test: "soak", metric: "Butler-initiated writes after close", value: traced.writes, budget: 0,
    status: !traced.available ? "UNAVAILABLE" : traced.writes === 0 && changed.length === 0 ? "PASS" : "FAIL",
    attribution: `${traced.reason}; ${changed.length} DATA file metadata deltas`, mitigation: "Process-attributed filesystem tracing with resolved paths" });
  return { writeTrace: traced, minutes, iterations, fixtureVisits, changedFiles: changed, idleCPU, baselineCPU, realSites: "Skipped by task instruction", shortVariant: minutes === 10 };
}
