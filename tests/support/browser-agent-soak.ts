import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import type { browserAgentApp } from "./browser-agent-app";
import { describeBrowser, bridgeBrowser, actConfirm, type browserStub } from "./browser-agent-stub";

/** Two hours of real guided observe/ref-act turns, with user tabs and video. */
export async function soakBrowser(
  app: Awaited<ReturnType<typeof browserAgentApp>>,
  stub: ReturnType<typeof browserStub>,
  tab: string,
  evidence: string,
  send: (text: string) => Promise<void>,
  delivered: () => Promise<void>,
) {
  const video = process.env.BUTLER_BROWSER_SOAK_VIDEO;
  assert.ok(video, "explicit video URL required for the soak");
  const userTabs: string[] = [];
  for (const url of ["https://www.iana.org/domains/reserved", "https://www.iana.org/protocols", video]) {
    userTabs.push(await app.call<string>("create", { url }));
  }
  await app.call("activate", { id: tab });
  const started = Date.now(), rows: unknown[] = [];
  while (Date.now() - started < 2 * 60 * 60 * 1000) {
    const loadAverage1m = loadavg()[0], before = Date.now();
    stub.set([describeBrowser, () => bridgeBrowser("browser_observe", { tab }), actConfirm]);
    await send("Observe the current page and click Confirm by its fresh ref.");
    await delivered();
    const proof = await app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)}).view.webContents.executeJavaScript("({result:document.querySelector('#result').textContent,width:innerWidth,height:innerHeight})")`);
    assert.deepEqual(proof, { result: "Confirmed", width: 1280, height: 800 });
    const state = await app.call<{ tabs: Array<{ id: string; status: string }> }>("state");
    assert.ok([tab, ...userTabs].every(id => state.tabs.some(t => t.id === id && t.status !== "crashed")));
    const metrics = await app.main(`${app.win}.constructor.getAllWindows && process.getBuiltinModule('module').createRequire(${JSON.stringify(join(process.cwd(),"packages/butler-app/client/electron/package.json"))})('electron').app.getAppMetrics()`);
    rows.push({ elapsedMs: Date.now() - started, turnMs: Date.now() - before, loadAverage1m, proof, metrics });
    writeFileSync(join(evidence, "soak.json"), JSON.stringify({ started, rows }, null, 2));
    // Each yield is bounded so the caller can communicate throughout the soak.
    await new Promise(done => setTimeout(done, 30_000));
  }
  assert.ok(rows.length >= 120, "at least 120 complete guided loops");
}
