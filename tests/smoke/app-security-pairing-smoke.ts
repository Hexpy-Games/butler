import { launchSmokeBrowser } from "../support/smoke-browser.ts";
// Real UI -> isolated native gateway -> paired browser. Providers are stubbed.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { appCopy, setAppCopyLanguage } from "../../packages/butler-app/client/ui/src/app/copy.ts";
type PairingStatus = { id: string };

const language = process.env.PAIRING_SMOKE_LANGUAGE ?? "en";
setAppCopyLanguage(language);
const server = await createNativeAppServer({ uiRoot: resolve("packages/butler-app/client/ui/dist"), config: { user: { name: "Smoke", language } } });
const { secret } = JSON.parse(readFileSync(join(server.butlerData, "app/runtime/auth/local-admin.json"), "utf8"));
const adminHeaders = { ...server.authHeaders, "x-butler-admin": secret };
const admin = <T>(path: string, init: RequestInit = {}) => server.api<T>(path, {
  ...init, headers: adminHeaders,
});
const browser = await launchSmokeBrowser();
const copy = appCopy.settings.security;
const section = (page: Page, id: string) => page.locator(`[data-settings-section-id="${id}"]`);

async function codeFromUi(page: Page): Promise<string> {
  const code = page.locator('[data-test-class="pairing-code"]');
  await code.waitFor();
  const digits = (await code.textContent())?.replace(/\s/gu, "") ?? "";
  assert.match(digits, /^\d{8}$/u, "UI shows eight grouped digits");
  return digits;
}

async function waitForNewCode(page: Page, previous: string): Promise<string> {
  await page.waitForFunction((old) => {
    const text = document.querySelector('[data-test-class="pairing-code"]')?.textContent;
    return text && text.replace(/\s/gu, "") !== old;
  }, previous);
  return codeFromUi(page);
}

async function connect(code: string) {
  return fetch(new URL("connect", server.url), {
    method: "POST", redirect: "manual",
    headers: { origin: new URL(server.url).origin, "sec-fetch-site": "same-origin" },
    body: new URLSearchParams({ code, name: "Remote device · browser" }),
  });
}

async function verifyLayouts(page: Page) {
  for (const width of [320, 375, 390, 430, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const id of ["device-pairing", "paired-devices"]) {
      const overflow = await section(page, id).evaluate((node) => node.scrollWidth > node.clientWidth + 1);
      assert.equal(overflow, false, `${id} fits ${width}px`);
    }
  }
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // Test-side admin forwarding models the desktop main process; credentials
  // stay out of the renderer. All requests still reach the real stub gateway.
  let pairingReads = 0;
  await page.route(`${server.url}**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/security/pairing" && route.request().method() === "GET") pairingReads++;
    const headers = path.startsWith("/security") || path === "/settings" ? adminHeaders : server.authHeaders;
    await route.continue({ headers: { ...route.request().headers(), ...headers } });
  });
  await page.goto(server.url);
  await page.getByRole("button", { name: appCopy.sidebar.settings, exact: true }).click();
  await page.getByRole("button", { name: appCopy.settings.sections.security, exact: true }).click();
  assert.equal(await section(page, "device-pairing").count(), 0, "pairing hidden while remote access is off");
  await page.getByRole("switch", { name: copy.remoteAccess, exact: true }).click();
  await page.getByRole("button", { name: copy.pairDevice, exact: true }).click();
  let code = await codeFromUi(page);
  await verifyLayouts(page);
  const countdown = page.getByText(copy.expiresIn(60), { exact: true });
  await countdown.waitFor({ state: "hidden" });
  await admin("/security/pairing/clock?seconds=61", { method: "POST" });
  code = await waitForNewCode(page, code);
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await connect("wrong-code")).status, 401);
  code = await waitForNewCode(page, code);
  await page.getByText(copy.invalidated, { exact: true }).waitFor();
  const response = await connect(code);
  assert.equal(response.status, 303, "UI code pairs a browser");
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  await page.getByText(copy.paired, { exact: true }).waitFor();
  await page.getByText("Remote device · browser", { exact: true }).waitFor();
  assert.equal(await page.locator('[data-test-class="pairing-code"]').count(), 0, "paired code is removed");
  const readsAfterPairing = pairingReads;
  const status = await admin<PairingStatus>("/security/pairing");
  await page.waitForTimeout(1500);
  assert.equal((await admin<PairingStatus>("/security/pairing")).id, status.id, "paired flow stops issuing codes");
  assert.equal(pairingReads, readsAfterPairing, "paired flow stops polling");
  await page.getByText("127.0.0.1", { exact: true }).waitFor();
  await verifyLayouts(page);
  await page.getByRole("button", { name: copy.revokeDevice("Remote device · browser"), exact: true }).click();
  await page.getByText(copy.noDevices, { exact: true }).waitFor();
  assert.equal((await fetch(new URL("settings", server.url), { headers: { cookie } })).status, 401);
  const external = await admin<{ code: string }>("/security/pairing", { method: "POST" });
  assert.equal((await connect(external.code)).status, 303);
  await page.getByText("Remote device · browser", { exact: true }).waitFor();
  await page.getByRole("button", { name: copy.revokeAll, exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: appCopy.common.cancel, exact: true }).click();
  assert.equal((await admin<unknown[]>("/security/devices")).length, 1, "cancel preserves devices");
  await page.getByRole("button", { name: copy.revokeAll, exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: copy.revokeAll, exact: true }).click();
  await page.getByText(copy.noDevices, { exact: true }).waitFor();
  assert.equal((await admin<unknown[]>("/security/devices")).length, 0);
  assert.equal(server.stubModelCalls.length, 0, "pairing needs no model calls");
  console.log(JSON.stringify({ ok: true, checks: ["expiry", "invalidation", "pair", "stop", "event-refresh", "revoke", "confirm-all", "responsive"], widths: [320, 375, 390, 430, 768, 1440] }));
} catch (error) {
  const message = String(error).replaceAll(secret, "[redacted]").replaceAll(server.token, "[redacted]");
  console.error(message);
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.stop();
}
