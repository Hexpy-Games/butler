/** Public Electron window smoke with a gated stub gateway (no provider/model calls). */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { _electron as electron } from "playwright";
import { smokeBrowserArgs } from "../support/smoke-browser";
import { createServer } from "node:http";
import { once } from "node:events";
import { HARNESS_MODEL_CATALOG } from "../../packages/butler-app/client/ui/src/app/fixtures";
import { EMPTY_SETTINGS, EMPTY_NAVIGATION } from "../../packages/butler-app/client/ui/src/app/constants";

import { nativeSmokeRuntime } from "../support/native-smoke-runtime";
const nativeExitCode = await nativeSmokeRuntime(import.meta.url);
if (nativeExitCode !== null) process.exit(nativeExitCode);

const directory = resolve("packages/butler-app/client/electron");
// Fail before launching Electron when the required production dist was not built.
readFileSync(resolve("packages/butler-app/client/ui/dist/index.html"));
readFileSync(resolve("packages/butler-app/client/ui/dist/lifecycle/lifecycle.html"));
const temporary = mkdtempSync(join(tmpdir(), "butler-startup-smoke-"));
for (const name of ["home", "data", "profile", "appdata", "local", "temp"]) mkdirSync(join(temporary, name), { recursive: true });
const output = resolve(process.env.BUTLER_STARTUP_EVIDENCE ?? ".tmp/startup-evidence");
mkdirSync(output, { recursive: true });
let releaseData: () => void = () => undefined;
const dataGate = new Promise<void>((resolve) => { releaseData = resolve; });
const requestedPaths = new Set<string>();
const server = createServer(async (request, response) => {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-headers", "authorization,content-type");
  if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
  const path = new URL(request.url!, "http://127.0.0.1").pathname;
  requestedPaths.add(path);
  if (path === "/settings" || path === "/model-catalog") await dataGate;
  const data = path === "/health" ? { ok: true }
    : path === "/runtime-readiness" ? { authenticated_gateway_ready: true, btcc_executor_ready: true }
      : path === "/settings" ? { ...EMPTY_SETTINGS, onboarding: { completed_at: null, accepted_at: null, consent_version: null } }
        : path === "/model-catalog" ? HARNESS_MODEL_CATALOG : EMPTY_NAVIGATION;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ protocol_version: "butler.app.v1", data }));
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const port = (server.address() as { port: number }).port;
const stopServer = () => { server.closeAllConnections(); server.close(); };

const executablePath = createRequire(join(directory, "package.json"))("electron") as string;
const start = performance.now();
const application = await electron.launch({ executablePath, args: [...smokeBrowserArgs(), directory], env: {
  ...process.env, HOME: join(temporary, "home"), BUTLER_DATA: join(temporary, "data"),
  USERPROFILE: join(temporary, "home"), APPDATA: join(temporary, "appdata"), LOCALAPPDATA: join(temporary, "local"),
  TEMP: join(temporary, "temp"), TMP: join(temporary, "temp"), BUTLER_SECRET_STORE: "file", BUTLER_PLATFORM_SYSTEM_SECRETS: "0",
  BUTLER_APP_DISABLE_SHELL_REGISTRATION: "1", BUTLER_APP_ELECTRON_USER_DATA_DIR: join(temporary, "profile"), BUTLER_E2E_TIER: "stub",
  BUTLER_APP_SERVER_URL: `http://127.0.0.1:${port}`, BUTLER_APP_SERVER_PORT: String(port),
} }).catch((error) => { stopServer(); rmSync(temporary, { recursive: true, force: true }); throw error; });
try {
  const splash = await application.firstWindow({ timeout: 30_000 });
  await splash.getByRole("status").waitFor();
  await splash.locator("html[data-painted=true]").waitFor();
  const splashMs = Math.round(performance.now() - start);
  assert.ok(new URL(splash.url()).pathname.endsWith("lifecycle.html"));
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((win) => win.isVisible()).length), 1);
  await splash.screenshot({ path: join(output, "splash.png") });
  releaseData();
  await expectHiddenStartup();
  async function expectHiddenStartup() {
    const deadline = performance.now() + 30_000;
    while (await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible() && window.webContents.getURL().includes("lifecycle.html")))) {
      assert.ok(performance.now() < deadline, "Startup card hands off to the main window");
      await new Promise((done) => setTimeout(done, 20));
    }
  }
  const main = application.windows().find((page) => page !== splash && !page.isClosed());
  assert.ok(main, "main window must replace splash");
  assert.deepEqual(await main.evaluate(() => {
    const bridge = window.butlerApp as any;
    return [typeof bridge.signalStartupReady, typeof bridge.saveLifecycleStill];
  }), ["function", "undefined"], "Lifecycle methods must be exposed before freezing the bridge");
  await main.locator("[data-test-class=app-boot]").waitFor({ state: "hidden" });
  assert.ok((await main.locator("#root").innerText()).length > 0, "ready renderer has content");
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((win) => win.isVisible()).length), 1);
  const readyMs = Math.round(performance.now() - start);
  await main.screenshot({ path: join(output, "ready.png") });
  const stages = await application.evaluate(({ app }) => {
    const require = process.getBuiltinModule("module")!.createRequire(`${app.getAppPath()}/package.json`);
    return require("./startup-window.mjs").startupTimings();
  }) as Array<{ stage: string; elapsed_ms: number | null }>;
  const evidence = { splashMs, readyMs, stages, stubGateway: true };
  writeFileSync(join(output, "timings.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
  const painted = stages.find((event) => event.stage === "splash_painted");
  assert.ok(painted && typeof painted.elapsed_ms === "number" && painted.elapsed_ms - stages.find((event) => event.stage === "app_ready")!.elapsed_ms! <= 300, "Splash mark must paint within 300 ms of app_ready");
  const index = (stage: string) => { const value = stages.findIndex((event) => event.stage === stage); assert.ok(value >= 0, stage); return value; };
  assert.ok(index("splash_shown") < index("runtime_imported"), "splash shown before runtime imports complete");
  assert.ok(index("main_window_ready") < index("splash_hidden"), "main shown before the startup card is parked");
} catch (error) {
  const main = application.windows().find((page) => !page.isClosed() && !page.url().includes("lifecycle.html"));
  console.log(JSON.stringify({ requestedPaths: [...requestedPaths], headings: await main?.getByRole("heading").allTextContents(), diagnostic: await main?.evaluate(async () => {
    const bridge = (window as any).butlerApp;
    const settings = await bridge.getSettings().catch((error: Error) => ({ failure: error.message }));
    const catalog = await bridge.getModelCatalog().catch((error: Error) => ({ failure: error.message }));
    return { rootText: document.querySelector("#root")?.textContent, visibility: document.visibilityState,
      settingsError: settings?.failure, catalogError: catalog?.failure, settingsKeys: Object.keys(settings ?? {}), onboarding: settings?.onboarding, catalogKeys: Object.keys(catalog ?? {}), models: catalog?.models?.length };
  }) }));
  throw error;
} finally {
  releaseData();
  await application.evaluate(({ app }) => app.exit(0));
  await application.close();
  stopServer();
  rmSync(temporary, { recursive: true, force: true });
}
