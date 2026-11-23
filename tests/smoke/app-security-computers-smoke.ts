import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Locator, Page } from "playwright";
import { appCopy, setAppCopyLanguage } from "../../packages/butler-app/client/ui/src/app/copy.ts";
import { computerAuthUrl, computerFingerprint, computerFixtures, createComputersFake } from "../support/computers-fixtures.ts";
import { createNativeAppServer, type NativeAppServerHandle } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";

const language = process.env.COMPUTERS_SMOKE_LANGUAGE ?? "ko";
setAppCopyLanguage(language);
const copy = appCopy.computers;
const common = appCopy.common;
const widths = [320, 375, 390, 430, 768, 1440];
const fake = createComputersFake();
const section = (page: Page) => page.locator('[data-settings-section-id="computers"]');
const button = (scope: Page | Locator, name: string) => scope.getByRole("button", { name, exact: true });
const addDialog = (page: Page) => page.locator('[data-test-class="computer-add-dialog"]');
const aiDialog = (page: Page) => page.locator('[data-test-class="computer-ai-dialog"]');
const row = (page: Page, name: string) => section(page).locator('[data-test-class="computer-row"]').filter({ hasText: name });
const lastCall = (method: string, path: string) => fake.calls.findLast((call) => call.method === method && call.path === path);

async function openSettings(page: Page) {
  await button(page, appCopy.sidebar.settings).click();
  await button(page, appCopy.settings.sections.security).click();
}

async function assertVisible(scope: Page | Locator, text: string) {
  const item = scope.getByText(text, { exact: true });
  await item.waitFor();
  assert(await item.isVisible(), text);
}

async function verifyLayouts(page: Page) {
  await button(section(page), copy.add).click();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    for (const area of [section(page), addDialog(page)]) {
      const fits = await area.evaluate((node) => node.scrollWidth <= node.clientWidth + 1);
      assert(fits, `Computers UI fits ${width}px`);
    }
  }
}

async function captureStates(page: Page, output: string, variant: string) {
  const { computers: copy, common } = appCopy;
  let captures = 0;
  async function screenshot(state: string, target: Locator) {
    await page.mouse.move(0, 0);
    await target.scrollIntoViewIfNeeded({ timeout: 10_000 });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    });
    await page.getByRole("tooltip").waitFor({ state: "hidden" });
    const path = join(output, `${state}-${variant}.png`);
    await target.screenshot({ path, animations: "allow", timeout: 10_000 });
    console.log(path);
    captures++;
  }

  await assertVisible(section(page), copy.empty);
  await screenshot("A1-empty", section(page));
  await button(section(page), copy.add).click();
  const dialog = addDialog(page);
  const submit = button(dialog, copy.form.submit);
  await screenshot("A3-form", dialog);

  const name = copy.form.namePlaceholder;
  await dialog.locator("#computer-name").fill(name);
  await dialog.locator("#computer-address").fill(copy.form.addressPlaceholder);
  await dialog.locator("#computer-folder").fill(copy.form.folderPlaceholder);
  await dialog.locator("#computer-port").fill("22");
  await dialog.locator("#computer-key-file").fill(copy.form.keyFilePlaceholder);
  await submit.click();
  const fingerprint = page.getByRole("alertdialog");
  await assertVisible(fingerprint, computerFingerprint);
  await screenshot("A4-fingerprint", fingerprint);

  let release!: () => void;
  fake.startHold = new Promise<void>((resolve) => { release = resolve; });
  try {
    const startRequest = page.waitForRequest((request) => /^\/computers\/[^/]+\/start$/u.test(new URL(request.url()).pathname));
    await button(fingerprint, copy.fingerprint.confirm).click();
    await startRequest;
    await assertVisible(dialog.getByRole("status"), copy.form.preparing);
    await screenshot("A5-preparing", dialog);
  } finally {
    release();
    fake.startHold = undefined;
  }

  const ai = aiDialog(page);
  await assertVisible(ai, copy.ai.sendKey);
  await screenshot("M1-ai", ai);
  await button(ai, appCopy.chatgptPlan.continue).click();
  await assertVisible(ai, appCopy.chatgptSignIn.pending);
  await page.waitForFunction((url) => (window as Window & { __opened?: string[] }).__opened?.includes(url), computerAuthUrl);
  await screenshot("M2-chatgpt-waiting", ai);
  await button(ai, common.cancel).click();
  await ai.getByRole("combobox").click();
  await page.getByRole("option", { name: "OpenAI", exact: true }).click();
  assert(await button(ai, copy.ai.send).isEnabled());
  await screenshot("M3-key-chosen", ai);
  await button(ai, copy.ai.later).click();

  await button(section(page), copy.add).click();
  await dialog.locator("#computer-name").fill(name);
  await dialog.locator("#computer-address").fill(copy.form.addressPlaceholder);
  await dialog.locator("#computer-folder").fill(copy.form.folderPlaceholder);
  for (const [state, step, code, message] of [
    ["A6-key-login", "add", "ssh_auth_failed", copy.errors.keyLogin],
    ["A6b-unreachable", "host-key", "ssh_unreachable", copy.errors.unreachable],
    ["A6c-fingerprint-changed", "host-key", "host_key_changed", copy.errors.fingerprintChanged],
    ["A7-unsupported", "add", "unsupported_computer", copy.errors.unsupported],
  ] as const) {
    fake.failNext(step, code);
    await submit.click();
    if (step === "add") await button(fingerprint, copy.fingerprint.confirm).click();
    await assertVisible(dialog.locator('[data-settings-field]:has(#computer-address)'), message);
    await screenshot(state, dialog);
  }
  await button(dialog, common.cancel).click();

  fake.computers = [...computerFixtures.map((computer) => ({ ...computer })), ...fake.computers];
  await page.reload();
  const [connected, unreachable, logout] = computerFixtures;
  await assertVisible(row(page, connected!.name), copy.status.connected);
  await assertVisible(row(page, unreachable!.name), copy.status.disconnected);
  await assertVisible(row(page, logout!.name), copy.status.stopsOnLogout);
  await assertVisible(row(page, name), copy.status.aiNeeded);
  await screenshot("A2-list", section(page));

  fake.computers = computerFixtures.map((computer) => ({ ...computer }));
  await page.reload();
  const deleteDialog = page.locator('[data-test-class="computer-delete-dialog"]');
  await button(row(page, connected!.name), copy.removeComputer(connected!.name)).click();
  await screenshot("A8-delete", deleteDialog);
  await deleteDialog.getByRole("checkbox", { name: copy.removeDialog.forget }).click();
  await screenshot("A8-delete-forget", deleteDialog);
  return captures;
}

const server = await createNativeAppServer({
  uiRoot: resolve("packages/butler-app/client/ui/dist"), config: { user: { name: "Smoke", language } },
});
let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
let secret = "";
let releaseStart: (() => void) | undefined;
try {
  secret = JSON.parse(readFileSync(join(server.butlerData, "app/runtime/auth/local-admin.json"), "utf8")).secret;
  const adminHeaders = { ...server.authHeaders, "x-butler-admin": secret };
  browser = await launchSmokeBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let inventoryRevision: number | undefined;
  async function configurePage(page: Page, server: NativeAppServerHandle, adminHeaders: Record<string, string>) {
    await page.addInitScript(() => {
      const urls: string[] = [];
      Object.assign(window, { __opened: urls });
      window.open = (url) => { urls.push(String(url)); return null; };
    });
    await page.route(`${server.url}**`, async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      if (path.startsWith("/computers") || (method === "GET" && path === "/credentials")) {
        await route.fulfill(await fake.respond({ method, path, body: request.postDataJSON() }));
        return;
      }
      const headers = { ...request.headers(), ...(path.startsWith("/security") || path === "/settings" ? adminHeaders : server.authHeaders) };
      if (path === "/memory/inventory" && method === "GET") {
        const response = await route.fetch({ headers });
        inventoryRevision = (await response.json()).data.revision;
        await route.fulfill({ response });
      } else {
        if (path.startsWith("/memory/reset/computers/")) fake.calls.push({ method, path, body: request.postDataJSON() });
        await route.continue({ headers });
      }
    });
  }
  await configurePage(page, server, adminHeaders);
  await page.goto(server.url);
  await openSettings(page);

  // A1 and required fields.
  await assertVisible(section(page), copy.empty);
  assert.equal(await page.getByRole("switch", { name: appCopy.settings.security.remoteAccess, exact: true }).getAttribute("aria-checked"), "false");
  assert(await button(section(page), copy.add).isVisible());
  await button(section(page), copy.add).click();
  const dialog = addDialog(page);
  const submit = button(dialog, copy.form.submit);
  assert(await submit.isDisabled());
  await submit.hover({ force: true });
  await assertVisible(page.getByRole("tooltip"), copy.form.required);

  const name = copy.form.namePlaceholder;
  const address = copy.form.addressPlaceholder;
  const folder = copy.form.folderPlaceholder;
  const keyFile = copy.form.keyFilePlaceholder;
  await dialog.locator("#computer-name").fill(name);
  await dialog.locator("#computer-address").fill(address);
  await dialog.locator("#computer-folder").fill("~");
  await submit.click();
  await assertVisible(dialog, copy.errors.homeFolder);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "computer-folder");
  assert.equal(lastCall("POST", "/computers/host-key"), undefined);

  // A4 and A5.
  await dialog.locator("#computer-folder").fill(folder);
  await dialog.locator("#computer-port").fill("22");
  await dialog.locator("#computer-key-file").fill(keyFile);
  await submit.click();
  const fingerprint = page.getByRole("alertdialog");
  await assertVisible(fingerprint, copy.fingerprint.title);
  await assertVisible(fingerprint, computerFingerprint);
  await button(fingerprint, common.cancel).click();
  assert.equal(lastCall("POST", "/computers"), undefined);
  assert(await dialog.locator("#computer-folder").isEnabled());
  fake.startHold = new Promise<void>((resolve) => { releaseStart = resolve; });
  await submit.click();
  const startRequest = page.waitForRequest((request) => /^\/computers\/[^/]+\/start$/u.test(new URL(request.url()).pathname));
  await button(fingerprint, copy.fingerprint.confirm).click();
  await startRequest;
  assert.deepEqual(lastCall("POST", "/computers")?.body, {
    name, address, port: 22, key_file: keyFile, folder, host_fingerprint: computerFingerprint,
  });
  await assertVisible(dialog.getByRole("status"), copy.form.preparing);
  assert.equal(await dialog.locator("input:disabled").count(), 5);
  assert.equal(await button(dialog, common.close).count(), 0);
  assert(await button(dialog, common.cancel).isDisabled());
  releaseStart?.();
  await dialog.waitFor({ state: "hidden" });
  const ai = aiDialog(page);
  await assertVisible(ai, copy.ai.title);
  await assertVisible(ai, copy.ai.description(name));
  await row(page, name).waitFor();
  assert(await row(page, name).isVisible());

  // M4, M2, M1 and M3.
  const computerPath = `/computers/${fake.computers[0]!.id}`;
  await button(ai, copy.ai.later).click();
  await assertVisible(row(page, name), copy.status.aiNeeded);
  await button(row(page, name), copy.connectAi).click();
  await button(ai, appCopy.chatgptPlan.continue).click();
  await assertVisible(ai, appCopy.chatgptSignIn.pending);
  await page.waitForFunction((url) => (window as Window & { __opened?: string[] }).__opened?.includes(url), computerAuthUrl);
  assert.deepEqual(lastCall("POST", `${computerPath}/oauth/start`)?.body, { kind: "default" });
  assert.equal(await ai.getByText(copy.ai.sendKey, { exact: true }).count(), 0);
  const cancelled = page.waitForResponse((response) => new URL(response.url()).pathname === `${computerPath}/oauth/flow_1/cancel` && response.request().method() === "POST");
  await button(ai, common.cancel).click();
  assert.equal((await cancelled).status(), 200);
  await assertVisible(ai, copy.ai.sendKey);
  const send = button(ai, copy.ai.send);
  assert(await send.isDisabled());
  await send.hover({ force: true });
  await assertVisible(page.getByRole("tooltip"), copy.ai.chooseKeyFirst);
  await ai.getByRole("combobox").click();
  await page.getByRole("option", { name: "OpenAI", exact: true }).click();
  assert(await send.isEnabled());
  await send.click();
  await ai.waitFor({ state: "hidden" });
  assert.deepEqual(lastCall("POST", `${computerPath}/credentials`)?.body, { credential_id: "openai" });
  await assertVisible(page, copy.ai.connected);

  // A6, A6b, A6c and A7.
  await button(section(page), copy.add).click();
  await dialog.locator("#computer-name").fill(name);
  await dialog.locator("#computer-address").fill(address);
  await dialog.locator("#computer-folder").fill(folder);
  for (const [step, code, message] of [
    ["add", "ssh_auth_failed", copy.errors.keyLogin],
    ["host-key", "ssh_unreachable", copy.errors.unreachable],
    ["host-key", "host_key_changed", copy.errors.fingerprintChanged],
    ["add", "unsupported_computer", copy.errors.unsupported],
  ] as const) {
    fake.failNext(step, code);
    await submit.click();
    if (step === "add") await button(fingerprint, copy.fingerprint.confirm).click();
    await assertVisible(dialog.locator('[data-settings-field]:has(#computer-address)'), message);
    assert.equal(await dialog.locator("input:enabled").count(), 5);
    assert.equal(await page.evaluate(() => document.activeElement?.id), "computer-address");
  }
  await button(dialog, common.cancel).click();

  // A2 and A10.
  fake.computers = computerFixtures.map((computer) => ({ ...computer }));
  await page.reload();
  await openSettings(page);
  const [connected, unreachable, logout] = computerFixtures;
  await assertVisible(row(page, connected!.name), copy.status.connected);
  await assertVisible(row(page, unreachable!.name), copy.status.disconnected);
  await assertVisible(row(page, logout!.name), copy.status.stopsOnLogout);
  await row(page, logout!.name).hover();
  await assertVisible(page.getByRole("tooltip"), copy.stopsOnLogoutHint);

  // A8, then the same action with the memory option checked.
  const removal = copy.removeDialog;
  const deleteDialog = page.locator('[data-test-class="computer-delete-dialog"]');
  const forget = deleteDialog.getByRole("checkbox", { name: removal.forget });
  await button(row(page, connected!.name), copy.removeComputer(connected!.name)).click();
  await assertVisible(deleteDialog, removal.title);
  await assertVisible(deleteDialog, removal.body);
  assert.equal(await forget.getAttribute("aria-checked"), "false");
  await button(deleteDialog, removal.confirm).click();
  await row(page, connected!.name).waitFor({ state: "hidden" });
  assert.equal(fake.calls.filter(({ method, path }) => method === "DELETE" && path === `/computers/${connected!.id}`).length, 1);
  assert(!fake.calls.some(({ path }) => path.startsWith("/memory/reset/computers/")));

  const resetPath = `/memory/reset/computers/${unreachable!.id}`;
  await button(row(page, unreachable!.name), copy.removeComputer(unreachable!.name)).click();
  await forget.click();
  assert.equal(await forget.getAttribute("aria-checked"), "true");
  const reset = page.waitForResponse((response) => new URL(response.url()).pathname === resetPath);
  await button(deleteDialog, removal.confirm).click();
  assert.equal((await reset).status(), 202);
  const deleted = fake.calls.findIndex(({ method, path }) => method === "DELETE" && path === `/computers/${unreachable!.id}`);
  const resetCall = fake.calls.findIndex(({ method, path }) => method === "POST" && path === resetPath);
  assert(deleted >= 0 && resetCall > deleted);
  const resetBody = fake.calls[resetCall]!.body as { operation_id: string; inventory_revision: number };
  assert.match(resetBody.operation_id, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u);
  assert.equal(typeof inventoryRevision, "number");
  assert.equal(resetBody.inventory_revision, inventoryRevision);
  await row(page, unreachable!.name).waitFor({ state: "hidden" });
  await verifyLayouts(page);
  assert.equal(server.stubModelCalls.length, 0);
  console.log(JSON.stringify({
    ok: true, checks: ["empty", "required", "home-folder", "fingerprint", "preparing", "later", "chatgpt", "send-key", "failures", "statuses", "delete", "forget-memories", "layouts"], widths,
  }));

  const screenshots = process.env.BUTLER_SMOKE_SCREENSHOTS;
  if (screenshots !== undefined) {
    const output = resolve(screenshots);
    mkdirSync(output, { recursive: true });
    await page.close();
    let captures = 0;
    for (const [locale, variants] of [
      ["ko", [["light", "desktop", 1280, 900], ["dark", "desktop", 1280, 900], ["light", "mobile", 375, 812]]],
      ["en", [["light", "desktop", 1280, 900]]],
    ] as const) {
      setAppCopyLanguage(locale);
      const captureServer = await createNativeAppServer({
        uiRoot: resolve("packages/butler-app/client/ui/dist"), config: { user: { name: "Smoke", language: locale } },
      });
      let captureSecret = "";
      try {
        captureSecret = JSON.parse(readFileSync(join(captureServer.butlerData, "app/runtime/auth/local-admin.json"), "utf8")).secret;
        const headers = { ...captureServer.authHeaders, "x-butler-admin": captureSecret };
        for (const [theme, size, width, height] of variants) {
          fake.computers = [];
          await captureServer.api("/settings", { method: "PATCH", headers, body: JSON.stringify({ appearance_theme: theme }) });
          const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { width, height } });
          try {
            const capturePage = await context.newPage();
            await captureServer.signIn(capturePage);
            await configurePage(capturePage, captureServer, headers);
            await capturePage.goto(`${captureServer.url}?settings=security`, { waitUntil: "domcontentloaded" });
            captures += await captureStates(capturePage, output, `${locale}-${theme}-${size}`);
          } finally {
            await context.close();
          }
        }
      } catch (error) {
        const message = String(error).replaceAll(captureServer.token, "[redacted]");
        throw new Error(captureSecret ? message.replaceAll(captureSecret, "[redacted]") : message, { cause: error });
      } finally {
        await captureServer.stop();
      }
    }
    console.log(JSON.stringify({ captures }));
  }
} catch (error) {
  const message = String(error).replaceAll(server.token, "[redacted]");
  console.error(secret ? message.replaceAll(secret, "[redacted]") : message);
  process.exitCode = 1;
} finally {
  releaseStart?.();
  try { await browser?.close(); } finally { await server.stop(); }
}
