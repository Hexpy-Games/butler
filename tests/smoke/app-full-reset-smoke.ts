// Settings > General > reset everything, against the stub native gateway. No model calls.
// The desktop bridge is the real preload with a stubbed ipcRenderer; the relaunch is
// simulated by a reload that sees a new data generation and pending onboarding.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "playwright";
import { createNativeAppServer, type NativeAppServerHandle } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";

const SENTINELS = ["butler:first-run-setup:v1", "butler:composer-draft:v1:smoke", "butler:message-cache:v1:smoke", "butler:project-workspace-kinds:v1"];
const server = await createNativeAppServer({ uiRoot: resolve("packages/butler-app/client/ui/dist") });
const browser = await launchSmokeBrowser();
const calls: Array<{ channel: string; input: unknown }> = [];
let generation = "generation-1";
let reset = false;

async function installDesktopBridge(page: Page, handle: NativeAppServerHandle) {
  const code = readFileSync("packages/butler-app/client/electron/preload.cjs", "utf8");
  await page.evaluate(({ code, url, headers }) => {
    const ipcRenderer = {
      invoke: async (channel: string, input: unknown) => channel === "butler:get-server-url" ? url
        : channel === "butler:get-local-auth-headers" ? headers
        : channel.startsWith("butler:full-reset") ? (window as unknown as { smokeInvoke: (c: string, i: unknown) => Promise<unknown> }).smokeInvoke(channel, input ?? null)
        : null,
      on() {}, removeListener() {}, send() {},
    };
    const contextBridge = { exposeInMainWorld(name: string, value: unknown) {
      if (name === "butlerApp") Object.assign(window, { butlerApp: value });
    } };
    new Function("require", "process", code)(() => ({ contextBridge, ipcRenderer }), {
      env: { BUTLER_APP_SERVER_URL: url }, argv: [], platform: "darwin",
    });
  }, { code, url: handle.url, headers: handle.authHeaders });
}

async function openSettings(page: Page) {
  const settings = page.getByRole("button", { name: "설정", exact: true });
  if (!await settings.isVisible()) await page.getByRole("button", { name: "사이드바 보기", exact: true }).click();
  await settings.click();
}

async function tooltipShows(page: Page, target: ReturnType<Page["locator"]>, text: string) {
  await target.hover();
  await page.getByRole("tooltip").filter({ hasText: text }).waitFor();
  await page.mouse.move(0, 0);
}

try {
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko" }) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  await server.signIn(page);
  await page.exposeFunction("smokeInvoke", async (channel: string, input: unknown) => {
    calls.push({ channel, input });
    if (channel === "butler:full-reset-relaunch") { reset = true; generation = "generation-2"; }
    return { ok: true };
  });
  // Contract: GET /settings carries data_generation; a reset leaves onboarding pending.
  await page.route(/\/settings$/, async (route) => {
    if (route.request().method() !== "GET" || route.request().resourceType() === "document") return route.continue();
    const data = await server.api<Record<string, unknown> & { onboarding?: Record<string, unknown> }>("/settings");
    const view = { ...data, data_generation: generation, ...(reset ? { onboarding: { ...data.onboarding, completed_at: null } } : {}) };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ protocol_version: "butler.app.v1", data: view }) });
  });
  await page.goto(server.url, { waitUntil: "load" });
  await page.locator('[data-test-class~="composer-card"]').waitFor({ state: "visible" });
  await page.evaluate((keys) => { for (const key of keys) localStorage.setItem(key, "{}"); }, SENTINELS);

  // Web and LAN clients: present but disabled, with the reason as a tooltip.
  await openSettings(page);
  await page.getByRole("button", { name: "일반", exact: true }).click();
  const section = page.locator('[data-settings-section-id="full-reset"]');
  const webButton = section.getByRole("button");
  await webButton.waitFor();
  assert.equal(await webButton.getAttribute("aria-disabled"), "true", "browser clients cannot reset");
  await tooltipShows(page, webButton, "데스크톱 앱에서만 할 수 있습니다");
  await webButton.click({ force: true });
  assert.equal(await page.getByRole("alertdialog").count(), 0, "a disabled reset opens nothing");

  // Desktop: the typed phrase gates the destructive button.
  await installDesktopBridge(page, server);
  // Re-open General so the section renders with the desktop bridge.
  await page.getByRole("button", { name: "기억", exact: true }).click();
  await page.getByRole("button", { name: "일반", exact: true }).click();
  const desktopButton = section.getByRole("button", { name: "초기화", exact: true });
  assert.equal(await desktopButton.getAttribute("aria-disabled"), null, "the desktop app can reset");
  await desktopButton.click();
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor();
  const input = dialog.getByRole("textbox", { name: "확인하려면 ‘동의합니다’를 입력하세요" });
  assert(await input.evaluate((node) => node === document.activeElement), "the phrase field receives focus");
  const confirm = dialog.getByRole("button", { name: "초기화하고 다시 시작" });
  assert.equal(await confirm.getAttribute("aria-disabled"), "true", "empty phrase keeps confirm disabled");
  await input.fill("동의합");
  await input.press("Enter");
  await confirm.click({ force: true });
  assert.equal(await confirm.getAttribute("aria-disabled"), "true", "a partial phrase keeps confirm disabled");
  await tooltipShows(page, confirm, "문구를 정확히 입력하세요");
  await input.dispatchEvent("compositionstart");
  await input.fill("동의합니다");
  assert.equal(await confirm.getAttribute("aria-disabled"), "true", "text still being composed is never compared");
  await input.dispatchEvent("compositionend");
  await page.waitForFunction(() => document.querySelector('[role="alertdialog"] button[aria-disabled]') === null);
  assert.equal(calls.length, 0, "nothing was sent before the phrase matched");

  await input.press("Enter");
  await page.waitForFunction(() => document.querySelector('[data-settings-section-id="full-reset"] button[aria-busy="true"]') !== null);
  await section.getByText("초기화 중…").waitFor();
  assert.deepEqual(calls.map((call) => call.channel), ["butler:full-reset-request", "butler:full-reset-relaunch"]);
  assert.match(String((calls[0]!.input as { operationId?: string }).operationId), /^[A-Za-z0-9._-]{1,128}$/u);

  // Relaunch: the new data generation wipes renderer storage and the first run shows.
  await page.reload({ waitUntil: "load" });
  await page.locator('[data-test-class="first-run-setup"]').waitFor({ timeout: 30_000 });
  const left = await page.evaluate((keys) => keys.filter((key) => localStorage.getItem(key) !== null), SENTINELS);
  assert.deepEqual(left, [], "renderer storage from the old data is gone");
  assert.equal(await page.evaluate(() => localStorage.getItem("butler:data-generation:v1")), "generation-2");
  console.log("app-full-reset smoke: ok");
} finally {
  await browser.close();
  await server.stop();
}
