// test-category: race
// A load superseded by the page's own redirect can be torn down without aborting the App.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const electronRoot = resolve("packages/butler-app/client/electron");
const executable = process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE ?? join(electronRoot, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const work = mkdtempSync(join(tmpdir(), "superseded-load-"));
const output = join(work, "out.json");
const log = openSync(join(work, "electron.log"), "w");
const child = spawn(executable, [resolve("tests/smoke/browser-superseded-load-main.mjs"), `--user-data-dir=${join(work, "profile")}`], {
  stdio: ["ignore", log, log],
  env: { ...process.env, SUPERSEDED_LOAD_OUT: output, SUPERSEDED_LOAD_BROWSER_DIR: join(electronRoot, "browser") },
});
process.on("exit", () => child.kill("SIGKILL"));
const code = await new Promise(done => child.once("exit", done));
assert.equal(code, 0, readFileSync(join(work, "electron.log"), "utf8").slice(-2000));
const out = JSON.parse(readFileSync(output, "utf8"));
assert.equal(out.code, "ERR_ABORTED", JSON.stringify(out));
rmSync(work, { recursive: true, force: true });
