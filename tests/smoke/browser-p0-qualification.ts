/** Run: python3 .github/scripts/isolated.py bun tests/smoke/browser-p0-qualification.ts [version|normal|renderer|gpu-crash|gpu-hang|load|baseline|soak|all]
 * Full soak: BUTLER_P0_SOAK_MINUTES=120; default=10. Local fixtures plus IANA real pages in soak.
 * On Windows set BUTLER_SMOKE_ELECTRON_EXECUTABLE to electron.exe.
 * Owned-PID file tracing: BUTLER_P0_FS_USAGE_SUDO=1 only with authorized noninteractive sudo.
 * Native agent defaults to target/debug/butler-agent; all data is disposable.
 */
import { quietHost } from "./browser-p0-host-load.ts";
import { strict as assert, AssertionError } from "node:assert";
import { readFileSync } from "node:fs";
import { browserP0Fixtures } from "./browser-p0-fixtures.ts";
import { launchP0App, waitFor } from "./browser-p0-app.ts";
import { gpuCrash, gpuHang, mainLoad, rendererCrash, uiBaseline } from "./browser-p0-cases.ts";
import { leakSoak } from "./browser-p0-soak.ts";
import { sample, type Row } from "./browser-p0-measure.ts";

assert.notEqual(process.env.BUTLER_P0_DIAGNOSE_PER_TAB, "1", "Per-tab partition control is diagnosis only");
const selected = process.argv[2] || "all";
assert(["all", "version", "policy", "normal", "renderer", "gpu-crash", "gpu-hang", "load", "baseline", "soak"].includes(selected));
const rows: Row[] = [];
const evidence: Record<string, unknown> = {};
// Reviewed against https://releases.electronjs.org/schedule on 2026-10-06.
// A stale support snapshot fails closed; refresh it for subsequent upgrades.
const pin = JSON.parse(readFileSync("packages/butler-app/client/electron/package.json", "utf8")).devDependencies.electron;
const major = Number(pin.split(".")[0]);
const now = Date.now();
const support = major >= 42 && major <= 44 && now < Date.parse("2026-10-20T00:00:00Z");
rows.push({ test: "version", metric: "build Electron pin", value: pin, budget: "42–44; support snapshot expires 2026-10-20", status: support ? "PASS" : "FAIL", attribution: "Version policy", mitigation: "Refresh official schedule and upgrade Electron" });
let app: Awaited<ReturnType<typeof launchP0App>> | undefined;
const fixtures = browserP0Fixtures();
try {
  if (selected !== "version") {
    const origin = `http://127.0.0.1:${fixtures.port}`;
    const cases: Record<string, () => Promise<unknown>> = {
      normal: async () => {
        assert.equal(await app!.main.evaluate("typeof globalThis.browserP0"), "undefined");
        rows.push({ test: "normal", metric: "test harness absent", value: "undefined", budget: "undefined", status: "PASS" });
      },
      policy: async () => {
        await app!.main.evaluate(`browserP0.open('policy','${origin}/gpu')`);
        const agent = await app!.main.evaluate<Record<string, boolean>>("browserP0.gpuPolicy('policy')");
        const user = await app!.main.evaluate<Record<string, boolean>>("browserP0.gpuPolicy('user')");
        for (const feature of ["webgl", "webgl2", "webgpu"]) rows.push({ test: "policy", metric: `agent ${feature} disabled`, value: String(agent[feature]), budget: "false", status: agent[feature] ? "FAIL" : "PASS" });
        for (const feature of ["webgl", "webgl2", "webgpu"]) rows.push({ test: "policy", metric: `user ${feature} allowed`, value: String(user[feature]), budget: "true", status: user[feature] ? "PASS" : "FAIL" });
        await app!.main.evaluate("browserP0.close('policy')");
        return { agent, user, candidate: "webgl:false; renderer --disable-features=WebGPUService" };
      },
      renderer: () => rendererCrash(app!, origin, rows),
      "gpu-crash": () => gpuCrash(app!, origin, rows),
      "gpu-hang": () => gpuHang(app!, origin, rows),
      load: () => mainLoad(app!, origin, rows),
      baseline: () => uiBaseline(app!, rows, origin),
      soak: () => leakSoak(app!, origin, rows, Number(process.env.BUTLER_P0_SOAK_MINUTES || 10)),
    };
    for (const [name, run] of Object.entries(cases)) {
      if (selected !== "all" && selected !== name) continue;
      console.log(JSON.stringify({ started: name }));
      try {
        await quietHost(`${name} startup`);
        app = await launchP0App({ harness: name !== "normal" });
        if (name === "normal") { await run(); await app.stop(); app = undefined; continue; }
        const initial = await sample(app);
        assert.equal(initial.versions.electron, pin);
        evidence[`${name}Runtime`] = { electron: initial.versions.electron, gpu: initial.gpu, crashLimitDisabled: initial.crashLimitDisabled, mainPID: initial.mainPID, uiPID: initial.uiPID };
        await app.main.evaluate(`browserP0.open('user','${origin}/video',{user:true})`);
        await waitFor(() => app!.main.evaluate("browserP0.evaluate('user','video.readyState>=3&&!video.paused')"), "decoded user video playing");
        evidence[name] = await run();
      }
      catch (error) { rows.push({ test: name, metric: "complete scenario", value: String(error), budget: "§9.2 setup and all assertions", status: error instanceof AssertionError ? "FAIL" : "UNAVAILABLE" }); }
      if (app) { evidence[`${name}FinalRuntime`] = await sample(app).then(s=>({ gpu: s.gpu, gone: s.gone, crashes: s.crashes, loop: s.loop, resources: s.resources, metrics: s.metrics })).catch(() => null); await app.stop(); app = undefined; }
      console.log(JSON.stringify({ completed: name, rows: rows.filter(r => r.test === name || r.test === name.replaceAll("-", " ")) }));
    }
  }
} catch (error) {
  rows.push({ test: selected, metric: "App execution", value: String(error), budget: "real App required", status: "UNAVAILABLE" });
} finally {
  if (app) await app.stop(); fixtures.stop(true);
  // §9.3 requires failures AFTER mitigations. Raw failures alone are not triggers.
  console.log(JSON.stringify({ rows, evidence, decision: "Review GPU proof, user-tab results, and full soak against §9.3; unavailable is never a pass", gpuSource: process.env.BUTLER_P0_GPU_SOURCE || "agent", agentGPU: process.env.BUTLER_P0_AGENT_GPU || "on", platform: `${process.platform}/${process.arch}` }));
  if (rows.some(r => r.status === "FAIL" || r.status === "UNAVAILABLE")) process.exitCode = 1;
}
