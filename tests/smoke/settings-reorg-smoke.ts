import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appCopy, setAppCopyLanguage } from "../../packages/butler-app/client/ui/src/app/copy.ts";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";

const language = process.env.SETTINGS_REORG_SMOKE_LANGUAGE ?? "ko";
setAppCopyLanguage(language);
const copy = appCopy.settings;
const butlerData = mkdtempSync(join(tmpdir(), "settings-reorg-smoke-"));
let server: Awaited<ReturnType<typeof createNativeAppServer>> | undefined;
let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
let secret = "";

try {
  mkdirSync(join(butlerData, "gateways"));
  writeFileSync(join(butlerData, "gateways/app.json"), JSON.stringify({ config: { butlerAccountEnabled: true } }));
  const appServer = await createNativeAppServer({
    butlerData,
    uiRoot: resolve("packages/butler-app/client/ui/dist"),
    config: { user: { name: "Smoke", language } },
    env: { BUTLER_CLOUD_API_URL: "http://127.0.0.1:9" },
  });
  server = appServer;
  secret = JSON.parse(readFileSync(join(butlerData, "app/runtime/auth/local-admin.json"), "utf8")).secret;
  const adminHeaders = { ...appServer.authHeaders, "x-butler-admin": secret };
  browser = await launchSmokeBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route(`${appServer.url}**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const headers = path.startsWith("/security") || path === "/settings" ? adminHeaders : appServer.authHeaders;
    await route.continue({ headers: { ...route.request().headers(), ...headers } });
  });
  await appServer.api("/settings", {
    method: "PATCH", headers: adminHeaders,
    body: JSON.stringify({ security: { remote_access_enabled: true } }),
  });
  await page.goto(appServer.url);
  await page.getByRole("button", { name: appCopy.sidebar.settings, exact: true }).click();
  const navigation = page.locator('[data-test-class="settings-navigation-scroll"]').getByRole("navigation");
  await navigation.getByRole("button", { name: copy.sections.devices, exact: true }).click();
  const remote = page.locator('[data-settings-section-id="remote-access"]');
  await remote.waitFor();
  await remote.getByRole("switch", { name: copy.security.remoteAccess, exact: true }).waitFor();
  await remote.getByText(copy.security.tunnel).first().waitFor();

  await navigation.getByRole("button", { name: copy.sections.security, exact: true }).click();
  await page.locator('[data-settings-section-id="butler-vault"]').waitFor();
  await page.locator('[data-settings-section-id="grants"]').waitFor();
  assert.equal(await remote.count(), 0);

  const models = navigation.getByRole("button", { name: copy.sections.models, exact: true });
  await models.click();
  const savedKeys = page.locator('[data-settings-section-id="saved-keys"]');
  await savedKeys.getByRole("heading", { name: copy.pageSections.savedKeys, exact: true }).waitFor();

  await page.getByRole("searchbox", { name: copy.searchLabel, exact: true }).fill(copy.pageSections.savedKeys);
  assert.equal(await navigation.getByRole("button").count(), 1);
  await models.click();
  assert.equal(await page.locator('[data-test-class~="settings-detail-title"]').textContent(), copy.sections.models);
  await savedKeys.waitFor();

  console.log(JSON.stringify({ ok: true, checks: ["devices", "security", "model-keys", "settings-search"] }));
} catch (error) {
  let message = String(error);
  for (const value of [secret, server?.token]) if (value) message = message.replaceAll(value, "[redacted]");
  console.error(message);
  process.exitCode = 1;
} finally {
  try {
    await browser?.close();
  } finally {
    await server?.stop();
    rmSync(butlerData, { recursive: true, force: true });
  }
}
