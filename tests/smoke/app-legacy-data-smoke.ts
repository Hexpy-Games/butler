// test-category: security
// Real Electron recovery screen must leave the refused data tree untouched.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { APP_RENDERER_ORIGIN } from "../../packages/butler-app/client/electron/app-renderer-protocol.mjs";
import { chromium, type Browser } from "playwright";
import { spawnElectron, stopElectronChild } from "../support/electron-child";
import { freePort } from "../support/native-app-server";
import { smokeBrowserArgs } from "../support/smoke-browser-args";

const root = mkdtempSync(join(tmpdir(), "butler-legacy-desktop-"));
const data = join(root, "data");
const directory = resolve("packages/butler-app/client/electron");
const executable = createRequire(join(directory, "package.json"))("electron") as string;
const port = await freePort();
const agentPort = await freePort();
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
let browser: Browser | undefined;
const child = spawnElectron(executable, [directory, `--remote-debugging-port=${port}`, ...smokeBrowserArgs()], {
  env: { ...process.env, HOME: join(root, "home"), BUTLER_DATA: data,
    BUTLER_APP_ELECTRON_USER_DATA_DIR: join(root, "profile"), BUTLER_APP_SERVER_PORT: String(agentPort),
    BUTLER_APP_DISABLE_SHELL_REGISTRATION: "1", BUTLER_E2E_TIER: "stub", BUTLER_SECRET_STORE: "file" },
  onOutput: bytes => { logs += bytes.toString(); },
});
try {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited: ${logs}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
    } catch { /* Wait for the owned Electron's debugging socket. */ }
    await new Promise(done => setTimeout(done, 50));
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0]!;
  let page = context.pages().find(page => page.url().startsWith(APP_RENDERER_ORIGIN));
  while (!page && Date.now() < deadline) {
    await new Promise(done => setTimeout(done, 50));
    page = context.pages().find(page => page.url().startsWith(APP_RENDERER_ORIGIN));
  }
  assert(page, `App page unavailable: ${logs}`);
  await page.locator('[data-test-class~="legacy-data-recovery"]').waitFor();
  assert.equal(await page.evaluate(() => (window as any).butlerApp.startupIssue), "legacy-data");
  assert.deepEqual(snapshot(), original, "Recovery screen wrote into legacy data");
  // Renderer auth requests must also remain read-only.
  await page.evaluate(() => (window as any).butlerApp.health().catch(() => null));
  assert.deepEqual(snapshot(), original, "Auth request wrote into legacy data");
  console.log(JSON.stringify({ ok: true, legacyDataPreserved: true }));
} finally {
  await browser?.close();
  await stopElectronChild(child);
  rmSync(root, { recursive: true, force: true });
}
