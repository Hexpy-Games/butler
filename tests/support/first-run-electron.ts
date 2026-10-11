import { spawnElectron, stopElectronChild } from "./electron-child";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { freeGatewayPort, type NativeAppServerHandle } from "./native-app-server";
import { connectElectronMain } from "./electron-main-cdp";
import { smokeElectronArgs } from "./smoke-browser";

/** Spawn this checkout's Electron App and attach to its real renderer through CDP. */
export async function firstRunElectron(server: NativeAppServerHandle, serverUrl = server.url, readySelector = "[data-first-run-screen]") {
  const root = process.env.BUTLER_SMOKE_REPOSITORY_ROOT ?? process.cwd();
  const scratch = mkdtempSync(join(tmpdir(), "first-run-electron-"));
  const home = join(scratch, "home");
  mkdirSync(home);
  const port = await freeGatewayPort();
  const inspectorPort = await freeGatewayPort();
  const app = resolve(root, "packages/butler-app/client/electron");
  const output: string[] = [];
  const executable = createRequire(join(app, "package.json"))("electron") as string;
  const child = spawnElectron(executable, [
    `--inspect=${inspectorPort}`, `--remote-debugging-port=${port}`, ...smokeElectronArgs(), app,
  ], { cwd: root, onOutput: bytes => output.push(String(bytes)), env: {
    ...process.env, HOME: home, BUTLER_DATA: server.butlerData, CODEX_HOME: join(home, ".codex"),
    BUTLER_APP_SERVER_URL: serverUrl, BUTLER_APP_SERVER_PORT: String(server.port),
    BUTLER_APP_ELECTRON_USER_DATA_DIR: join(scratch, "profile"), BUTLER_APP_GATEWAY_PID_FILE: "off",
    BUTLER_E2E_TIER: "stub",
  } });
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  let inspector: Awaited<ReturnType<typeof connectElectronMain>> | undefined;
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, "Electron exited before exposing CDP");
      if (await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.ok).catch(() => false)) break;
      await new Promise(done => setTimeout(done, 100));
    }
    const connected = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    browser = connected;
    const context = connected.contexts()[0]!;
    inspector = await connectElectronMain(inspectorPort);
    // Foreground only our disposable App, as the browser App harness does.
    const module = `process.getBuiltinModule('module').createRequire(${JSON.stringify(join(app, "package.json"))})`;
    let shown = false;
    while (Date.now() < deadline) {
      if (!shown) shown = await inspector.evaluate<boolean>(`(()=>{const w=${module}('electron').BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('app://butler/'));if(!w)return false;w.hide();w.show();w.focus();return true})()`);
      for (const page of context.pages()) {
        if (await page.evaluate(selector => Boolean(window.butlerApp) && Boolean(document.querySelector(selector)), readySelector).catch(() => false)) {
          const startupPages = context.pages().filter(candidate => candidate !== page && candidate.url().includes("/lifecycle/"));
          await Promise.all(startupPages.filter(candidate => !candidate.isClosed()).map(candidate => candidate.waitForEvent("close")));
          return { page, context: page.context(), async stop() { try { inspector?.close(); await connected.close(); } finally { await stopElectronChild(child); rmSync(scratch, { recursive: true, force: true }); } } };
        }
      }
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error("The real first-run App did not appear");
  } catch (error) {
    await captureFailure(browser);
    inspector?.close();
    await browser?.close().catch(() => {});
    await stopElectronChild(child); rmSync(scratch, { recursive: true, force: true });
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output.join("")}`, { cause: error });
  }
}

/** Fixture-only UI state, captured before the owned App is stopped. */
async function captureFailure(browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined) {
  const directory = process.env.BUTLER_IMPORT_EVIDENCE;
  if (!browser || !directory) return;
  for (const page of browser.contexts().flatMap(context => context.pages())) {
    if (!page.url().startsWith("app://butler/")) continue;
    const state = await page.evaluate(async () => ({
      ready: document.readyState, fonts: document.fonts.status,
      screen: document.querySelector("[data-first-run-screen]")?.getAttribute("data-first-run-screen"),
      scene: document.querySelector('[data-test-class="first-run-setup"]') !== null,
      setup: await Promise.race([(window.butlerApp as (typeof window.butlerApp & { setupWindowReady?: () => Promise<void> }))?.setupWindowReady?.().then(() => "resolved", () => "rejected"), new Promise(resolve => setTimeout(() => resolve("pending"), 100))]),
    })).catch(() => null);
    writeFileSync(join(directory, "first-run-launch-failure.json"), JSON.stringify(state));
    await page.screenshot({ path: join(directory, "first-run-launch-failure.png") }).catch(() => {});
  }
}
