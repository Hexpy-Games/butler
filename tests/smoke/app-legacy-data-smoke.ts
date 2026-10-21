// test-category: security
// Real Electron recovery screen must leave the refused data tree untouched.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { APP_RENDERER_ORIGIN } from "../../packages/butler-app/client/electron/app-renderer-protocol.mjs";
import { electronPage, type ElectronPage } from "../support/electron-page-cdp";
import { spawnElectron, stopElectronChild } from "../support/electron-child";
import { freeGatewayPort, freePort, nativeAgentExecutable } from "../support/native-app-server";
import { smokeBrowserArgs } from "../support/smoke-browser-args";

const root = mkdtempSync(join(tmpdir(), "butler-legacy-desktop-"));
const data = join(root, "data");
const directory = resolve("packages/butler-app/client/electron");
const executable = createRequire(join(directory, "package.json"))("electron") as string;
const port = await freePort();
const agentPort = await freeGatewayPort();
// Match the native Electron fixtures: a real executable beside resources and UI.
const installation = join(root, "install");
const agent = join(installation, "bin/butler-agent");
mkdirSync(join(installation, "bin"), { recursive: true });
cpSync(nativeAgentExecutable(), agent);
cpSync(resolve("packages/butler-agent/resources"), join(installation, "resources"), { recursive: true });
cpSync(resolve("packages/butler-app/client/ui/dist"), join(installation, "resources/app-client/dist"), { recursive: true });
mkdirSync(join(data, "app-server"), { recursive: true });
writeFileSync(join(data, "app-server/butler-client.sqlite"), "legacy database\n");
writeFileSync(join(data, "keep.txt"), "preserve original data\n");
function snapshot() {
  return readdirSync(data, { recursive: true, withFileTypes: true }).map(entry => {
    const path = join(entry.parentPath, entry.name);
    return [path, entry.isDirectory() ? "directory" : createHash("sha256").update(readFileSync(path)).digest("hex")];
  }).sort();
}
const original = snapshot();
let logs = "";
let page: ElectronPage | undefined;
const child = spawnElectron(executable, [directory, `--remote-debugging-port=${port}`, ...smokeBrowserArgs()], {
  env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", DISPLAY: process.env.DISPLAY,
    XAUTHORITY: process.env.XAUTHORITY, HOME: join(root, "home"), BUTLER_DATA: data,
    TMPDIR: tmpdir(), XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
    BUTLER_NATIVE_AGENT_EXECUTABLE: agent,
    BUTLER_APP_ELECTRON_USER_DATA_DIR: join(root, "profile"), BUTLER_APP_SERVER_PORT: String(agentPort),
    BUTLER_APP_DISABLE_SHELL_REGISTRATION: "1", BUTLER_E2E_TIER: "stub", BUTLER_SECRET_STORE: "file" },
  onOutput: bytes => { logs += bytes.toString(); },
});
try {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Electron exited: ${logs}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
    } catch { /* Wait for the owned Electron's debugging socket. */ }
    await new Promise(done => setTimeout(done, 50));
  }
  assert(Date.now() < deadline, `Electron debugging socket unavailable: ${logs}`);
  page = await electronPage(port, APP_RENDERER_ORIGIN);
  await page.waitForFunction(() => Boolean(document.querySelector('[data-test-class~="legacy-data-recovery"]')));
  assert.equal(await page.evaluate(() => (window as any).butlerApp.startupIssue), "legacy-data");
  assert.deepEqual(snapshot(), original, "Recovery screen wrote into legacy data");
  for (const [action, request] of [
    ["health", "window.butlerApp.health()"],
    ["startAgent", "window.butlerApp.startAgent()"],
    ["repair", 'window.butlerApp.startSetup({mode:"repair"})'],
  ]) {
    const error = await page.expression<string | null>(
      `${request}.then(() => null, error => error.message)`,
    );
    assert.match(error ?? "", /legacy_data_blocked/u, `Blocked ${action} must reject`);
    assert.deepEqual(snapshot(), original, `Blocked ${action} request wrote into legacy data`);
    assert.equal(existsSync(join(data, "app/runtime/foreground/instance.json")), false);
  }
  console.log(JSON.stringify({ ok: true, legacyDataPreserved: true, blockedHealth: true,
    blockedStartAgent: true, blockedRepair: true, filesystemChanges: 0 }));
} finally {
  page?.close();
  await stopElectronChild(child);
  rmSync(root, { recursive: true, force: true });
}
