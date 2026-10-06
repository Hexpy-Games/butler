/** Root-cause experiment on the real App; no qualification budgets replaced. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { browserP0Fixtures } from "./browser-p0-fixtures";
import { launchP0App, waitFor } from "./browser-p0-app";
import { openBrowserArea, visitUserSite } from "./browser-p0-user";
import { memoryCheckpoint } from "./browser-p0-memory";

const evidence = process.env.BUTLER_P0_EVIDENCE!;
assert(evidence, "BUTLER_P0_EVIDENCE required");
mkdirSync(evidence, { recursive: true });
const fixture = browserP0Fixtures();
const app = await launchP0App();
const origin = `http://127.0.0.1:${fixture.port}`;
try {
  if (process.argv[2] === "gpu") {
    await app.main.evaluate(`browserP0.open('gpu','${origin}/gpu')`);
    await app.page.expression("(()=>{window.p0Contexts=[];for(const c of document.querySelectorAll('canvas[data-module]'))for(const n of ['webglcontextlost','webglcontextrestored'])c.addEventListener(n,e=>window.p0Contexts.push({event:n,at:performance.now(),status:e.statusMessage||''}));})()");
    const rows = [];
    for (let i = 0; i < 5; i++) {
      const load1 = loadavg()[0];
      const before = await app.main.evaluate<any>("browserP0.sample()");
      await app.main.evaluate("browserP0.loseGPU('gpu')");
      await waitFor(async () => (await app.main.evaluate<any>("browserP0.sample()")).gone.length > before.gone.length, "GPU loss");
      await Bun.sleep(3000);
      const state = await app.page.expression("({contexts:window.p0Contexts,canvases:Array.from(document.querySelectorAll('canvas[data-module]'),c=>({module:c.dataset.module,paint:c.dataset.wallpaperPaint,contextLost:c.getContext('webgl2')?.isContextLost()})),freshWebGL:!!document.createElement('canvas').getContext('webgl2')})");
      const a = await app.main.evaluate("browserP0.wallpaperFrame()");
      await Bun.sleep(1000);
      const b = await app.main.evaluate("browserP0.wallpaperFrame()");
      const row = { loss: i + 1, load1, state, pixelsChanged: a !== b };
      rows.push(row); console.log(JSON.stringify(row));
      await app.main.evaluate(`browserP0.navigate('gpu','${origin}/gpu')`);
    }
    writeFileSync(join(evidence, `${process.env.BUTLER_P0_LABEL || "gpu-diagnose"}.json`), JSON.stringify(rows, null, 2));
    writeFileSync(join(evidence, `${process.env.BUTLER_P0_LABEL || "gpu-diagnose"}.png`), await app.page.screenshot());
  } else if (process.argv[2] === "user") {
    await openBrowserArea(app);
    const rows = [];
    for (const path of ["nodes", "cpu", "network"]) rows.push(await visitUserSite(app, `${origin}/${path}`, evidence));
    rows.push(await visitUserSite(app, "https://www.iana.org/help/example-domains", evidence));
    writeFileSync(join(evidence, "user-path.json"), JSON.stringify({ rows, product: await app.main.evaluate("browserP0.productInventory()"), load1: loadavg()[0] }, null, 2));
  } else {
    const rows = [];
    rows.push(await memoryCheckpoint(app, evidence, "before", true));
    console.log(JSON.stringify({ stage: "heap-complete" }));
    for (let i = 0; i < 600; i++) {
      await app.main.evaluate(`browserP0.open('probe-${i}','${origin}/nodes')`);
      if (i === 0) console.log(JSON.stringify({ stage: "first-open" }));
      await app.main.evaluate(`browserP0.step('probe-${i}')`);
      if (i === 0) console.log(JSON.stringify({ stage: "first-capture" }));
      await app.main.evaluate(`browserP0.close('probe-${i}')`);
      if ((i + 1) % 100 === 0) {
        const row = await memoryCheckpoint(app, evidence, `iteration-${i + 1}`, (i + 1) % 300 === 0);
        rows.push(row); console.log(JSON.stringify(row));
      }
    }
    writeFileSync(join(evidence, "memory-diagnose.json"), JSON.stringify(rows, null, 2));
  }
} finally { await app.stop(); fixture.stop(true); }
