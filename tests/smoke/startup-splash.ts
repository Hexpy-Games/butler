/** Public Electron window smoke with a gated stub gateway (no provider/model calls). */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { _electron as electron } from "playwright";
import { smokeBrowserArgs } from "../support/smoke-browser";
import { HARNESS_MODEL_CATALOG } from "../../packages/butler-app/client/ui/src/app/fixtures";
import { EMPTY_SETTINGS } from "../../packages/butler-app/client/ui/src/app/constants";

const directory = resolve("packages/butler-app/client/electron");
const temporary = mkdtempSync(join(tmpdir(), "butler-startup-smoke-"));
const output = resolve(process.env.BUTLER_STARTUP_EVIDENCE ?? ".tmp/startup-evidence");
mkdirSync(output, { recursive: true });
let releaseData: () => void = () => undefined;
const dataGate = new Promise<void>((resolve) => { releaseData = resolve; });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
  const path = new URL(request.url).pathname;
  if (path === "/settings" || path === "/model-catalog") await dataGate;
  const data = path === "/health" ? { ok: true }
    : path === "/runtime-readiness" ? { authenticated_gateway_ready: true, btcc_executor_ready: true }
      : path === "/settings" ? { ...EMPTY_SETTINGS, onboarding: { completed_at: null, accepted_at: null, consent_version: null } }
        : path === "/model-catalog" ? HARNESS_MODEL_CATALOG : { chats: [], projects: [] };
  return Response.json({ protocol_version: "butler.app.v1", data });
} });
const executablePath = createRequire(join(directory, "package.json"))("electron") as string;
const start = performance.now();
const application = await electron.launch({ executablePath, args: [...smokeBrowserArgs(), directory], env: {
  ...process.env, HOME: join(temporary, "home"), BUTLER_DATA: join(temporary, "data"),
  USERPROFILE: join(temporary, "home"), APPDATA: join(temporary, "appdata"), LOCALAPPDATA: join(temporary, "local"),
  TEMP: join(temporary, "temp"), TMP: join(temporary, "temp"), BUTLER_SECRET_STORE: "file", BUTLER_PLATFORM_SYSTEM_SECRETS: "0",
  BUTLER_APP_DISABLE_SHELL_REGISTRATION: "1", BUTLER_APP_ELECTRON_USER_DATA_DIR: join(temporary, "profile"), BUTLER_E2E_TIER: "stub",
  BUTLER_APP_SERVER_URL: server.url.origin, BUTLER_APP_SERVER_PORT: String(server.port),
} }).catch((error) => { server.stop(true); rmSync(temporary, { recursive: true, force: true }); throw error; });
try {
  const splash = await application.firstWindow({ timeout: 30_000 });
  await splash.getByRole("status").waitFor();
  await splash.locator("html[data-painted=true]").waitFor();
  const splashMs = Math.round(performance.now() - start);
  assert.ok(new URL(splash.url()).pathname.endsWith("lifecycle.html"));
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((win) => win.isVisible()).length), 1);
  await splash.screenshot({ path: join(output, "splash.png") });
  releaseData();
  await splash.waitForEvent("close", { timeout: 30_000 });
  const main = application.windows().find((page) => !page.isClosed());
  assert.ok(main, "main window must replace splash");
  await main.locator("[data-test-class=app-boot]").waitFor({ state: "hidden" });
  assert.ok((await main.locator("#root").innerText()).length > 0, "ready renderer has content");
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((win) => win.isVisible()).length), 1);
  const readyMs = Math.round(performance.now() - start);
  await main.screenshot({ path: join(output, "ready.png") });
  const stages = await application.evaluate(async (_electron, url) => (await import(url)).startupTimings(),
    pathToFileURL(join(directory, "startup-window.mjs")).href) as Array<{ stage: string; elapsed_ms: number | null }>;
  const evidence = { splashMs, readyMs, stages, stubGateway: true };
  writeFileSync(join(output, "timings.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
  const painted = stages.find((event) => event.stage === "splash_painted");
  assert.ok(painted && typeof painted.elapsed_ms === "number" && painted.elapsed_ms - stages.find((event) => event.stage === "app_ready")!.elapsed_ms! <= 300, "Splash mark must paint within 300 ms of app_ready");
  const index = (stage: string) => { const value = stages.findIndex((event) => event.stage === stage); assert.ok(value >= 0, stage); return value; };
  assert.ok(index("splash_shown") < index("runtime_imported"), "splash shown before runtime imports complete");
  assert.ok(index("main_window_ready") < index("splash_destroyed"), "main shown before splash destruction");
} finally {
  releaseData();
  await application.evaluate(({ app }) => app.exit(0));
  await application.close();
  server.stop(true);
  rmSync(temporary, { recursive: true, force: true });
}
