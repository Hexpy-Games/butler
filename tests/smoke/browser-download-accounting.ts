/** Offline functional download receipts: exact limits, unknown lengths, concurrency and restart. */
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserDownloads, FILE_LIMIT, SESSION_LIMIT } from "../../packages/butler-app/client/electron/browser/downloads.mjs";
import { waitBrowser } from "../support/browser-agent-app";

class Download extends EventEmitter {
  bytes = 0; path = ""; cancelled = false; resumed = false; destroyed = false;
  constructor(readonly total: number, readonly name = "invoice.pdf") { super(); }
  setSavePath(path: string) { this.path = path; }
  getTotalBytes() { assert.ok(!this.destroyed); return this.total; }
  getReceivedBytes() { assert.ok(!this.destroyed); return this.bytes; }
  getFilename() { assert.ok(!this.destroyed); return this.name; }
  pause() {}
  resume() { this.resumed = true; }
  cancel() { this.cancelled = true; this.emit("done", {}, "cancelled"); this.destroyed = true; }
  progress(bytes: number) { this.bytes = bytes; this.emit("updated", {}, "progressing"); }
  async finish(bytes: number) { this.bytes = bytes; await writeFile(this.path, "invoice"); this.emit("done", {}, "completed"); this.destroyed = true; }
}
const root = await mkdtemp(join(tmpdir(), "browser-download-accounting-"));
const directory = join(root, "state"), workspace = join(root, "workspace"); await mkdir(workspace);
const tab = { id: "fixture", owner: "conversation:general", epoch: 1 };
const other = { id: "other", owner: "conversation:other", epoch: 1 };
const published: unknown[] = [];
let releaseWorkspace: (() => void) | undefined;
let workspaceGate: Promise<void> | undefined;
const browser = { downloadRequest: async (input: { op: string }) => {
  if (input.op === "prepare") { await workspaceGate; return { workspace_path: workspace }; }
  published.push(input); return { output_id: "fixture-output" };
}, events: new Map<string, Array<{ type: string; reason?: string }>>() };
const receipts = () => browser.events.get(tab.owner) ?? [];
const downloads = new BrowserDownloads(browser, directory);
try {
  const exact = new Download(FILE_LIMIT); downloads.start(exact, tab);
  await waitBrowser(async () => exact.resumed, "100 MB boundary accepted"); await exact.finish(FILE_LIMIT);
  await waitBrowser(async () => !downloads.active.size, "completed receipt");
  assert.equal(downloads.totals[tab.owner], FILE_LIMIT); assert.equal(published.length, 1);
  const duplicate = new Download(7); downloads.start(duplicate, tab);
  await waitBrowser(async () => duplicate.resumed, "duplicate filename accepted"); await duplicate.finish(7);
  await waitBrowser(async () => !downloads.active.size, "duplicate receipt");
  assert.equal(await readFile(join(workspace, "downloads/invoice.pdf"), "utf8"), "invoice");
  workspaceGate = new Promise<void>(done => { releaseWorkspace = done; });
  const fast = new Download(7, "fast.pdf"); downloads.start(fast, tab); await fast.finish(7);
  assert.equal(published.length, 2, "completed transfer waits for canonical workspace");
  releaseWorkspace!(); workspaceGate = undefined;
  await waitBrowser(async () => !downloads.active.size, "fast completion settles after workspace lookup");
  assert.equal(published.length, 3);
  const oversized = new Download(FILE_LIMIT + 1); downloads.start(oversized, tab);
  await waitBrowser(async () => oversized.cancelled, "declared file limit");
  const unknown = new Download(0); downloads.start(unknown, tab);
  await waitBrowser(async () => unknown.resumed, "unknown length accepted"); unknown.progress(FILE_LIMIT + 1);
  await waitBrowser(async () => unknown.cancelled, "streamed file limit");
  await waitBrowser(async () => !downloads.active.size, "refused staging cleaned");
  const restored = new BrowserDownloads(browser, directory); await restored.initialize();
  assert.equal(restored.totals[tab.owner], FILE_LIMIT + 14);
  restored.totals[tab.owner] = SESSION_LIMIT - FILE_LIMIT;
  const active = new Download(FILE_LIMIT), concurrent = new Download(1);
  restored.start(active, tab); await waitBrowser(async () => active.resumed, "remaining exact session allowance");
  restored.start(concurrent, tab); await waitBrowser(async () => concurrent.cancelled, "concurrent session allowance");
  const independent = new Download(1); restored.start(independent, other);
  await waitBrowser(async () => independent.resumed, "other session independent allowance");
  restored.stop(); await waitBrowser(async () => !restored.active.size, "cancel cleanup");
  assert.ok(receipts().some(e => e.reason === "download_file_limit"));
  assert.ok(receipts().some(e => e.reason === "download_session_limit"));
  console.log(JSON.stringify({ ok: true, fileLimit: FILE_LIMIT, sessionLimit: SESSION_LIMIT, published: published.length, restartBytes: downloads.totals[tab.owner] }));
} finally { downloads.stop(); await rm(root, { recursive: true, force: true }); }
