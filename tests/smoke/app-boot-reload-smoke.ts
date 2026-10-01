// Browser smoke: observe every mount from document creation, including reloads.
import { strict as assert } from "node:assert";
import { chromium } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";

const server = await createNativeAppServer();
const browser = await chromium.launch({ headless: true });
const completed = "2026-09-01T00:00:00Z";
try {
  for (const desktop of [false, true]) {
    const context = await browser.newContext();
    await server.signIn(context);
    await context.addInitScript(({ desktop }) => {
      const request = async (path: string, options: RequestInit = {}) => {
          const response = await fetch(path, { ...options, headers: { "content-type": "application/json" } });
          const body = await response.json();
          if (!response.ok) throw new Error("Gateway request failed");
          return body.data;
        };
      if (desktop) Object.assign(window, { butlerApp: {
        getSettings: () => request("/settings"),
        getModelCatalog: () => request("/model-catalog"),
        getSetupReadiness: () => request("/setup/readiness"),
        listNavigation: () => request("/navigation"),
        getAppInfo: () => request("/app-info"),
      } });
      const mounts = { setup: 0, welcome: 0, workspace: 0 };
      Object.assign(window, { __bootMounts: mounts });
      const inspect = (node: Node) => {
        if (!(node instanceof Element)) return;
        for (const [key, selector] of Object.entries({ setup: '[data-test-class="first-run-setup"]',
          welcome: '[data-first-run-screen="welcome"]', workspace: '[data-test-class="mac-window"]' })) {
          if (node.matches(selector) || node.querySelector(selector)) mounts[key as keyof typeof mounts]++;
        }
      };
      new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(inspect)))
        .observe(document, { childList: true, subtree: true });
    }, { desktop });
    const page = await context.newPage();
    // Hold settings so an optimistic setup/workspace mount cannot hide in a fast response.
    await page.route("**/settings", async route => {
      if (route.request().method() === "GET") await new Promise(done => setTimeout(done, 200));
      await route.continue();
    });
    const counts = () => page.evaluate(() => (window as unknown as { __bootMounts: { setup: number; welcome: number; workspace: number } }).__bootMounts);
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ onboarding: {
      consent_version: 2, accepted_at: completed, completed_at: completed,
    } }) });
    await page.goto(server.url);
    for (let reload = 0; reload < 10; reload++) {
      await page.reload();
      await page.locator('[data-test-class="mac-window"]').waitFor();
      assert.equal((await counts()).setup, 0, `setup never mounted: desktop=${desktop}, reload=${reload}`);
    }
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ onboarding: {
      consent_version: 1, accepted_at: completed, completed_at: completed,
    } }) });
    await page.reload();
    await page.locator('[data-first-run-screen="consent"]').waitFor();
    assert.equal((await counts()).welcome, 0, "renewal never mounts welcome");
    assert.equal((await counts()).workspace, 0, "renewal never mounts workspace");
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ onboarding: {
      consent_version: null, accepted_at: null, completed_at: null,
    } }) });
    await page.reload();
    await page.locator('[data-first-run-screen="welcome"]').waitFor();
    assert.equal((await counts()).workspace, 0, "fresh install never mounts workspace");
    await context.close();
  }
  console.log(JSON.stringify({ ok: true, reloads: 20, fresh: 2, renewal: 2, modelCalls: server.stubModelCalls.length,
    paths: ["browser/remote", "desktop bridge"] }));
} finally {
  await browser.close();
  await server.stop();
}
