import { launchSmokeBrowser } from "../support/smoke-browser.ts";
// Real UI -> isolated native gateway -> paired browser. Providers are stubbed.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { appCopy, setAppCopyLanguage } from "../../packages/butler-app/client/ui/src/app/copy.ts";

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
    body: new URLSearchParams({ code, name: "Remote device · browser", match_code: "47" }),
  });
}

async function answerPairing(pick: string | null) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await admin<{ id: string; status: string } | null>("/security/pairing");
    if (status?.status === "pending") {
      await admin("/security/pairing/decision", { method: "POST", body: JSON.stringify({ id: status.id, pick }) });
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error("no pending pairing request");
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
  await page.route(`${server.url}**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const headers = path.startsWith("/security") || path === "/settings" ? adminHeaders : server.authHeaders;
    await route.continue({ headers: { ...route.request().headers(), ...headers } });
  });
  await admin("/settings", { method: "PATCH", body: JSON.stringify({ security: { allowed_hosts: ["phone-test.local"] } }) });
  await page.goto(server.url);
  await page.getByRole("button", { name: appCopy.sidebar.settings, exact: true }).click();
  await page.getByRole("button", { name: appCopy.settings.sections.devices, exact: true }).click();
  assert.equal(await section(page, "device-pairing").count(), 0, "pairing hidden while remote access is off");
  await page.getByRole("switch", { name: copy.remoteAccess, exact: true }).click();
  await page.getByRole("button", { name: copy.createCode, exact: true }).click();
  let code = await codeFromUi(page);
  await verifyLayouts(page);
  const countdown = page.getByText(copy.expiresIn(60), { exact: true });
  await countdown.waitFor({ state: "hidden" });
  await admin("/security/pairing/clock?seconds=61", { method: "POST" });
  code = await waitForNewCode(page, code);
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await connect("wrong-code")).status, 401);
  code = await waitForNewCode(page, code);
  await page.getByText(copy.invalidated, { exact: true }).waitFor();
  const pairing = section(page, "device-pairing");
  const browserRequest = connect(code);
  await pairing.locator('[data-test-class="pairing-choice"]').getByText("47", { exact: true }).waitFor();
  await pairing.getByText("Remote device · browser", { exact: true }).waitFor();
  await verifyLayouts(page);
  await pairing.locator('[data-test-class="pairing-choice"]').getByText("47", { exact: true }).click();
  const response = await browserRequest;
  assert.equal(response.status, 303, "UI code pairs a browser");
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  await page.getByText(copy.paired, { exact: true }).waitFor();
  await page.getByText("Remote device · browser", { exact: true }).waitFor();
  assert.equal(await page.locator('[data-test-class="pairing-code"]').count(), 0, "paired code is removed");
  await page.getByText("127.0.0.1", { exact: true }).waitFor();
  await verifyLayouts(page);
  await page.getByRole("button", { name: copy.revokeDevice("Remote device · browser"), exact: true }).click();
  await page.getByText(copy.noDevices, { exact: true }).waitFor();
  assert.equal((await fetch(new URL("settings", server.url), { headers: { cookie } })).status, 401);
  const external = await admin<{ code: string }>("/security/pairing", { method: "POST" });
  const [externalResponse] = await Promise.all([connect(external.code), answerPairing("47")]);
  assert.equal(externalResponse.status, 303);
  await page.getByText("Remote device · browser", { exact: true }).waitFor();
  await page.getByRole("button", { name: copy.revokeAll, exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: appCopy.common.cancel, exact: true }).click();
  assert.equal((await admin<unknown[]>("/security/devices")).length, 1, "cancel preserves devices");
  await page.getByRole("button", { name: copy.revokeAll, exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: copy.revokeAll, exact: true }).click();
  await page.getByText(copy.noDevices, { exact: true }).waitFor();
  assert.equal((await admin<unknown[]>("/security/devices")).length, 0);
  await page.getByRole("button", { name: copy.createCode, exact: true }).click();
  const qr = page.getByRole("img", { name: copy.pairingQr, exact: true });
  await qr.waitFor();
  const link = new URL((await page.locator('[data-test-class="pairing-qr"]').getAttribute("data-pairing-link"))!);
  assert.equal(link.protocol, "butler:");
  assert.equal(link.searchParams.get("v"), "1");
  assert.equal(link.searchParams.get("c"), await codeFromUi(page));
  assert.deepEqual(link.searchParams.getAll("a"), (await admin<{ lan_urls: string[] }>("/security")).lan_urls.slice(0, 4));
  const declinedRequest = fetch(new URL("devices/pair", server.url), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: link.searchParams.get("c"), device_name: "Smoke phone", platform: "ios", match_code: "47" }),
  });
  await pairing.locator('[data-test-class="pairing-choice"]').getByText("47", { exact: true }).waitFor();
  await pairing.getByText("Smoke phone", { exact: true }).waitFor();
  await pairing.getByRole("button", { name: copy.decline, exact: true }).click();
  const declined = await declinedRequest;
  assert.equal(declined.status, 403);
  assert.equal((await declined.json()).error.code, "pairing_rejected");
  await page.getByText(copy.rejected, { exact: true }).waitFor();
  await qr.waitFor();
  const newLink = new URL((await page.locator('[data-test-class="pairing-qr"]').getAttribute("data-pairing-link"))!);
  const phoneRequest = fetch(new URL("devices/pair", server.url), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: newLink.searchParams.get("c"), device_name: "Smoke phone", platform: "ios", match_code: "47" }),
  });
  await pairing.locator('[data-test-class="pairing-choice"]').getByText("47", { exact: true }).click();
  const phone = await phoneRequest;
  assert.equal(phone.status, 201);
  assert.ok((await phone.json()).data.device_token);
  await page.getByText(copy.paired, { exact: true }).waitFor();
  await page.getByText("Smoke phone", { exact: true }).waitFor();
  assert.deepEqual((await admin<{ name: string; kind: string }[]>("/security/devices")).map(({ name, kind }) => ({ name, kind })), [{ name: "Smoke phone", kind: "ios" }]);
  assert.equal(server.stubModelCalls.length, 0, "pairing needs no model calls");
  console.log(JSON.stringify({ ok: true, checks: ["expiry", "invalidation", "pair", "pick", "decline", "stop", "event-refresh", "revoke", "confirm-all", "responsive", "qr"], widths: [320, 375, 390, 430, 768, 1440] }));
} catch (error) {
  const message = String(error).replaceAll(secret, "[redacted]").replaceAll(server.token, "[redacted]");
  console.error(message);
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.stop();
}
