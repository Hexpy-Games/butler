/** S3 one report-only two-minute task; no machine quietness or resource budget gate. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { redesignApp } from "../support/browser-redesign-app";
import { describeBrowser, bridgeBrowser, latestBrowser, actConfirm } from "../support/browser-agent-stub";
import { waitBrowser } from "../support/browser-agent-app";
import { nativeAligned } from "../support/browser-shell-acceptance";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence); mkdirSync(evidence, { recursive: true });
const app = await redesignApp(evidence);
const metricsApi = `process.getBuiltinModule('module').createRequire(${JSON.stringify(resolve("packages/butler-app/client/electron/package.json"))})('electron').app`;
type Metric = { pid: number; type: string; cpu: { percentCPUUsage: number }; memory: { workingSetSize: number } };
const samples: { elapsedMs: number; metrics: Metric[] }[] = [];
const turns: { elapsedMs: number; action: string }[] = [];
let start = 0;
try {
  app.stub.set([describeBrowser, () => bridgeBrowser("browser_open", { url: app.url })]);
  await app.send("Open the resource fixture"); await app.delivered();
  const state = await app.call<{ tabs: Array<{ id: string; agent: boolean }> }>("state");
  const tab = state.tabs.find((item) => item.agent)!.id; assert.ok(tab);
  await app.settings("ko", "dark", 1440); await app.call("activate", { id: tab }); await app.click("브라우저");
  await app.page.clickSelector('[data-slot="titlebar-leading"] button'); await nativeAligned(app);
  await app.main(`${metricsApi}.getAppMetrics()`); // Prime the interval counters.
  const gpuFeatures = await app.main(`${metricsApi}.getGPUFeatureStatus()`);
  let sampling = true;
  start = Date.now();
  const sampler = (async () => {
    while (sampling) {
      samples.push({ elapsedMs: Date.now() - start, metrics: await app.main<Metric[]>(`${metricsApi}.getAppMetrics()`) });
      await new Promise(done => setTimeout(done, 1000));
    }
  })();
  while (Date.now() - start < 120_000) {
    const fill = turns.length % 2 === 1;
    app.stub.set([describeBrowser, () => bridgeBrowser("browser_observe", { tab }), (request) => {
      if (!fill) return actConfirm(request);
      const observation = latestBrowser(request, "obs");
      const ref = /textbox "Note" \[([^\]]+)\]/u.exec((observation.untrusted_content as { text: string }).text)?.[1]; assert.ok(ref);
      return bridgeBrowser("browser_act", { tab, observation: observation.obs, steps: [{ action: "fill", ref, value: "Fixture note" }] });
    }]);
    await app.send(fill ? "Fill the fixture note" : "Confirm the fixture"); await app.delivered();
    const complete = await app.main<{ result: string; value: string }>(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)}).view.webContents.executeJavaScript("({result:document.getElementById('result').textContent,value:document.querySelector('input').value})")`);
    assert.equal(complete.result, "Confirmed"); if (fill) assert.equal(complete.value, "Fixture note");
    await waitBrowser(() => app.main("Boolean(globalThis.browserAgentSubject.pointer.attached)"), "pointer remains attached during task");
    assert.equal(await app.page.expression("document.querySelector('[data-slot=page-card]').dataset.holder"), "butler");
    turns.push({ elapsedMs: Date.now() - start, action: fill ? "fill" : "click" });
    await new Promise(done => setTimeout(done, Math.min(1500, Math.max(0, 120_000 - (Date.now() - start)))));
  }
  sampling = false; await sampler;
  const sums = samples.slice(1).map(sample => sample.metrics.reduce((sum, item) => sum + item.cpu.percentCPUUsage, 0));
  const gpu = samples.slice(1).flatMap(sample => sample.metrics.filter(item => item.type === "GPU").map(item => item.cpu.percentCPUUsage));
  const mean = (values: number[]) => values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : null;
  const report = { reportOnly: true, elapsedMs: Date.now() - start, turns, samples, gpuFeatures,
    cpuPercent: { mean: mean(sums), max: Math.max(...sums) },
    gpuProcessCpuPercent: { mean: mean(gpu), max: gpu.length ? Math.max(...gpu) : null },
    gpuUtilization: { status: "unavailable", reason: "Electron getAppMetrics exposes GPU process CPU, not hardware GPU utilization" } };
  writeFileSync(join(evidence, "resources.json"), JSON.stringify(report, null, 2));
  await app.shot("two-minute-task-complete");
} catch (error) {
  writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), elapsedMs: start ? Date.now() - start : 0, turns, samples })); throw error;
} finally { await app.stop(); }
