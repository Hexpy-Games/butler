import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "butler-windows-layout-"));
  roots.push(root);
  const app = join(root, "app-new");
  const bin = join(app, "resources/bundled-agent/bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(app, "resources/bundled-agent/resources"));
  const binary = join(bin, "butler-agent.exe");
  writeFileSync(binary, '#!/bin/sh\nfor role in memory restart update; do ln "$0" "$(dirname "$0")/butler-agent ($role).exe"; done\n');
  chmodSync(binary, 0o755);
  return { root, app, bin, binary };
}

function node(script: string, args: string[]) {
  return spawnSync("node", ["--input-type=module", "-e", script, ...args], { encoding: "utf8" });
}

// test-category: pure-logic
test("Windows archive staging leaves exactly one agent executable", () => {
  const { bin, binary } = fixture();
  for (const role of ["memory", "restart", "update"]) {
    writeFileSync(join(bin, `butler-agent (${role}).exe`), "archive copy");
  }
  const result = spawnSync("node", [
    resolve("packages/butler-app/client/electron/scripts/prepare-process-links.mjs"), binary,
  ], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(readdirSync(bin)).toEqual(["butler-agent.exe"]);
});

const resolver = resolve("packages/butler-app/client/electron/bundled-native-agent.mjs");
const resolveScript = `
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { syncBuiltinESMExports } from "node:module";
const [module, root, app, fail] = process.argv.slice(1);
const roles = ["memory", "restart", "update"];
const oldBin = join(root, "app-old/resources/bundled-agent/bin");
fs.mkdirSync(oldBin, { recursive: true });
for (const name of ["butler-agent", ...roles.map(role => "butler-agent (" + role + ")")]) {
  fs.writeFileSync(join(oldBin, name + ".exe"), "old binary");
}
const warnings = [];
console.warn = message => warnings.push(message);
if (fail === "fail") {
  fs.linkSync = () => { throw Object.assign(new Error("hardlinks unavailable"), { code: "ENOTSUP" }); };
  syncBuiltinESMExports();
}
if (fail === "stale") {
  const remove = fs.rmSync;
  fs.rmSync = (path, ...args) => {
    if (path.endsWith("butler-agent (memory).exe")) throw new Error("copy is locked");
    return remove(path, ...args);
  };
  fs.writeFileSync(join(app, "resources/bundled-agent/bin/butler-agent (memory).exe"), "stale copy");
  syncBuiltinESMExports();
}
const { resolveBundledNativeAgentInstallation } = await import(pathToFileURL(module).href);
const bin = join(app, "resources/bundled-agent/bin");
const binary = join(bin, "butler-agent.exe");
for (let call = 0; call < 2; call++) {
  const result = resolveBundledNativeAgentInstallation({
    butlerData: join(root, "data"), execPath: join(app, "Butler.exe"),
    resourcesPath: join(root, "app-old/resources"), platform: "win32",
  });
  assert.equal(result.command, binary);
  for (const role of roles) {
    const alias = join(bin, "butler-agent (" + role + ").exe");
    if (fail === "fail") assert.equal(fs.existsSync(alias), false);
    else if (fail === "stale" && role === "memory") {
      assert.equal(fs.readFileSync(alias, "utf8"), "stale copy");
    } else {
      assert.equal(fs.statSync(alias).ino, fs.statSync(binary).ino);
      assert.equal(fs.lstatSync(alias).isSymbolicLink(), false);
    }
    assert.equal(fs.readFileSync(join(oldBin, "butler-agent (" + role + ").exe"), "utf8"), "old binary");
  }
}
assert.equal(warnings.length, fail === "fail" ? 3 : fail === "stale" ? 1 : 0);
for (const warning of warnings) {
  assert.match(warning, fail === "stale" ? /this role is unavailable/ : /using the canonical executable/);
}
`;

// test-category: pure-logic
test("Windows launcher creates role hardlinks beside only the current canonical exe, idempotently", () => {
  const { root, app } = fixture();
  const result = node(resolveScript, [resolver, root, app, "ok"]);
  expect(result.status, result.stderr).toBe(0);
});

// test-category: pure-logic
test("Windows launcher logs hardlink failure once and keeps the canonical executable", () => {
  const { root, app } = fixture();
  const result = node(resolveScript, [resolver, root, app, "fail"]);
  expect(result.status, result.stderr).toBe(0);
});

// test-category: pure-logic
test("Windows launcher reports a locked stale copy and still prepares the other roles", () => {
  const { root, app } = fixture();
  const result = node(resolveScript, [resolver, root, app, "stale"]);
  expect(result.status, result.stderr).toBe(0);
});

// test-category: pure-logic
test("Windows native payload producer packages one agent exe and the sandbox helper", () => {
  const { root, binary } = fixture();
  const ui = join(root, "ui");
  mkdirSync(ui);
  const preload = join(root, "windows.cjs");
  writeFileSync(preload, `
Object.defineProperty(process, "platform", { value: "win32" });
Object.defineProperty(process, "arch", { value: "x64" });
const child = require("node:child_process");
const spawn = child.spawnSync;
child.spawnSync = (command, args, options) => command === "dumpbin"
  ? { status: 0, stdout: args[0] === "/headers"
    ? "8664 machine (x64)" : "Section contains the following imports:\\n    KERNEL32.dll\\n" }
  : spawn(command, args, options);
require("node:module").syncBuiltinESMExports();
`);
  const helper = join(root, "app-new/resources/bundled-agent/bin/butler-sandbox.exe");
  writeFileSync(helper, "#!/bin/sh\nexit 0\n");
  chmodSync(helper, 0o755);
  writeFileSync(join(ui, "index.html"), "<main>Butler</main>");
  writeFileSync(join(ui, "THIRD_PARTY_NOTICES.txt.gz"), gzipSync(readFileSync("deploy/licenses/THIRD_PARTY_NOTICES.txt")));
  const payload = join(root, "payload");
  const result = spawnSync("node", ["--require", preload,
    resolve("packages/butler-app/client/electron/scripts/prepare-native-agent.mjs"), "win32", "x64", payload,
  ], { encoding: "utf8", env: {
    ...process.env,
    NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, BUTLER_NATIVE_AGENT_EXECUTABLE: binary, BUTLER_NATIVE_UI_DIST: ui,
  } });
  expect(result.status, result.stderr).toBe(0);
  expect(readdirSync(join(payload, "bin")).sort()).toEqual(["butler-agent.exe", "butler-sandbox.exe"]);
  expect(readFileSync(join(payload, "bin/butler-agent.exe"))).toEqual(readFileSync(binary));
});
