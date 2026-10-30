// test-category: security
// Real Electron, the App's real capture code: logins seen at read time, how a tab
// reached a loopback page, and what a read may carry across a navigation.
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

for (const [name, hosts] of Object.entries(out.logins as Record<string, string[]>)) {
  if (name.startsWith("no login")) assert.deepEqual(hosts, [], name);
  else assert(hosts.includes("remote.test"), `${name}: ${JSON.stringify(hosts)}`);
}
assert.equal(out.overflow.flag, true, "a full host set fails closed");
assert(out.overflow.hosts <= 64, `the host list stays small: ${out.overflow.hosts}`);
assert.deepEqual(out.userHold.before, []);
for (const host of ["remote.test", "other.test"]) assert(out.userHold.after.includes(host), JSON.stringify(out.userHold));
assert.deepEqual(out.userHold.local, [], "a loopback page the user holds stays readable");

const trusted: Record<string, boolean> = {
  "opened by the user": true,
  "page moved it from a remote site": false,
  "reload after a page moved it": false,
  "link on a local page": true,
  "remote redirect to loopback": false,
  "user typed it after a page moved it": true,
  "opened as a pop-up": false,
};
for (const [name, expected] of Object.entries(trusted)) {
  assert.match(out.arrivals[name].url, /localhost/u, name);
  assert.equal(out.arrivals[name].trusted, expected, `${name}: ${JSON.stringify(out.arrivals[name])}`);
}

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
assert.equal(out.selector.invalid.reason, "invalid_selector");
assert.equal(out.selector.valid, "ok");

rmSync(work, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, logins: Object.keys(out.logins).length, arrivals: Object.keys(trusted).length, ms: Date.now() - started }));
