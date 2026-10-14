// Real Security UI and isolated gateway; no model calls.
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { appCopy, setAppCopyLanguage } from "../../packages/butler-app/client/ui/src/app/copy.ts";

const before = process.env.REMOTE_HTTPS_BEFORE === "1";
const output = process.env.REMOTE_HTTPS_SCREENSHOTS;
if (output) mkdirSync(output, { recursive: true });
setAppCopyLanguage("ko");
const browser = await launchSmokeBrowser();
let captures = 0;
try {
  for (const onboardingComplete of [false, true]) {
    const server = await createNativeAppServer({
      uiRoot: resolve(process.env.REMOTE_HTTPS_UI_ROOT ?? "packages/butler-app/client/ui/dist"),
      onboardingComplete,
      config: { user: { name: "Smoke", language: "ko" } },
    });
    const { secret } = JSON.parse(readFileSync(join(server.butlerData, "app/runtime/auth/local-admin.json"), "utf8"));
    const headers = { ...server.authHeaders, "x-butler-admin": secret };
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.route(`${server.url}**`, async (route) => {
        await route.continue({ headers: { ...route.request().headers(), ...headers } });
      });
      await server.api("/settings", { method: "PATCH", headers, body: JSON.stringify({
        security: { allowed_hosts: ["butler.example.com"], remote_access_enabled: false },
      }) });
      const destination = new URL(server.url);
      destination.searchParams.set("settings", "security");
      await page.goto(onboardingComplete ? destination.href : server.url);
      const remoteSection = page.locator('[data-settings-section-id="remote-access"]');
      const section = onboardingComplete ? remoteSection : page.locator("body");
      await section.waitFor();
      const address = section.getByText("https://butler.example.com", { exact: true });
      if (!onboardingComplete) assert.equal(await remoteSection.count(), 0, "pending onboarding hides Settings");
      else if (before) assert.equal(await address.count(), 0);
      else await address.waitFor();
      for (const theme of ["light", "dark"]) for (const wallpaper of [false, true]) for (const width of [375, 1280]) {
        await server.api("/settings", { method: "PATCH", headers, body: JSON.stringify({
          appearance_theme: theme,
          wallpaper: { source: wallpaper ? { kind: "live", module: "butler.bloom", params: { colors: "monochrome" } } : { kind: "none" } },
        }) });
        await page.setViewportSize({ width, height: 900 });
        await section.scrollIntoViewIfNeeded();
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
        });
        assert.equal(await section.evaluate((node) => node.scrollWidth > node.clientWidth + 1), false);
        if (output) await page.screenshot({ path: join(output, `${onboardingComplete}-${theme}-${wallpaper}-${width}.png`) });
        captures++;
      }
      if (onboardingComplete) {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.getByRole("switch", { name: appCopy.settings.security.remoteAccess, exact: true }).click();
        await address.waitFor();
        const view = await server.api<{ lan_urls: string[] }>("/security", { headers });
        assert(view.lan_urls.includes("https://butler.example.com"));
        for (const url of view.lan_urls) await section.getByText(url, { exact: true }).waitFor();
      }
      assert.equal(server.stubModelCalls.length, 0);
    } catch (error) {
      const message = String(error).replaceAll(secret, "[redacted]").replaceAll(server.token, "[redacted]");
      console.error(message);
      process.exitCode = 1;
    } finally {
      await page.close();
      await server.stop();
    }
  }
  if (!process.exitCode) console.log(JSON.stringify({ ok: true, before, captures, modelCalls: 0 }));
} finally {
  await browser.close();
}
