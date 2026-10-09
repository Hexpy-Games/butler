/** Approved cards frame on the real App, with stub models and isolated data. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { assertCardsCell, captureCardsCell } from "../support/shell-cards-acceptance";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence);
mkdirSync(evidence, { recursive: true });
const app = await browserAgentApp(evidence, () => null);
const fixture = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(
  "<!doctype html><title>Shell fixture</title><h1>Shell fixture</h1><p>Native browser content</p>", { headers: { "content-type": "text/html" } }) });
const cells = [];
try {
  await app.gateway.api("/messages", { method: "POST", body: JSON.stringify({ chat_id: "general", text: "Compare shell cards.", client_message_id: crypto.randomUUID() }) });
  await waitBrowser(async () => (await app.gateway.api<{ latest_turn?: { state: string } }>("/session-view?session_id=general")).latest_turn?.state === "delivered", "stub exchange");
  await app.call("open");
  await app.call("create", { owner: "conversation:general", profile: "signed_out", url: fixture.url.href });
  for (const theme of ["light", "dark"]) for (const width of [1440, 1100]) {
    const cell = await captureCardsCell(app, theme, width);
    cells.push(cell); writeFileSync(join(evidence, "cards.json"), JSON.stringify(cells, null, 2));
  }
  const failures: string[] = [];
  for (const cell of cells) {
    try { assertCardsCell(cell); }
    catch (error) { failures.push(`${cell.theme}-${cell.width}: ${String(error)}`); }
  }
  writeFileSync(join(evidence, "report.json"), JSON.stringify({ cells: cells.length, screenshots: cells.length*8, failures }, null, 2));
  assert.deepEqual(failures, [], "every cards cell must satisfy the approved frame");
  console.log(JSON.stringify({ ok: true, cells: cells.length, screenshots: cells.length*8 }));
} finally { fixture.stop(true); await app.stop(); }
