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

assert(out.frames.loaded, JSON.stringify(out.frames));
assert.deepEqual(out.frames.texts, ["MAIN_FRAME"], "a frame's console is not the page's");

const closed = { console: "secret_filled", dom: "secret_filled", network: "secret_filled" };
const open = { console: "ok", dom: "ok", network: "ok" };

for (const name of ["sign-in", "card"]) {
  const fill = out.fills[name];
  assert.deepEqual(fill.before, { console: "ok", dom: "ok" }, `${name}: read before the fill: ${JSON.stringify(fill)}`);
  assert.equal(fill.filled, "filled", `${name}: ${JSON.stringify(fill)}`);
  assert.equal(fill.sent, true, `${name}: the page sent the value on: ${JSON.stringify(fill)}`);
  assert.equal(fill.closedWhenTyped, true, `${name}: closed before typing: ${JSON.stringify(fill)}`);
  assert.deepEqual(fill.refused, closed, `${name}: ${JSON.stringify(fill)}`);
  assert.equal(fill.after, "ok", `${name}: readable once the page changes: ${JSON.stringify(fill)}`);
  assert(!fill.rowsAfter.some((url: string) => /SECRET|4242/u.test(url)), `${name}: ${JSON.stringify(fill)}`);
  assert.equal(fill.vaultAfter, false, `${name}: ${JSON.stringify(fill)}`);
}

const within = out.signInWithin;
assert.equal(within.filled, "filled", JSON.stringify(within));
assert.equal(within.sent, true, JSON.stringify(within));
assert.equal(within.vault, false, `password fields already show dots: ${JSON.stringify(within)}`);
assert.deepEqual(within.refused, closed, JSON.stringify(within));
assert.deepEqual(within.sameUrl, closed, `the same URL is not a move: ${JSON.stringify(within)}`);
assert.deepEqual(within.moved, open, `readable once it moves on: ${JSON.stringify(within)}`);
assert(!within.rows.some((url: string) => /SECRET/u.test(url)), `what it sent meanwhile stays unread: ${JSON.stringify(within)}`);
assert.equal(within.console, 0, JSON.stringify(within));
assert.equal(within.fromLoad, false, `and the reply says it is partial: ${JSON.stringify(within)}`);

assert.equal(out.cardWithin.vault, true, JSON.stringify(out.cardWithin));
assert.deepEqual(out.cardWithin.moved, closed, `a card stays closed within its document: ${JSON.stringify(out.cardWithin)}`);
assert.equal(out.cardBroken.closedWhenTyped, true, JSON.stringify(out.cardBroken));
assert.deepEqual(out.cardBroken.refused, closed, `a fill that broke partway: ${JSON.stringify(out.cardBroken)}`);

rmSync(work, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, ms: Date.now() - started }));
