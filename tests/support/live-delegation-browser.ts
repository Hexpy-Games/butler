import { _electron, chromium, firefox } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { NativeAppServerHandle } from "./native-app-server";
import { smokeBrowserArgs } from "./smoke-browser";

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
  const application = await _electron.launch({ executablePath, args: smokeBrowserArgs(), env: {
    ...process.env,
    HOME: home, BUTLER_DATA: server.butlerData, CODEX_HOME: join(home, "codex"),
    BUTLER_APP_ELECTRON_USER_DATA_DIR: join(home, "electron"),
    BUTLER_APP_SERVER_URL: server.url, BUTLER_APP_SERVER_PORT: String(server.port), BUTLER_APP_UI_URL: server.url,
    BUTLER_APP_AGENT_LIFECYCLE_MODE: "native-service", BUTLER_APP_ALLOW_LIFECYCLE_TEST_OVERRIDE: "1",
    BUTLER_APP_FORCE_NATIVE_SERVICE_BRIDGE: "0", BUTLER_APP_DISABLE_PERSISTENT_MENU_BAR_HELPER: "1",
    BUTLER_APP_DISABLE_SHELL_REGISTRATION: "1", BUTLER_SERVICE_MANAGER: "off",
    BUTLER_PLATFORM_SYSTEM_SECRETS: "0", BUTLER_SECRET_STORE: "file", BUTLER_APP_TEST_AUTO_CONNECT: "1",
  } });
  const page = await application.firstWindow();
  await page.setViewportSize({ width: 1280, height: 1000 });
  return { page, name: "electron", close: () => application.close() };
}
