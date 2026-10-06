/** Public Browser area on an isolated, real Electron App and stub gateway. */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { createNativeAppServer, freePort } from "../support/native-app-server";
import { smokeElectronArgs } from "../support/smoke-browser";

type BrowserTestWindow = Window & { butlerBrowser: { call(op: string, input?: unknown): Promise<unknown> } };
const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "browser-area-"));
const evidence = process.env.BUTLER_BROWSER_EVIDENCE;
if (!evidence) throw new Error("BUTLER_BROWSER_EVIDENCE is required");
mkdirSync(evidence, { recursive: true });
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const fixture = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/heavy") return new Response("<title>Heavy</title><script>setInterval(()=>{let a=[];for(let i=0;i<100000;i++)a.push(Math.sqrt(i));},16)</script><h1>Heavy page</h1>");
  return new Response(`<title>${path === "/second" ? "Second" : "Fixture"}</title><h1>${path}</h1><a href="/second">Next</a><a href="/popup" target="_blank">Popup</a><input aria-label="Field">`, { headers: { "content-type": "text/html" } });
} });
let app: ElectronApplication | undefined;
let gateway: Awaited<ReturnType<typeof createNativeAppServer>> | undefined;
let proxy: ReturnType<typeof Bun.serve> | undefined;
const logs: string[] = [];

async function state(page: Page) {
  return await page.evaluate(() => (window as unknown as BrowserTestWindow).butlerBrowser.call("state")) as { activeId: string; tabs: Array<{ id: string; title: string; url: string; status: string; canBack: boolean }> };
}
async function call(page: Page, op: string, input = {}) {
  return await page.evaluate(({ op, input }) => (window as unknown as BrowserTestWindow).butlerBrowser.call(op, input), { op, input });
}
async function waitTitle(page: Page, title: string) {
  await page.waitForFunction(async (expected) => {
    const snapshot = await (window as unknown as BrowserTestWindow).butlerBrowser.call("state") as { tabs: Array<{ title: string; status: string }> };
    return snapshot.tabs.some(tab => tab.title === expected && tab.status === "idle");
  }, title);
}
async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(evidence!, `${name}.png`) });
}
async function screenStates(page: Page, locale: string, theme: string) {
  await gateway!.api("/settings", { method: "PATCH", body: JSON.stringify({ language: locale, appearance_theme: theme }) });
  await page.reload();
  await page.getByText(locale === "ko" ? "브라우저" : "Browser", { exact: true }).first().click();
  await shot(page, `${locale}-${theme}-idle`);
  await page.getByRole("button", { name: locale === "ko" ? "검색" : "Search", exact: true }).click();
  await page.waitForSelector('[data-slot="native-view-slot"][data-occluded] img');
  assert.ok(await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.length === 1), "covered page detached");
  await shot(page, `${locale}-${theme}-overlay-still`);
  await page.keyboard.press("Escape");
}
try {
  gateway = await createNativeAppServer({ uiRoot: resolve(root, "packages/butler-app/client/ui/dist"), devOrigins: [origin] });
  await gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en" }) });
  proxy = Bun.serve({ port, hostname: "127.0.0.1", idleTimeout: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response(Bun.file(resolve(root, "packages/butler-app/client/ui/dist/index.html")), { headers: { "content-type": "text/html" } });
    return fetch(`${gateway!.url}${url.pathname}${url.search}`, { method: request.method, headers: request.headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer() });
  } });
  app = await electron.launch({ executablePath: process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE,
    args: [...smokeElectronArgs(), resolve(root, "packages/butler-app/client/electron")], timeout: 30_000,
    env: { ...process.env, HOME: join(dir, "home"), BUTLER_HOME: join(dir, "home"), BUTLER_DATA: gateway.butlerData,
      BUTLER_APP_ELECTRON_USER_DATA_DIR: join(dir, "profile"), BUTLER_APP_UI_URL: origin,
      BUTLER_APP_SERVER_URL: gateway.url, BUTLER_APP_SERVER_PORT: String(new URL(gateway.url).port), BUTLER_APP_DEV_ORIGIN: origin,
      BUTLER_E2E_TIER: "stub" } });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900));
  page.on("pageerror", error => logs.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForSelector('[data-test-class="browser-entry"]');
  await shot(page, "before-en-light-workspace");
  assert.equal(await app.evaluate(({ webContents }) => webContents.getAllWebContents().length), 1, "no web tab process before Browser activation");
  await page.locator('[data-test-class="browser-entry"]').click();
  await page.getByText("Open a new tab", { exact: true }).waitFor();
  await shot(page, "en-light-empty");
  await page.getByRole("button", { name: "New tab", exact: true }).last().click();
  const address = page.getByRole("textbox", { name: "Address", exact: true });
  await address.fill(`http://127.0.0.1:${fixture.port}/first`); await address.press("Enter");
  await waitTitle(page, "Fixture");
  let snapshot = await state(page); const first = snapshot.activeId;
  await address.fill(`http://127.0.0.1:${fixture.port}/second`); await address.press("Enter");
  await waitTitle(page, "Second");
  await page.getByRole("button", { name: "Back", exact: true }).click(); await waitTitle(page, "Fixture");
  await page.getByRole("button", { name: "Forward", exact: true }).click(); await waitTitle(page, "Second");
  await page.getByRole("button", { name: "Reload", exact: true }).click(); await waitTitle(page, "Second");
  await call(page, "create", { url: "https://www.iana.org/" });
  await page.waitForFunction(async () => {
    const s = await (window as unknown as BrowserTestWindow).butlerBrowser.call("state") as { tabs: Array<{ url: string; title: string; status: string }> };
    return s.tabs.some(t => t.url.startsWith("https://www.iana.org") && t.title.includes("IANA") && t.status === "idle");
  });
  await app.evaluate(() => {
    const histogram = process.getBuiltinModule("node:perf_hooks")!.monitorEventLoopDelay({ resolution: 1 });
    histogram.enable();
    (globalThis as unknown as { browserLoop: typeof histogram }).browserLoop = histogram;
  });
  await call(page, "create", { url: `http://127.0.0.1:${fixture.port}/heavy` });
  await waitTitle(page, "Heavy");
  await page.waitForTimeout(10_000);
  const loop = await app.evaluate(() => {
    const histogram = (globalThis as unknown as { browserLoop: { percentile(p: number): number; max: number; disable(): void } }).browserLoop;
    histogram.disable(); return { p99Ms: histogram.percentile(99) / 1e6, maxMs: histogram.max / 1e6 };
  });
  const heavy = (await state(page)).activeId;
  assert.equal((await state(page)).tabs.length, 3, "heavy measurement retains all tabs");
  assert.ok(loop.p99Ms <= 30 && loop.maxMs <= 200, JSON.stringify(loop));
  writeFileSync(join(evidence, "main-loop.json"), JSON.stringify(loop));
  await call(page, "close", { id: heavy });
  snapshot = await state(page);
  await call(page, "move", { tabId: first, toGroupId: "mine", index: 1 });
  assert.equal((await state(page)).tabs[1]!.id, first);
  await call(page, "activate", { id: first });
  for (const locale of ["ko", "en"]) for (const theme of ["light", "dark"]) await screenStates(page, locale, theme);
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const view = win.contentView.children.find(child => "webContents" in child && child !== win.contentView.children[0]);
    (view as unknown as { webContents: { forcefullyCrashRenderer(): void } }).webContents.forcefullyCrashRenderer();
  });
  await page.getByText("Tab crashed", { exact: true }).first().waitFor();
  await shot(page, "en-dark-crash");
  await page.getByRole("button", { name: "Reload", exact: true }).last().click(); await waitTitle(page, "Second");
  await call(page, "close", { id: first }); assert.equal((await state(page)).tabs.length, 1);
  writeFileSync(join(evidence, "electron-result.json"), JSON.stringify({ ok: true, logs, tabs: (await state(page)).tabs.length }));
} catch (error) {
  writeFileSync(join(evidence, "electron-failure.txt"), `${String(error)}\n${logs.join("\n")}`);
  throw error;
} finally {
  await app?.close(); proxy?.stop(true); fixture.stop(true); await gateway?.stop(); rmSync(dir, { recursive: true, force: true });
}
