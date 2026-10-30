// test-category: security
// Real Electron, the App's real capture and fill code: what a read may carry
// across a navigation, how far a reply goes, and a document Butler filled a secret into.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const electronRoot = resolve("packages/butler-app/client/electron");
const executable = process.env.BUTLER_E2E_ELECTRON ?? join(electronRoot, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const work = mkdtempSync(join(tmpdir(), "devtools-capture-"));
const output = join(work, "out.json");
const log = openSync(join(work, "electron.log"), "w");
const child = spawn(executable, [resolve("tests/smoke/browser-devtools-capture-main.mjs"), `--user-data-dir=${join(work, "profile")}`], {
  stdio: ["ignore", log, log],
  env: { ...process.env, DEVTOOLS_CAPTURE_OUT: output, DEVTOOLS_BROWSER_DIR: join(electronRoot, "browser") },
});
process.on("exit", () => child.kill("SIGKILL"));
const started = Date.now();
const code = await new Promise(done => child.once("exit", done));
const fail = () => readFileSync(join(work, "electron.log"), "utf8").slice(-2000);
assert.equal(code, 0, fail());
const out = JSON.parse(readFileSync(output, "utf8"));

assert.equal(out.crossing.status, "ok");
assert(!out.crossing.rows.some((url: string) => url.includes("OLD_DOCUMENT")), JSON.stringify(out.crossing));
assert(out.crossing.rows.some((url: string) => url.endsWith("/with-fetch")), JSON.stringify(out.crossing));
assert(out.crossing.rows.some((url: string) => url.endsWith("/sub")), `the new document's own request stays: ${JSON.stringify(out.crossing)}`);

assert(out.pending.total <= 1000, `pending stays bounded: ${JSON.stringify(out.pending)}`);
assert(out.pending.dropped > 0, `what fell out is counted: ${JSON.stringify(out.pending)}`);
assert(out.pending.bytes < 256 * 1024, JSON.stringify(out.pending));

assert.equal(out.dom.status, "ok", JSON.stringify(out.dom));
assert(out.dom.bytes < 256 * 1024, `a DOM reply fits: ${out.dom.bytes}`);
assert.equal(out.dom.walked_all, false, "and says it stopped");
assert.equal(out.dom.href, out.dom.url);
assert.equal(out.selector.reason, "invalid_selector");

for (const name of ["sign-in", "card"]) {
  const fill = out.fills[name];
  assert.deepEqual(fill.before, { console: "ok", dom: "ok" }, `${name}: read before the fill: ${JSON.stringify(fill)}`);
  assert.equal(fill.console, "secret_filled", `${name}: ${JSON.stringify(fill)}`);
  assert.equal(fill.dom, "secret_filled", `${name}: ${JSON.stringify(fill)}`);
  assert.equal(fill.network, "ok", `${name}: the summary stays: ${JSON.stringify(fill)}`);
  assert.equal(fill.after, "ok", `${name}: readable once the page changes: ${JSON.stringify(fill)}`);
}

rmSync(work, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, ms: Date.now() - started }));
