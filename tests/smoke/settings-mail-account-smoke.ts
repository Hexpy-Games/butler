import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { cropRegion } from "../support/canon-registration-crops.ts";
import { appCopy, setAppCopyLanguage } from "../../packages/butler-app/client/ui/src/app/copy.ts";

setAppCopyLanguage("ko");
const scratch = mkdtempSync(join(tmpdir(), "mail-account-smoke-"));
// The connector keeps its password in the system store: a throwaway keychain on macOS
// (as signin-handoff-smoke.ts), the test-support file store elsewhere.
const agentHome = join(scratch, "home");
mkdirSync(join(agentHome, "Library/Keychains"), { recursive: true }); mkdirSync(join(agentHome, "Library/Preferences"));
if (process.platform === "darwin") {
  const keychain = join(agentHome, "Library/Keychains/butler-test.keychain-db");
  for (const args of [["create-keychain", "-p", "butler-test"], ["default-keychain", "-d", "user", "-s"], ["unlock-keychain", "-p", "butler-test"]]) {
    assert.equal(spawnSync("/usr/bin/security", [...args, keychain], { env: { ...process.env, HOME: agentHome } }).status, 0, `test keychain ${args[0]}`);
  }
}
const server = await createNativeAppServer({
  uiRoot: resolve("packages/butler-app/client/ui/dist"),
  env: process.platform === "darwin" ? { HOME: agentHome } : { BUTLER_TEST_SECRET_STORE: join(scratch, "secrets.json") },
});
const { secret } = JSON.parse(readFileSync(join(server.butlerData, "app/runtime/auth/local-admin.json"), "utf8"));
const adminHeaders = { ...server.authHeaders, "x-butler-admin": secret };
const browser = await launchSmokeBrowser();
const canary = "mail-password-canary-7f3a";
const copy = appCopy.settings.connections;
const responses: Array<Promise<string>> = [];
const section = (page: Page, id: string) => page.locator(`[data-settings-section-id="${id}"]`);

async function verifyLayouts(page: Page) {
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    for (const id of ["mail", "connector-rules"]) {
      const overflow = await section(page, id).evaluate(node => node.scrollWidth > node.clientWidth + 1);
      assert.equal(overflow, false, `${id} fits ${width}px`);
    }
  }
}

async function capture(page: Page, state: string) {
  if (!process.env.BUTLER_SMOKE_SCREENSHOTS) return;
  mkdirSync(process.env.BUTLER_SMOKE_SCREENSHOTS, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: scheme }) });
    await page.waitForFunction(theme => document.querySelector(`.theme-${theme}`) !== null, scheme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      await cropRegion(page, page.locator('[data-slot="settings-page"]'), `connections-${state}-${scheme}-${width}`);
    }
  }
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2, colorScheme: "light" });
  await server.signIn(context);
  const page = await context.newPage();
  page.on("response", response => responses.push(response.text().catch(() => "")));
  await page.route(`${server.url}**`, async route => {
    const path = new URL(route.request().url()).pathname;
    const headers = ["/plugins", "/connectors", "/connector-rules"].some(prefix => path.startsWith(prefix)) ? adminHeaders : server.authHeaders;
    await route.continue({ headers: { ...route.request().headers(), ...headers } });
  });
  await page.goto(server.url);
  await page.getByRole("button", { name: appCopy.sidebar.settings, exact: true }).click();
  await page.getByRole("button", { name: appCopy.settings.sections.connections, exact: true }).click();
  await section(page, "mail").getByText(copy.empty, { exact: true }).waitFor();
  await section(page, "connector-rules").getByText(copy.noRules, { exact: true }).waitFor();
  await verifyLayouts(page);
  await capture(page, "empty");
  await page.getByRole("button", { name: copy.add, exact: true }).click();
  await page.getByRole("textbox", { name: copy.address, exact: true }).fill("smoke@example.test");
  await page.getByLabel(copy.password, { exact: true }).fill(canary);
  await page.getByRole("textbox", { name: copy.incoming, exact: true }).fill("127.0.0.1");
  await page.getByRole("textbox", { name: copy.outgoing, exact: true }).fill("127.0.0.1");
  await verifyLayouts(page);
  await capture(page, "form");
  await section(page, "mail").getByRole("button", { name: copy.connect, exact: true }).click();
  await page.getByText(copy.connectedToast, { exact: true }).waitFor();
  await section(page, "mail").getByText("smoke@example.test", { exact: true }).waitFor();
  await section(page, "mail").getByText(`${copy.disconnected} · ${copy.checkAccount}`, { exact: true }).waitFor();
  await section(page, "mail").getByRole("button", { name: copy.retry, exact: true }).waitFor();
  assert(!(await page.locator("body").innerHTML()).includes(canary), "password cleared from markup");
  await verifyLayouts(page);
  await capture(page, "account");
  await section(page, "mail").getByRole("button", { name: copy.remove, exact: true }).click();
  await section(page, "mail").getByText("smoke@example.test", { exact: true }).waitFor({ state: "hidden" });
  await section(page, "mail").getByText(copy.empty, { exact: true }).waitFor();
  await context.close();
  for (const text of await Promise.all(responses)) assert(!text.includes(canary), "password absent from response bodies");
  console.log(JSON.stringify({ ok: true, checks: ["empty", "connect", "status-event", "secret-redaction", "layouts", "remove"], widths: [320, 390, 768, 1440] }));
} catch (error) {
  console.error(String(error).replaceAll(secret, "[redacted]").replaceAll(server.token, "[redacted]").replaceAll(canary, "[redacted]"));
  process.exitCode = 1;
} finally {
  await browser.close();
  // Uninstall through the Agent: the installed plugin store is read-only on disk.
  const plugins = await server.api<{ revision: number; plugins: Array<{ id: string }> }>("/plugins", { headers: adminHeaders }).catch(() => null);
  if (plugins?.plugins.some(plugin => plugin.id === "mail")) await server.api(`/plugins/mail?revision=${plugins.revision}`, { method: "DELETE", headers: adminHeaders });
  await server.stop();
  rmSync(scratch, { recursive: true, force: true });
}
