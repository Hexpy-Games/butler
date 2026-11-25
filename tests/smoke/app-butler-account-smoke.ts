import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Page } from "playwright";
import { appCopy, setAppCopyLanguage } from "../../packages/butler-app/client/ui/src/app/copy.ts";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";

async function startFakeCloud() {
  const account = { id: "acc_fake", email: "user@example.com", created_at: "2026-01-01T00:00:00Z" };
  const device = { id: "dev_fake", name: "Butler", platform: "macos" };
  const state = {
    plan: "free",
    devices: [
      { ...device, created_at: "2026-01-01T00:00:00Z", last_seen_at: null, current: true },
      { id: "dev_other", name: "Other", platform: "linux", created_at: "2026-01-01T00:00:00Z", last_seen_at: null, current: false },
    ],
  };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const path = request.url;
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && path === "/v1/auth/email/start") {
      response.writeHead(202).end();
    } else if (request.method === "POST" && path === "/v1/auth/email/verify") {
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (input.code === "123456") response.end(JSON.stringify({ device_token: "bct_fake", account, device }));
      else response.writeHead(400).end(JSON.stringify({ error: { code: "code_invalid", message: "The code is invalid." } }));
    } else if (request.headers.authorization !== "Bearer bct_fake") {
      response.writeHead(401).end(JSON.stringify({ error: { code: "unauthorized", message: "Unauthorized." } }));
    } else if (request.method === "GET" && path === "/v1/me") {
      response.end(JSON.stringify({ account, device, entitlements: { plan: state.plan, status: "active", renews_at: null, features: {} } }));
    } else if (request.method === "GET" && path === "/v1/devices") {
      response.end(JSON.stringify({ devices: state.devices }));
    } else if (request.method === "DELETE" && path?.startsWith("/v1/devices/")) {
      const id = decodeURIComponent(path.slice("/v1/devices/".length));
      state.devices = state.devices.filter((entry) => entry.id !== id);
      response.writeHead(204).end();
    } else if (request.method === "POST" && path === "/v1/auth/sign-out") {
      response.writeHead(204).end();
    } else {
      response.writeHead(404).end(JSON.stringify({ error: { code: "not_found", message: "Not found." } }));
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}`, state, stop: () => new Promise<void>((done) => server.close(() => done())) };
}

// Screenshots for review can be taken in another UI language; the checks read the same copy.
const language = process.env.BUTLER_SMOKE_LANGUAGE ?? "en";
setAppCopyLanguage(language);
const copy = appCopy.butlerAccount;
const widths = [320, 375, 390, 430, 768, 1440];
const section = (page: Page, id: string) => page.locator(`[data-settings-section-id="${id}"]`);

async function openAccount(page: Page) {
  await page.getByRole("button", { name: appCopy.sidebar.settings, exact: true }).click();
  await page.getByRole("button", { name: appCopy.settings.sections.account, exact: true }).click();
}

async function verifyLayouts(page: Page) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `page fits ${width}px`);
    const overflow = await page.locator("[data-settings-section-id]").evaluateAll((nodes) => nodes.some((node) => node.scrollWidth > node.clientWidth + 1));
    assert.equal(overflow, false, `Settings sections fit ${width}px`);
  }
}

async function screenshot(page: Page, state: string, fullPage = true) {
  const directory = process.env.BUTLER_SMOKE_SHOTS;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      if (state === "nav") {
        if (width === 390) {
          if (await page.locator('[data-test-class~="settings-view"]').getAttribute("data-compact-pane") === "detail") {
            await page.locator('[data-test-class~="settings-view"]').getByRole("main")
              .getByRole("button", { name: appCopy.settings.back, exact: true }).click();
          }
          await page.locator('[data-test-class="settings-sidebar"]')
            .getByRole("button", { name: appCopy.settings.sections.account, exact: true }).waitFor();
        } else {
          await page.getByRole("button", { name: appCopy.settings.sections.account, exact: true }).click();
          await section(page, "butler-account").getByRole("button", { name: copy.signIn, exact: true }).waitFor();
        }
      }
      await page.evaluate(() => Promise.all(document.getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined))));
      await page.screenshot({ path: join(directory, `butler-account-${state}-${language}-${colorScheme}-${width}.png`), fullPage });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function signedInFlow(page: Page, fake: Awaited<ReturnType<typeof startFakeCloud>>) {
  const account = section(page, "butler-account");
  const signIn = account.getByRole("button", { name: copy.signIn, exact: true });
  await signIn.waitFor();
  assert.equal(await account.getByLabel(copy.email, { exact: true }).count(), 0);
  await verifyLayouts(page);
  await screenshot(page, "signed-out");
  await signIn.click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await page.waitForFunction(() => document.activeElement?.id === "butler-account-email");
  await screenshot(page, "email", false);
  await dialog.getByLabel(copy.email, { exact: true }).fill("user@example.com");
  await dialog.getByLabel(copy.email, { exact: true }).press("Enter");
  await dialog.getByLabel(copy.code, { exact: true }).fill("000000");
  await dialog.getByRole("button", { name: copy.signIn, exact: true }).click();
  await dialog.getByText(copy.codeInvalid, { exact: true }).waitFor();
  await verifyLayouts(page);
  await screenshot(page, "code-error", false);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await signIn.click();
  await dialog.waitFor();
  const email = dialog.getByLabel(copy.email, { exact: true });
  await email.waitFor();
  assert.equal(await email.inputValue(), "");
  await email.fill("user@example.com");
  await email.press("Enter");
  await dialog.getByLabel(copy.code, { exact: true }).fill("123456");
  await dialog.getByLabel(copy.code, { exact: true }).press("Enter");
  await dialog.waitFor({ state: "hidden" });
  await account.getByText(copy.plans.free, { exact: true }).waitFor();
  const devices = section(page, "butler-account-devices");
  await devices.getByText("Other", { exact: true }).waitFor();
  assert.equal(await devices.getByText("Butler", { exact: true }).count(), 1);
  assert.equal(await devices.getByText(copy.thisDevice, { exact: true }).count(), 1);
  assert.equal(await devices.locator('[data-slot="form-section-card"] > *').count(), 2);
  await verifyLayouts(page);
  await screenshot(page, "signed-in");
  fake.state.plan = "plus";
  await page.reload();
  await openAccount(page);
  await account.getByText(copy.plans.plus, { exact: true }).waitFor();
  await devices.getByRole("button", { name: copy.revokeDevice("Other"), exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: copy.revoke, exact: true }).click();
  await devices.getByText("Other", { exact: true }).waitFor({ state: "hidden" });
  assert.equal(await devices.locator('[data-slot="form-section-card"] > *').count(), 1);
  await account.getByRole("button", { name: copy.signOut, exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: copy.signOut, exact: true }).click();
  await signIn.waitFor();
  await verifyLayouts(page);
}

async function run(enabled: boolean, fake: Awaited<ReturnType<typeof startFakeCloud>>) {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-account-smoke-"));
  let server: Awaited<ReturnType<typeof createNativeAppServer>> | undefined;
  let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
  let secret = "";
  try {
    mkdirSync(join(butlerData, "gateways"));
    writeFileSync(join(butlerData, "gateways/app.json"), JSON.stringify({ config: { butlerAccountEnabled: enabled } }));
    server = await createNativeAppServer({ butlerData, uiRoot: resolve("packages/butler-app/client/ui/dist"),
      config: { user: { name: "Smoke", language } }, env: { BUTLER_CLOUD_API_URL: fake.url } });
    secret = JSON.parse(readFileSync(join(server.butlerData, "app/runtime/auth/local-admin.json"), "utf8")).secret;
    const adminHeaders = { ...server.authHeaders, "x-butler-admin": secret };
    browser = await launchSmokeBrowser();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route(`${server.url}**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      const headers = path.startsWith("/setup/butler-account") || path.startsWith("/security") || path === "/settings" ? adminHeaders : server!.authHeaders;
      await route.continue({ headers: { ...route.request().headers(), ...headers } });
    });
    const status = page.waitForResponse((response) => new URL(response.url()).pathname === "/setup/butler-account");
    await page.goto(server.url);
    await page.getByRole("button", { name: appCopy.sidebar.settings, exact: true }).click();
    assert.equal((await status).status(), enabled ? 200 : 404);
    const navigation = page.locator('[data-test-class="settings-sidebar"]');
    if (enabled) await screenshot(page, "nav");
    else {
      assert.equal(await navigation.getByRole("button", { name: appCopy.settings.sections.account, exact: true }).count(), 0);
      await page.setViewportSize({ width: 390, height: 900 });
      await navigation.waitFor();
      assert.equal(await navigation.getByRole("button", { name: appCopy.settings.sections.account, exact: true }).count(), 0);
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await navigation.getByRole("button", { name: appCopy.settings.sections.security, exact: true }).click();
    await page.getByRole("heading", { name: appCopy.settings.sections.security, exact: true }).waitFor();
    assert.equal(await section(page, "butler-account").count(), 0);
    if (enabled) {
      await navigation.getByRole("button", { name: appCopy.settings.sections.account, exact: true }).click();
      await signedInFlow(page, fake);
    } else await verifyLayouts(page);
  } catch (error) {
    let message = String(error);
    for (const value of [secret, server?.token, "bct_fake"]) if (value) message = message.replaceAll(value, "[redacted]");
    throw new Error(message, { cause: error });
  } finally {
    await browser?.close();
    await server?.stop();
    rmSync(butlerData, { recursive: true, force: true });
  }
}

const fake = await startFakeCloud();
try {
  await run(false, fake);
  await run(true, fake);
  console.log(JSON.stringify({ ok: true, checks: ["hidden", "sign-in", "invalid-code", "plan-refresh", "revoke", "sign-out", "responsive"], widths }));
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
} finally {
  await fake.stop();
}
