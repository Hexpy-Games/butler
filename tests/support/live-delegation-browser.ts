import { spawnElectron, stopElectronChild } from "./electron-child";
import { chromium, firefox } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { freePort, type NativeAppServerHandle } from "./native-app-server.ts";
import { smokeBrowserArgs, smokeElectronArgs } from "./smoke-browser.ts";

export async function liveDelegationBrowser(server: NativeAppServerHandle) {
  const executablePath = process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE;
  if (!executablePath) {
    const engine = process.env.BUTLER_SMOKE_BROWSER === "firefox" ? firefox : chromium;
    const browser = await engine.launch({ headless: true, args: engine === chromium ? smokeBrowserArgs() : [] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    return { page, name: engine.name(), close: () => browser.close() };
  }
  const home = join(server.butlerData, "electron-smoke-home");
  mkdirSync(home, { recursive: true });
  const port = await freePort();
  let diagnostics = "";
  const child = spawnElectron(executablePath, [`--remote-debugging-port=${port}`, ...smokeElectronArgs()], { onOutput: chunk => { diagnostics += String(chunk); }, env: {
    ...process.env,
    HOME: home, BUTLER_DATA: server.butlerData, CODEX_HOME: join(home, "codex"),
    BUTLER_APP_ELECTRON_USER_DATA_DIR: join(home, "electron"),
    BUTLER_APP_SERVER_URL: server.url, BUTLER_APP_SERVER_PORT: String(server.port), BUTLER_APP_UI_URL: server.url,
    BUTLER_APP_AGENT_LIFECYCLE_MODE: "native-service", BUTLER_APP_ALLOW_LIFECYCLE_TEST_OVERRIDE: "1",
    BUTLER_APP_FORCE_NATIVE_SERVICE_BRIDGE: "0", BUTLER_APP_DISABLE_PERSISTENT_MENU_BAR_HELPER: "1",
    BUTLER_APP_DISABLE_SHELL_REGISTRATION: "1", BUTLER_SERVICE_MANAGER: "off",
    BUTLER_PLATFORM_SYSTEM_SECRETS: "0", BUTLER_SECRET_STORE: "file", BUTLER_APP_TEST_AUTO_CONNECT: "1",
  } });
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("Electron exited before CDP");
      if (await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.ok).catch(() => false)) break;
      await new Promise(done => setTimeout(done, 100));
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0]!;
    let page = context.pages().find(page => !page.url().includes("/lifecycle/"));
    while (!page && Date.now() < deadline) {
      await new Promise(done => setTimeout(done, 100));
      page = context.pages().find(page => !page.url().includes("/lifecycle/"));
    }
    if (!page) throw new Error("Electron App window unavailable");
    await page.setViewportSize({ width: 1280, height: 1000 });
    return { page, name: "electron", async close() {
      try { await browser!.close(); } finally { await stopElectronChild(child); }
    } };
  } catch (error) {
    try { await browser?.close(); } finally { await stopElectronChild(child); }
    const safe = diagnostics.replace(/(Bearer\s+|[?&]code=)\S+/gi, "$1[redacted]");
    throw new Error(`${String(error)}\n${safe.slice(-3000)}`, { cause: error });
  }
}
