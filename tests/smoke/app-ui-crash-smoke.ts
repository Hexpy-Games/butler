import { spawn } from "node:child_process";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { type Page } from "playwright";
import { createUiCrashStore } from "../../packages/butler-app/client/electron/ui-crash-store.mjs";
import { CRASH_LOG_BYTES, CRASH_LOG_KEY } from "../../packages/butler-app/client/electron/ui-crash-log.mjs";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";

const productionAssets = resolve("packages/butler-app/client/ui/dist/assets");
const productionChunks = readdirSync(productionAssets).filter(name => name.endsWith(".js"));
assert(productionChunks.length > 0);
for (const chunk of productionChunks) {
  const source = readFileSync(join(productionAssets, chunk), "utf8");
  assert(!source.includes("__butlerCrashSmoke") && !source.includes("private conversation sk-secret"));
}
// Each matrix group owns a fresh gateway and browser driver process.
// Restricted single-process Chromium must not accumulate closed CDP surfaces.
if (!process.argv.includes("--case")) {
  for (const width of [1280, 375]) {
    for (const theme of ["light", "dark"]) await runCase(width, theme);
  }
  console.log("UI crash matrix passed: 1280/375, light/dark, KO/EN");
  process.exit(0);
}
const caseIndex = process.argv.indexOf("--case");
const caseWidth = Number(process.argv[caseIndex + 1]);
const caseTheme = process.argv[caseIndex + 2];
assert([1280, 375].includes(caseWidth) && ["light", "dark"].includes(caseTheme!));

async function runCase(width: number, theme: string) {
  const isolation = mkdtempSync(join(tmpdir(), "butler-crash-case-"));
  mkdirSync(join(isolation, "home"));
  mkdirSync(join(isolation, "data"));
  try {
    const child = spawn(process.execPath, [import.meta.path, "--case", String(width), theme], {
      env: { ...process.env, HOME: join(isolation, "home"), BUTLER_DATA: join(isolation, "data") },
      stdio: "inherit",
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("exit", resolve);
    });
    assert.equal(code, 0, `${width}/${theme} crash smoke failed`);
  } finally { rmSync(isolation, { recursive: true, force: true }); }
}

const output = resolve(".tmp/ui-crash-smoke");
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), "butler-ui-crash-"));
const store = createUiCrashStore(temporary, () => "0.1.0-preview.10");
const server = await createNativeAppServer({ uiRoot: resolve(".tmp/ui-crash-build") });
const browser = await launchSmokeBrowser();
let currentPage: Page | undefined;

async function inject(page: Page, scope: string) {
  await page.evaluate((scope) => {
    const hook = (window as unknown as { __butlerCrashSmoke?: { inject(scope: string): void } }).__butlerCrashSmoke;
    if (!hook) throw new Error("Crash smoke hook unavailable");
    hook.inject(scope);
  }, scope);
}

async function entries(page: Page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "[]") as Array<{
    scope: string; stack: string; componentStack: string; appVersion: string; page: string; timestamp: string;
  }>, CRASH_LOG_KEY);
}

async function panelSmoke(width: number, theme: string, locale: string) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  currentPage = page;
  await server.signIn(page);
  await page.addInitScript((key) => {
    const original = Storage.prototype.setItem;
    let writes = 0;
    Object.defineProperty(window, "__crashWrites", { get: () => writes });
    Storage.prototype.setItem = function (name, value) {
      if (name === key) writes++;
      return original.call(this, name, value);
    };
  }, CRASH_LOG_KEY);
  const url = `${server.url}?visual=components&theme=${theme}&locale=${locale}&developer=1`;
  await page.goto(url);
  await page.locator('[data-test-class~="summary-progress-panel"]').waitFor();
  await page.waitForTimeout(1000);
  assert.equal(await page.evaluate(() => (window as unknown as { __crashWrites: number }).__crashWrites), 0);
  const retry = locale === "ko" ? "다시 시도" : "Retry";
  const label = `${width}-${theme}-${locale}`;
  await page.screenshot({ path: join(output, `${label}-before.png`) });
  await inject(page, "inspector-summary");
  await page.getByRole("button", { name: retry, exact: true }).waitFor();
  assert.equal(await page.locator('[data-test-class~="conversation"]').count(), 1);
  assert.equal(await page.locator('[data-test-class~="composer-card"]').count(), 1);
  await page.screenshot({ path: join(output, `${label}-after.png`) });
  const log = await entries(page);
  assert(log.some(entry => entry.scope === "inspector-summary" && entry.stack && entry.componentStack && entry.page === "session" && entry.appVersion !== "unknown" && !Number.isNaN(Date.parse(entry.timestamp))));
  assert(!JSON.stringify(log).includes("private conversation"));
  assert(!JSON.stringify(log).includes("sk-secret"));
  await page.getByRole("button", { name: retry, exact: true }).click();
  await page.locator('[data-test-class~="summary-progress-panel"]').waitFor();
  const count = (await entries(page)).length;
  const writes = await page.evaluate(() => (window as unknown as { __crashWrites: number }).__crashWrites);
  await page.waitForTimeout(1000);
  assert.equal((await entries(page)).length, count, "retry/idle must not write");
  assert.equal(await page.evaluate(() => (window as unknown as { __crashWrites: number }).__crashWrites), writes);
  // The inspector tab navigation stays usable while one panel has crashed.
  await inject(page, "inspector-summary");
  const tabs = page.locator('[data-test-class~="right-inspector"]').getByRole("button");
  await tabs.nth(2).click();
  assert.equal(await page.getByRole("button", { name: retry, exact: true }).count(), 0);
  await tabs.first().click();
  await page.getByRole("button", { name: retry, exact: true }).click();
  // Close the mobile overlay, then actually edit the unaffected composer.
  if (width === 375) await page.getByRole("button", { name: locale === "ko" ? "오른쪽 패널 숨기기" : "Hide right panel", exact: true }).first().click();
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.fill("smoke draft");
  assert.equal(await editor.innerText(), "smoke draft");
  await inject(page, "messages");
  await page.getByRole("button", { name: retry, exact: true }).waitFor();
  await page.screenshot({ path: join(output, `${label}-messages-after.png`) });
  await page.getByRole("button", { name: retry, exact: true }).click();
  assert.equal(await editor.innerText(), "smoke draft", "message crash must preserve composer draft");
  await inject(page, "composer");
  await page.getByRole("button", { name: retry, exact: true }).waitFor();
  const retryBox = await page.getByRole("button", { name: retry, exact: true }).boundingBox();
  assert(retryBox && retryBox.y >= 0 && retryBox.y + retryBox.height <= 900, "composer retry must stay in the viewport");
  await page.screenshot({ path: join(output, `${label}-composer-after.png`) });
  await page.getByRole("button", { name: retry, exact: true }).click();
  await editor.waitFor();
  await page.evaluate(() => {
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("secret window text") }));
    window.dispatchEvent(new PromiseRejectionEvent("unhandledrejection", { promise: Promise.resolve(), reason: new Error("secret rejection text") }));
  });
  assert((await entries(page)).some(entry => entry.scope === "window-error" && entry.stack));
  assert((await entries(page)).some(entry => entry.scope === "unhandled-rejection" && entry.stack));
  await page.reload();
  await page.locator('[data-test-class~="composer-card"]').waitFor();
  assert((await entries(page)).some(entry => entry.scope === "inspector-summary"), "log survives reload");
  await inject(page, "app");
  const reload = page.getByRole("button", { name: locale === "ko" ? "다시 불러오기" : "Reload", exact: true });
  await reload.click();
  await page.locator('[data-test-class~="composer-card"]').waitFor();
  await page.close();
}

async function pageSmoke(width: number, theme: string) {
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: theme, language: "en" }) });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  currentPage = page;
  await server.signIn(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { async writeText(text: string) {
      (window as unknown as { __diagnostics: string }).__diagnostics = text;
    } } });
  });
  await page.goto(server.url);
  await page.locator('[data-test-class~="composer-card"]').waitFor();
  await page.screenshot({ path: join(output, `${width}-${theme}-page-before.png`) });
  await inject(page, "conversation");
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
  assert.equal(await page.locator('[data-test-class~="workspace"]').count(), 1);
  await page.screenshot({ path: join(output, `${width}-${theme}-page-after.png`) });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.locator('[data-test-class~="composer-card"]').waitFor();
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").fill("privacy");
  await dialog.getByRole("option").filter({ hasText: "Privacy" }).click();
  const exportButton = page.getByRole("button", { name: "Copy diagnostics", exact: true });
  await exportButton.waitFor();
  await page.screenshot({ path: join(output, `${width}-${theme}-diagnostics-before.png`) });
  await exportButton.click();
  await page.waitForFunction(() => Boolean((window as unknown as { __diagnostics?: string }).__diagnostics));
  const report = await page.evaluate(() => JSON.parse((window as unknown as { __diagnostics: string }).__diagnostics));
  assert(report.ui_crashes.some((entry: { scope: string; stack: string }) => entry.scope === "conversation" && entry.stack));
  await inject(page, "settings");
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
  await page.screenshot({ path: join(output, `${width}-${theme}-diagnostics-after.png`) });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await exportButton.waitFor();
  await page.close();
}

async function preloadSmoke() {
  let bridge: { recordUiCrash(input: unknown): Promise<unknown>; readUiCrashLog(): Promise<unknown[]> } | undefined;
  runInNewContext(readFileSync(resolve("packages/butler-app/client/electron/preload.cjs"), "utf8"), {
    URL, URLSearchParams, TextEncoder, console,
    process: { env: { BUTLER_APP_SERVER_URL: server.url }, argv: [], platform: process.platform },
    require: () => ({
      contextBridge: { exposeInMainWorld(_name: string, value: typeof bridge) { bridge = value; } },
      ipcRenderer: { on() {}, removeListener() {}, invoke(channel: string, input: unknown) {
        if (channel === "butler:ui-crash") return store.append(input);
        if (channel === "butler:ui-crash-log") return store.read();
        return Promise.resolve({});
      } },
    }),
  });
  assert(bridge);
  await bridge.recordUiCrash({ message: "TypeError: Cannot read properties of null", stack: "    at render (index.js:3:4)", page: "session" });
  assert((await bridge.readUiCrashLog()).length > 0);
}

async function persistenceSmoke() {
  assert.deepEqual(await store.read(), []);
  assert(!existsSync(store.path), "zero startup/idle writes");
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert(!existsSync(store.path));
  await Promise.all(Array.from({ length: 60 }, (_, index) => store.append({
    message: `Error: conversation secret-${index}`, stack: `Error: secret\n    at render (https://host/assets/index.js:1:${index})`,
    componentStack: "\n    at SummaryPanel (https://host/assets/index.js:2:3)", page: "session", scope: "inspector-summary",
  })));
  const restarted = createUiCrashStore(temporary, () => "0.1.0-preview.10");
  const log = await restarted.read();
  assert.equal(log.length, 50);
  assert(log[0].stack.endsWith(":1:10)"));
  assert(log[49].stack.endsWith(":1:59)"));
  assert(!readFileSync(store.path, "utf8").includes("secret"));
  assert.equal(statSync(store.path).mode & 0o777, 0o600);
  const before = statSync(store.path);
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(statSync(store.path).mtimeMs, before.mtimeMs);
  assert(before.size < CRASH_LOG_BYTES);
  console.log(JSON.stringify({ entries: log.length, bytes: before.size, idleWrites: 0 }));
  await store.append({ message: "Error: Minified React error #130; args[]=private conversation sk-secret" });
  assert.equal((await store.read()).at(-1)?.message, "React error #130");
}

let failure: unknown;
let cleanupErrors: unknown[] = [];
try {
  await persistenceSmoke();
  await preloadSmoke();
  await pageSmoke(caseWidth, caseTheme!);
  for (const locale of ["en", "ko"]) {
    await panelSmoke(caseWidth, caseTheme!, locale);
    console.log(`Passed ${caseWidth}/${caseTheme}/${locale}`);
  }
  console.log("UI crash smoke passed: containment, retry, reload, global capture, persistence, privacy, idle writes");
} catch (error) {
  if (currentPage) {
    const page = currentPage;
    console.error("Failure page", await Promise.race([page.evaluate(() => ({
      title: document.title, rootText: document.getElementById("root")?.textContent?.slice(0, 400),
      panels: document.querySelectorAll('[data-test-class~="summary-progress-panel"]').length,
      composers: document.querySelectorAll('[data-test-class~="composer-card"]').length,
    })).catch(() => "renderer unavailable"), new Promise(resolve => setTimeout(() => resolve("renderer unresponsive"), 1000))]));
  }
  failure = error;
} finally {
  const cleanup = await Promise.allSettled([browser.close(), server.stop()]);
  rmSync(temporary, { recursive: true, force: true });
  cleanupErrors = cleanup.flatMap(result => result.status === "rejected" ? [result.reason] : []);
}

if (failure || cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], "UI crash smoke failed");
