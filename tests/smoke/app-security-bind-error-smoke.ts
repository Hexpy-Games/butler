// test-category: security
// Real Settings UI -> isolated stub gateway with an occupied LAN socket.
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { getAppCopy } from "../../packages/butler-app/client/ui/src/app/copy";
import { createNativeAppServer } from "../support/native-app-server";
import { launchSmokeBrowser } from "../support/smoke-browser";

const shots = process.env.BUTLER_SECURITY_BIND_SHOTS;
const beforeUi = process.env.BUTLER_SECURITY_BIND_BEFORE_UI;
const saved: string[] = [];

function lanIpv4(): string | undefined {
  return Object.values(networkInterfaces()).flat().find((address) => {
    if (!address || address.internal || address.family !== "IPv4") return false;
    const [a, b] = address.address.split(".").map(Number);
    return a === 10 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && b === 168 || a === 169 && b === 254;
  })?.address;
}

async function capture(page: Page) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    // The appearance is persisted through the same public settings endpoint.
    await page.evaluate(async (appearance_theme) => {
      await fetch("/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ appearance_theme }) });
    }, theme);
    await page.goto(new URL("?settings=security", page.url()).href);
    await page.locator('[data-setting-id="lan-urls"]').waitFor();
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 900 });
      const field = page.locator('[data-setting-id="lan-urls"]');
      await field.scrollIntoViewIfNeeded();
      assert.equal(await field.evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
      const path = join(shots, `${beforeUi ? "before" : "after"}-${theme}-${width}.png`);
      await page.screenshot({ path, animations: "disabled" });
      saved.push(path);
    }
  }
}

async function verify(language: "ko" | "en", ip: string) {
  const server = await createNativeAppServer({ uiRoot: resolve(beforeUi ?? "packages/butler-app/client/ui/dist"), config: { user: { name: "Smoke", language } } });
  const occupied = createServer();
  let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
  const { secret } = JSON.parse(readFileSync(join(server.butlerData, "app/runtime/auth/local-admin.json"), "utf8"));
  try {
    await new Promise<void>((done, fail) => { occupied.once("error", fail); occupied.listen(server.port, ip, done); });
    browser = await launchSmokeBrowser();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const headers = { ...server.authHeaders, "x-butler-admin": secret };
    await page.route(`${server.url}**`, route => {
      const path = new URL(route.request().url()).pathname;
      return route.continue({ headers: { ...route.request().headers(), ...(path.startsWith("/security") || path === "/settings" ? headers : server.authHeaders) } });
    });
    await page.goto(server.url);
    const copy = getAppCopy(language === "ko" ? "ko-KR" : "en-US");
    await page.getByRole("button", { name: copy.sidebar.settings, exact: true }).click();
    await page.getByRole("button", { name: copy.settings.sections.security, exact: true }).click();
    const toggle = page.getByRole("switch", { name: copy.settings.security.remoteAccess, exact: true });
    await toggle.click();
    const field = page.locator('[data-setting-id="lan-urls"]');
    await field.waitFor();
    const view = await server.api<{ bind_errors: { address: string; code?: string }[] }>("/security", { headers });
    assert(view.bind_errors.some(error => error.address === `${ip}:${server.port}`));
    if (beforeUi) assert.equal(await field.getByRole("alert").count(), 0);
    else {
      assert.equal(view.bind_errors.find(error => error.address === `${ip}:${server.port}`)?.code, "address_in_use");
      await field.getByRole("alert").getByText(copy.settings.security.bindErrors.address_in_use, { exact: true }).waitFor();
      assert.equal(await field.getByText(copy.settings.security.noAddresses, { exact: true }).count(), 0);
    }
    assert.equal(await toggle.isChecked(), true);
    if (language === "ko") await capture(page);
    await new Promise<void>((done, fail) => occupied.close(error => error ? fail(error) : done()));
    await toggle.click();
    await field.waitFor({ state: "hidden" });
    await toggle.click();
    await field.getByText(`http://${ip}:${server.port}`, { exact: true }).waitFor();
    assert.equal(await field.getByRole("alert").count(), 0, "retry clears bind error");
    assert.equal(server.stubModelCalls.length, 0);
  } catch (error) {
    console.error(String(error).replaceAll(secret, "[redacted]").replaceAll(server.token, "[redacted]"));
    process.exitCode = 1;
    return false;
  } finally {
    if (occupied.listening) await new Promise<void>(done => occupied.close(() => done()));
    try { await browser?.close(); } finally { await server.stop(); }
  }
  return true;
}

const ip = lanIpv4();
if (!ip) console.log(JSON.stringify({ skipped: "No LAN IPv4 address" }));
else {
  for (const language of ["ko", "en"] as const) if (!await verify(language, ip)) break;
  if (!process.exitCode) console.log(JSON.stringify({ ok: true, languages: ["ko", "en"], checks: ["occupied-address", "enabled-switch", "retry-recovery"], screenshots: saved }));
}
