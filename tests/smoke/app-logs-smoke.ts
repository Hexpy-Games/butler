// Real Electron main/preload/renderer → shared native log API; offline stub model only.
import { createServer, request } from "node:http";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, type Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server";
import { fileElectronApp, type FileElectronApp } from "../support/file-electron-app";
import { launchSmokeBrowser } from "../support/smoke-browser";
import { LEGACY_FIRST_RUN_STORAGE_KEY, legacyFirstRunCompleteRecord } from "../../packages/butler-app/client/ui/src/app/onboarding";
import { getAppCopy } from "../../packages/butler-app/client/ui/src/app/copy";

const executable = process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE
  ?? resolve("packages/butler-app/client/electron/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const shots = process.env.BUTLER_LOGS_SHOTS;
assert(shots, "BUTLER_LOGS_SHOTS must name a scratch directory");
mkdirSync(shots, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "app-logs-smoke-"));
const profile = join(root, "profile"); mkdirSync(profile);
writeFileSync(join(profile, "butler-native-settings.json"), JSON.stringify({ developer_mode_enabled: true }));
const server = await createNativeAppServer();
// Hold config indefinitely: a real window must open before the agent read resolves.
let releaseConfig!: () => void, configStarted = 0, configReleased = false;
let stallNextConfig = false, configBlockedAt = 0;
const configGate = new Promise<void>(resolve => { releaseConfig = resolve; });
const proxy = createServer(async (incoming, outgoing) => {
  if (incoming.url === "/logs/config" && incoming.method === "GET" && !configReleased) {
    configStarted ||= Date.now();
    await configGate;
  } else if (incoming.url === "/logs/config" && incoming.method === "GET" && stallNextConfig) {
    stallNextConfig = false; configBlockedAt = Date.now();
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  const upstream = request(new URL(incoming.url!, server.url), {
    method: incoming.method, headers: { ...incoming.headers, host: new URL(server.url).host },
  }, response => { outgoing.writeHead(response.statusCode!, response.headers); response.pipe(outgoing); });
  upstream.on("error", () => outgoing.destroy());
  incoming.pipe(upstream);
});
await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
const proxyPort = (proxy.address() as { port: number }).port;

const copy = getAppCopy("ko-KR");
let app: FileElectronApp | undefined, browser: Browser | undefined;
type Row = { process: string; event: string; trace_id?: string; msg: string; category: string; error?: { scope: string; stack: string }; attrs?: { name: string }; body_ref?: string };
async function rows(source: string) { return (await server.api<{ rows: Row[] }>(`/logs?source=${source}&limit=1000`)).rows; }
async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, name: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${name}`);
}
function files() {
  const directory = join(server.butlerData, "logs/app");
  return readdirSync(directory, { recursive: true }).map(String).map(name => join(directory, name)).filter(path => statSync(path).isFile());
}
function snapshot() { return files().map(path => [path, statSync(path).size, statSync(path).mtimeMs]); }
async function renderer(script: string) {
  return app!.evaluate(({ BrowserWindow }, script) => BrowserWindow.getAllWindows()
    .find(window => window.webContents.getURL().startsWith("app://butler/"))!.webContents.executeJavaScript(script), script);
}
async function setLevel(level: string) {
  await renderer(`window.butlerApp.logs({ path: "/logs/config", method: "PUT", body: { level: ${JSON.stringify(level)}, category_levels: {} } })`);
}
async function fullBodySmoke() {
  await setLevel("full");
  await renderer(`window.butlerApp.recordUiCrash({ scope: "conversation", message: "full-only input sk-secret" })`);
  const detail = await waitFor(() => rows("app"), rows => rows.some(row => row.event === "ipc.payload" && row.attrs?.name === "butler:ui-crash"), "full IPC reference");
  const payload = detail.find(row => row.event === "ipc.payload" && row.attrs?.name === "butler:ui-crash")!;
  assert(payload.body_ref && !JSON.stringify(payload).includes("full-only input"));
  const response = await fetch(`${server.url}/logs/bodies/${encodeURIComponent(payload.body_ref)}`, { headers: server.authHeaders });
  assert(response.ok);
  const body = await response.text();
  assert(body.includes("full-only input") && !body.includes("sk-secret"));
  stallNextConfig = true;
  await server.api("/logs/config", { method: "PUT", body: JSON.stringify({ level: "full", category_levels: { ipc: "trace" } }) });
  await waitFor(async () => configBlockedAt, value => value > 0, "stalled App config refresh");
  const started = Date.now();
  await server.api("/logs/config", { method: "PUT", body: JSON.stringify({ level: "detailed", category_levels: {} }) });
  await waitFor(async () => existsSync(join(server.butlerData, "logs/app/bodies")), exists => !exists, "direct gateway downgrade removes App bodies");
  assert(Date.now() - started < 5000, "external downgrade applies promptly");
  await renderer(`window.butlerApp.recordUiCrash({ scope: "conversation", message: "after-external-downgrade" })`);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert(!existsSync(join(server.butlerData, "logs/app/bodies")), "new IPC input is no longer captured");
  await server.api("/logs/config", { method: "PUT", body: JSON.stringify({ level: "standard", category_levels: {} }) });
  await waitFor(async () => existsSync(join(server.butlerData, "logs/app/debug")), exists => !exists, "external downgrade removes App debug");
  console.log(JSON.stringify({ stage: "external downgrade", cleanup_ms: Date.now() - started }));
  assert(files().every(path => !path.endsWith(".idx")), "Agent keeps App indexes out of App directories");
}
async function capture(page: Page, width: number, theme: string) {
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: theme }) });
  await page.setViewportSize({ width, height: 1000 });
  await page.reload();
  await page.locator('[data-test-class~="composer-card"]').waitFor();
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: copy.commandPalette.label });
  await palette.getByRole("combobox").fill(copy.settings.sections.logs);
  await palette.getByRole("option").filter({ has: page.getByText(copy.settings.sections.logs, { exact: true }) }).first().click();
  const viewer = page.locator('[data-settings-section-id="logs-viewer"]');
  await viewer.getByRole("combobox", { name: copy.settings.logs.filters.source, exact: true }).selectOption("app");
  await viewer.locator('[data-test-class="log-row"]').first().waitFor();
  assert(await viewer.getByText("Message sent", { exact: true }).count() > 0);
  const title = await viewer.getByRole("heading", { name: copy.settings.logs.sections.viewer, exact: true }).boundingBox();
  const filter = await viewer.getByRole("combobox", { name: copy.settings.logs.filters.source, exact: true }).boundingBox();
  assert(title && filter && filter.y >= title.y + title.height, "filters stay below the section title");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
  await page.screenshot({ path: join(shots!, `${width}-${theme}-app.png`) });
}
try {
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", diagnostics_enabled: true }) });
  app = await fileElectronApp({ executablePath: executable, args: [resolve("packages/butler-app/client/electron")], env: {
    ...process.env, BUTLER_DATA: server.butlerData, BUTLER_HOME: process.env.HOME!,
    BUTLER_APP_ELECTRON_USER_DATA_DIR: profile, BUTLER_APP_SERVER_URL: `http://127.0.0.1:${proxyPort}`,
    BUTLER_APP_SERVER_PORT: String(proxyPort),
    BUTLER_APP_DISABLE_SHELL_REGISTRATION: "1", BUTLER_APP_RENDERER_DIST: resolve("packages/butler-app/client/ui/dist"),
  } });
  await waitFor(() => rows("app"), rows => rows.some(row => row.event === "app.start"), "App module initialized");
  await waitFor(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.webContents.getURL().startsWith("app://butler/"))), Boolean, "App renderer");
  await waitFor(async () => configStarted, value => value > 0, "startup config request");
  assert(configStarted > 0 && !configReleased, "window opens while agent config remains stalled");
  console.log(JSON.stringify({ stage: "slow agent window opened", config_pending_ms: Date.now() - configStarted }));
  configReleased = true; releaseConfig();
  const traceparent = `00-${crypto.randomUUID().replaceAll("-", "")}-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}-01`;
  // Exercise the actual renderer/preload public action channel, using its agent trace header.
  await app.evaluate(async ({ BrowserWindow }, traceparent) => {
    const contents = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith("app://butler/"))!.webContents;
    await contents.executeJavaScript(`(async () => {
      const log = window.butlerApp.log;
      log({ level: "INFO", category: "app.ui", event: "ui.send", process: "agent", attrs: { marker: "rejected-process" } });
      log({ level: "INFO", category: "lifecycle", event: "app.start", attrs: { marker: "rejected-category" } });
      log({ level: "INFO", category: "app.ui", event: "ui.send", attrs: { value: "x".repeat(17000) } });
      log({ level: "ERROR", category: "app.ui", event: "ui.error", attrs: { token: "private-renderer-token", url: "https://example.test/?code=private-lan-code" } });
      await window.butlerApp.recordUiCrash({ scope: "conversation", page: "session",
        message: "private conversation sk-secret", stack: "Error: private conversation sk-secret\\n    at render (https://host/assets/index.js:3:4)" });
      return await window.butlerApp.sendMessage({ chatId: "general", text: "Say hello.", clientMessageId: crypto.randomUUID(), traceparent: ${JSON.stringify(traceparent)} });
    })()`);
  }, traceparent);
  const appRows = await waitFor(() => rows("app"), rows => rows.some(row => row.event === "ui.send"), "App send record");
  assert(appRows.some(row => row.event === "app.start" && row.process === "app.main"));
  const crashRows = await waitFor(() => rows("app"), rows => rows.some(row => row.event === "ui.error" && row.error?.scope === "conversation"), "renderer crash record");
  assert(crashRows.some(row => row.category === "app.ui" && row.event === "ui.error" && row.process === "app.renderer"
    && row.error?.scope === "conversation" && row.error.stack));
  assert(!JSON.stringify(crashRows).includes("private conversation") && !JSON.stringify(crashRows).includes("sk-secret"));
  assert(appRows.every(row => row.msg && row.msg !== row.event));
  const action = appRows.find(row => row.event === "ui.send")!;
  assert.match(action.trace_id ?? "", /^[0-9a-f]{32}$/u);
  await waitFor(() => rows("all"), rows => rows.some(row => row.process === "agent" && row.trace_id === action.trace_id), "joined agent trace");
  const storage = await server.api<{ stores: { id: string; bytes: number }[] }>("/logs/storage");
  assert(storage.stores.some(store => store.id === "app/main" && store.bytes > 0));
  await fullBodySmoke();
  // No log viewer polling while measuring; standard's INFO lane must stay completely idle.
  await new Promise(resolve => setTimeout(resolve, 3000));
  await rows("all");
  const before = snapshot(), started = Date.now();
  await new Promise(resolve => setTimeout(resolve, 60_000));
  assert.deepEqual(snapshot(), before, "60 seconds at standard: zero bytes or mtime changes");
  const elapsed = Date.now() - started;
  console.log(JSON.stringify({ stage: "App trace and idle", idle_ms: elapsed, idle_bytes: 0, trace_id: action.trace_id }));
  for (const path of files().filter(path => path.endsWith(".jsonl"))) {
    const text = readFileSync(path, "utf8");
    for (const secret of [server.token, "private-renderer-token", "private-lan-code", "private conversation", "sk-secret", "rejected-process", "rejected-category", "x".repeat(17_000)]) assert(!text.includes(secret));
  }
  browser = await launchSmokeBrowser();
  const context = await browser.newContext({ locale: "ko-KR" });
  await server.signIn(context);
  const page = await context.newPage();
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: LEGACY_FIRST_RUN_STORAGE_KEY, value: legacyFirstRunCompleteRecord(),
  });
  await page.goto(server.url);
  for (const width of [1280, 390]) for (const theme of ["light", "dark"]) await capture(page, width, theme);
  await setLevel("full");
  await renderer(`window.butlerApp.recordUiCrash({ scope: "conversation", message: "clear-external-input" })`);
  await waitFor(async () => existsSync(join(server.butlerData, "logs/app/bodies")), Boolean, "body before external clear");
  const previousFiles = files();
  const cleared = await server.api<{ agent_freed_bytes: number; freed_bytes?: number }>("/logs", { method: "DELETE" });
  assert(cleared.agent_freed_bytes >= 0 && cleared.freed_bytes === undefined, "only confirmed agent bytes are reported");
  await waitFor(async () => previousFiles.some(path => existsSync(path)), exists => !exists, "gateway clear deletes every existing App segment");
  console.log(JSON.stringify({ stage: "external clear", removed_app_files: previousFiles.length, agent_freed_bytes: cleared.agent_freed_bytes }));
  console.log(JSON.stringify({ ok: true, idle_ms: elapsed, idle_bytes: 0, trace_id: action.trace_id, screenshots: 4 }));
} finally {
  await browser?.close();
  configReleased = true; releaseConfig();
  await app?.close();
  proxy.closeAllConnections();
  await new Promise<void>(resolve => proxy.close(() => resolve()));
  await server.stop();
  rmSync(root, { recursive: true, force: true });
}
