import { spawnElectron, stopElectronChild } from "./electron-child";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { freeGatewayPort, type NativeAppServerHandle } from "./native-app-server";
import { smokeElectronArgs } from "./smoke-browser";

/** Spawn this checkout's Electron App and attach to its real renderer through CDP. */
export async function firstRunElectron(server: NativeAppServerHandle, serverUrl = server.url) {
  const root = process.env.BUTLER_SMOKE_REPOSITORY_ROOT ?? process.cwd();
  const scratch = mkdtempSync(join(tmpdir(), "first-run-electron-"));
  const home = join(scratch, "home");
  mkdirSync(home);
  const port = await freeGatewayPort();
  const app = resolve(root, "packages/butler-app/client/electron");
  const output: string[] = [];
  const child = spawnElectron(join(app, "node_modules/.bin/electron"), [
    `--remote-debugging-port=${port}`, ...smokeElectronArgs(), app,
  ], { cwd: root, onOutput: bytes => output.push(String(bytes)), env: {
    ...process.env, HOME: home, BUTLER_DATA: server.butlerData, CODEX_HOME: join(home, ".codex"),
    BUTLER_APP_SERVER_URL: serverUrl, BUTLER_APP_SERVER_PORT: String(server.port),
    BUTLER_APP_ELECTRON_USER_DATA_DIR: join(scratch, "profile"), BUTLER_APP_GATEWAY_PID_FILE: "off",
    BUTLER_E2E_TIER: "stub",
  } });
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, "Electron exited before exposing CDP");
      if (await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.ok).catch(() => false)) break;
      await new Promise(done => setTimeout(done, 100));
    }
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0]!;
    while (Date.now() < deadline) {
      for (const page of context.pages()) {
        if (await page.evaluate(() => Boolean(window.butlerApp) && Boolean(document.querySelector("[data-first-run-screen]"))).catch(() => false)) {
          const startupPages = context.pages().filter(candidate => candidate !== page && candidate.url().includes("/lifecycle/"));
          await Promise.all(startupPages.filter(candidate => !candidate.isClosed()).map(candidate => candidate.waitForEvent("close")));
          return { page, context: page.context(), async stop() { try { await browser.close(); } finally { await stopElectronChild(child); rmSync(scratch, { recursive: true, force: true }); } } };
        }
      }
      await new Promise(done => setTimeout(done, 100));
    }
    await browser.close();
    throw new Error("The real first-run App did not appear");
  } catch (error) {
    await stopElectronChild(child); rmSync(scratch, { recursive: true, force: true });
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output.join("")}`, { cause: error });
  }
}
