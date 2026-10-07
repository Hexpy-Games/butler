import { snapshotFiles, fileDelta } from "./browser-p0-file-snapshot.ts";
import { hostWindow } from "./browser-p0-host-load.ts";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { budget, sample, type P0App, type Row, type Sample } from "./browser-p0-measure.ts";
import { memoryCheckpoint } from "./browser-p0-memory";
import { openBrowserArea, visitUserSite } from "./browser-p0-user";
import { waitFor } from "./browser-p0-app";
import { seedP0OwnerScale, waitP0OwnerScaleSpace } from "./browser-p0-owner-scale";

function agentRSS(pid: number): number {
  if (process.platform === "win32") return Number(execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: "utf8" }).trim());
  return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) * 1024;
}
const gpuRSS = (s: Sample) => s.metrics.filter(m => m.type === "GPU").reduce((n, m) => n + m.memory.workingSetSize * 1024, 0);
const gpuCPU = (s: Sample) => s.metrics.filter(m => m.type === "GPU").reduce((n, m) => n + m.cpu.percentCPUUsage, 0);

export async function leakSoak(app: P0App, origin: string, rows: Row[], minutes: number) {
  assert([10, 120].includes(minutes), "Use the 10-minute variant or full 2-hour gate");
  const evidence = process.env.BUTLER_P0_EVIDENCE!;
  assert(evidence, "BUTLER_P0_EVIDENCE required"); mkdirSync(evidence, { recursive: true });
  const pid = JSON.parse(readFileSync(join(app.data, "app/runtime/foreground/instance.json"), "utf8")).agent_host_pid;
  assert(Number.isSafeInteger(pid) && pid > 0);
  await waitP0OwnerScaleSpace(app.data);
  const ownerScale = seedP0OwnerScale(app.data);
  await app.page.reload(); await openBrowserArea(app);
  await visitUserSite(app, `${origin}/nodes`, evidence);
  for (const path of ["nodes", "cpu", "network"]) {
    await app.main.evaluate(`browserP0.open('warm', '${origin}/${path}')`);
    try { await app.main.evaluate("browserP0.step('warm')"); }
    finally { await app.main.evaluate("browserP0.close('warm')"); }
  }
  await app.main.evaluate("browserP0.close('user')");
  await Bun.sleep(60_000);
  const initial = await idleSnapshot(app, "initial");
  const { before: idleBefore, after: idleAfter, delta: initialIdle } = initial;
  console.log(JSON.stringify({ initialIdle }));
  const measured = await hostWindow("2 h soak", async () => {
    const baselineCPU = await cpuSamples(app);
    const warm = await sample(app), agentWarm = agentRSS(pid);
    const productWarm = await app.main.evaluate("browserP0.productInventory()");
    const sessionsWarm = await app.main.evaluate<number>("browserP0.sample().sessionsCreated");
    await app.main.evaluate("browserP0.resetDelay()");
    await app.main.evaluate(`browserP0.openProductGPU('user', '${origin}/video')`);
    await waitFor(() => app.main.evaluate("browserP0.evaluate('user','video.readyState>=3&&!video.paused')"), "real USER decoded video playing");
    const loop = await runSoakLoop(app, origin, minutes, evidence);
    await app.main.evaluate("browserP0.close('user')");
    await app.page.expression("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    const after = await sample(app), agentAfter = agentRSS(pid);
    const productAfter = await app.main.evaluate("browserP0.productInventory()");
    return { baselineCPU, warm, agentWarm, productWarm, sessionsWarm, loop, after, agentAfter, productAfter };
  });
  const { baselineCPU, warm, agentWarm, productWarm, sessionsWarm, loop, after, agentAfter, productAfter } = measured;
  assert.equal((await app.main.evaluate<{ count: number }>("browserP0.productErrors()")).count, 0, "No rejected product lifecycle IPC during soak");
  assert.deepEqual(productAfter, productWarm, "Product tabs/profiles/stills return to warm baseline");
  assert.equal(await app.main.evaluate("browserP0.sample().sessionsCreated"), sessionsWarm, "No per-iteration Session creation");
  budget(rows, "soak", "main loop p99 ms", after.loop.p99Ms, 30, "Electron main", "Inspect product capture/router/IPC");
  budget(rows, "soak", "main loop max ms", after.loop.maxMs, 200, "Electron main", "Inspect product capture/router/IPC");
  budget(rows, "soak", "main RSS growth MiB", (after.mainRSS - warm.mainRSS) / 1048576, 64, "Electron main JS/native allocations", "Inspect retained sessions/views/listeners");
  budget(rows, "soak", "Agent RSS growth MiB", (agentAfter - agentWarm) / 1048576, 32, "Butler Agent", "Inspect runtime allocations");
  budget(rows, "soak", "GPU RSS growth MiB", (gpuRSS(after) - gpuRSS(warm)) / 1048576, 128, "GPU", "Inspect GPU resources");
  for (const key of ["contents", "listeners", "debuggers"] as const) rows.push({ test: "soak", metric: `${key} delta`, value: after.resources[key] - warm.resources[key], budget: 0, status: after.resources[key] === warm.resources[key] ? "PASS" : "FAIL", attribution: "Electron main lifetime", mitigation: "Release views/listeners/debugger sessions" });
  const afterSoak = fileDelta(idleAfter, await snapshotFiles(app, "soak-after"));
  console.log(JSON.stringify({ ...loop, afterSoak, rows: rows.filter(r => r.test === "soak") }));
  const post = await idleSnapshot(app, "post-soak");
  const idleCPU = await cpuSamples(app);
  const mean = (ns: number[]) => ns.reduce((a, b) => a + b, 0) / ns.length;
  budget(rows, "soak", "GPU CPU delta percentage points after close", mean(idleCPU) - mean(baselineCPU), 1, "GPU", "Inspect GPU resources");
  const postIdle = post.delta;
  for (const [label, delta] of [["initial idle", initialIdle], ["post-soak idle", postIdle]] as const) {
    const data = delta.scopes.find(s => s.scope === "data")!;
    rows.push({ test: "soak", metric: `${label} Butler DATA changed files`, value: delta.writers.Butler ?? data.changedFiles, budget: 0, status: delta.writers.Butler === 0 ? "PASS" : "FAIL" });
    rows.push({ test: "soak", metric: `${label} unresolved writer changed files`, value: delta.writers.unresolved ?? 0, budget: 0, status: delta.writers.unresolved ? "UNAVAILABLE" : "PASS" });
    rows.push({ test: "soak", metric: `${label} Chromium profile deltas`, value: JSON.stringify(delta), budget: "report internal flushes", status: "DESCRIPTIVE" });
  }
  return { ownerScale, productWarm, productAfter, ...loop, minutes, initialIdle, afterSoak, postIdle, idleCPU, baselineCPU, initialIdleSnapshots: { before: idleBefore, after: idleAfter }, shortVariant: minutes === 10 };
}

async function runSoakLoop(app: P0App, origin: string, minutes: number, evidence: string) {
  const startedAt = Date.now(), end = startedAt + minutes * 60_000;
  let iterations = 0, userVisits = 0, nextCheckpoint = startedAt + 15 * 60_000;
  const videoFrames = [await decodedVideoFrames(app)];
  const checkpoints = [await memoryCheckpoint(app, evidence, "soak-start")];
  const paths = ["nodes", "cpu", "network"], fixtureVisits = { nodes: 0, cpu: 0, network: 0 };
  while (Date.now() < end) {
    const id = `soak-${iterations}`, path = paths[iterations % paths.length]! as keyof typeof fixtureVisits;
    await app.main.evaluate(`browserP0.open('${id}', '${origin}/${path}')`); fixtureVisits[path]++;
    try { await app.main.evaluate(`browserP0.step('${id}')`); }
    finally { await app.main.evaluate(`browserP0.close('${id}')`); }
    await visitUserSite(app, `${origin}/${path}`); userVisits++; iterations++;
    if (iterations % 50 === 0) {
      const url = iterations % 100 === 0 ? "https://www.iana.org/domains/reserved" : "https://www.iana.org/help/example-domains";
      await visitRealSite(app, url); await visitUserSite(app, url); userVisits++;
      console.log(JSON.stringify({ soakIterations: iterations, fixtureVisits, userVisits }));
    }
    if (Date.now() >= nextCheckpoint) {
      const decoded = await decodedVideoFrames(app);
      assert(decoded > videoFrames.at(-1)!, "Real USER video decodes during each soak interval");
      videoFrames.push(decoded);
      checkpoints.push(await memoryCheckpoint(app, evidence, `soak-${Math.round((Date.now() - startedAt) / 60000)}m`));
      nextCheckpoint += 15 * 60_000;
    }
    await Bun.sleep(1000);
  }
  const elapsedMs = Date.now() - startedAt;
  checkpoints.push(await memoryCheckpoint(app, evidence, "soak-end"));
  const decoded = await decodedVideoFrames(app);
  assert(decoded > videoFrames.at(-1)!, "Real USER video still decodes at soak completion");
  videoFrames.push(decoded);
  assert(userVisits >= iterations, "Every iteration exercised real USER and agent tabs");
  return { elapsedMs, iterations, fixtureVisits, userVisits, videoFrames, checkpoints, realSites: Math.floor(iterations / 50) * 2 };
}

async function visitRealSite(app: P0App, url: string) {
  await app.main.evaluate(`browserP0.open('real', ${JSON.stringify(url)})`);
  try { assert(await app.main.evaluate("browserP0.step('real')"), "Complete real-site observation/capture"); }
  finally { await app.main.evaluate("browserP0.close('real')"); }
}

async function cpuSamples(app: P0App) {
  const samples = [];
  for (let i = 0; i < 5; i++) { await Bun.sleep(1000); samples.push(gpuCPU(await sample(app))); }
  return samples;
}

async function idleSnapshot(app: P0App, label: string) {
  return hostWindow(`${label} 10 min idle`, async () => {
    const before = await snapshotFiles(app, `${label}-idle-before`);
    const started = Date.now();
    await Bun.sleep(600_000);
    const after = await snapshotFiles(app, `${label}-idle-after`);
    return { before, after, elapsedMs: Date.now() - started, delta: fileDelta(before, after) };
  });
}

async function decodedVideoFrames(app: P0App) {
  return app.main.evaluate<number>("browserP0.evaluate('user', 'video.getVideoPlaybackQuality().totalVideoFrames')");
}
