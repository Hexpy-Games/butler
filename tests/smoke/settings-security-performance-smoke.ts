// Loaded settings interactions against a real isolated gateway at owner scale.
import { strict as assert } from "node:assert";
import { join, resolve } from "node:path";
import { readFileSync, statSync } from "node:fs";
import type { Locator } from "playwright";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { seedApprovalFixture } from "../support/authority-grant-fixture.ts";
import { appCopy, setAppCopyLanguage } from "../../packages/butler-app/client/ui/src/app/copy.ts";

async function measure(locator: Locator, ready: string) {
  const pending = locator.evaluate(async (node, selector) => {
    const longTasks: number[] = [];
    const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => entry.duration)));
    observer.observe({ type: "longtask" });
    let start = 0;
    const contentReady = await new Promise<boolean>(done => {
      node.addEventListener("click", () => {
      start = performance.now();
      const timeout = setTimeout(() => { mutations.disconnect(); done(false); }, 150);
      const check = () => {
        const content = document.querySelector(selector) as HTMLElement | null;
        if (content && content.offsetWidth && content.offsetHeight) {
          clearTimeout(timeout); mutations.disconnect(); done(true);
        }
      };
      const mutations = new MutationObserver(check);
      mutations.observe(document.body, { childList: true, attributes: true, subtree: true });
      check();
      }, { once: true, capture: true });
      (node as HTMLElement).dataset.securityPerfArmed = "true";
    });
    const elapsedMs = performance.now() - start;
    delete (node as HTMLElement).dataset.securityPerfArmed;
    // Deliver long-task records after the interaction task ends; no extra frame wait in latency.
    await new Promise<void>(done => setTimeout(done, 0));
    longTasks.push(...observer.takeRecords().map(entry => entry.duration));
    observer.disconnect();
    return { elapsedMs, longestTaskMs: Math.max(0, ...longTasks), ready: contentReady };
  }, ready);
  await locator.locator("xpath=self::*[@data-security-perf-armed]").waitFor();
  await locator.click();
  return pending;
}

setAppCopyLanguage("ko");
const server = await createNativeAppServer({ uiRoot: resolve("packages/butler-app/client/ui/dist") });
const browser = await launchSmokeBrowser();
try {
  await seedApprovalFixture(server); // 603 conversations, 13 grants -> 12 complete rows.
  const { secret } = JSON.parse(readFileSync(join(server.butlerData, "app/runtime/auth/local-admin.json"), "utf8"));
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await server.signIn(page);
  for (const path of ["settings", "security**"]) await page.route(`${server.url}${path}`, route => route.continue({ headers: { ...route.request().headers(), ...server.authHeaders, "x-butler-admin": secret } }));
  await page.goto(`${server.url}?settings=general`, { waitUntil: "domcontentloaded" });
  await page.getByRole("switch", { name: appCopy.settings.fields.planModeDefault, exact: true }).waitFor();
  const results = [];
  for (const [section, ready] of [["models", '[data-setting-id="primary-model"]'], ["security", '[data-test-class="grant-row"]'], ["general", '[data-setting-id="plan-mode-default"]']] as const) {
    const result = await measure(page.getByRole("button", { name: appCopy.settings.sections[section], exact: true }), ready);
    results.push({ interaction: section, ...result });
    await page.locator(ready).first().waitFor();
    if (section === "security") assert.equal(await page.locator('[data-test-class="grant-row"]').count(), 12);
  }
  const toggle = page.getByRole("switch", { name: appCopy.settings.fields.planModeDefault, exact: true });
  const previous = await toggle.getAttribute("aria-checked");
  const changed = `[data-setting-id="plan-mode-default"] [role="switch"][aria-checked="${previous === "true" ? "false" : "true"}"]`;
  const toggled = await measure(toggle, changed);
  await page.locator(changed).waitFor();
  results.push({ interaction: "plan-mode-default", ...toggled });
  assert.notEqual(await toggle.getAttribute("aria-checked"), previous);

  await page.getByText(appCopy.settings.saved, { exact: true }).waitFor();
  const stored = await server.api<{ plan_mode_default: boolean }>("/settings");
  assert.equal(stored.plan_mode_default, previous !== "true");
  await page.getByText(appCopy.settings.saved, { exact: true }).waitFor({ state: "hidden" });
  const paths = ["agent-runtime/btcc.sqlite", "agent-runtime/btcc.sqlite-wal", "app-server/butler-client.sqlite", "app-server/butler-client.sqlite-wal", "butler.config.json"];
  const snapshot = () => paths.map(path => { try { const value = statSync(join(server.butlerData, path)); return [value.size, value.mtimeMs]; } catch { return null; } });
  const idleBefore = snapshot();
  await page.waitForTimeout(1_000);
  assert.deepEqual(snapshot(), idleBefore, "loaded settings idle storage remains unchanged");
  assert.equal(server.stubModelCalls.length, 0);
  console.log(JSON.stringify({ conversations: 603, modelCalls: 0, idleObservationMs: 1000, changedStorageFiles: 0, results }));
  for (const result of results) {
    assert(result.ready, `${result.interaction} content ready`);
    assert(result.elapsedMs <= 150, `${result.interaction}: ${result.elapsedMs}ms`);
    assert(result.longestTaskMs <= 50, `${result.interaction} long task ${result.longestTaskMs}ms`);
  }
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.goto("about:blank", { waitUntil: "commit" });
  await page.close();
} finally { await browser.close(); await server.stop(); }
