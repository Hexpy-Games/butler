import { launchSmokeBrowser } from "../support/smoke-browser.ts";
// Browser smoke: memory preparation never gates setup; Settings owns a labeled status section.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { type Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { assertFirstRunContrast, assertFirstRunLayout } from "../support/first-run-visual.ts";
import { onboardingCompletedPatch } from "../../packages/butler-app/client/ui/src/app/onboarding.ts";
import { getAppCopy } from "../../packages/butler-app/client/ui/src/app/copy.ts";
import { firstRunCopy } from "../../packages/butler-app/client/ui/src/app/firstRunSetup.ts";

const output = resolve(".tmp/firstrun-ds");
mkdirSync(output, { recursive: true });
const browser = await launchSmokeBrowser();
const server = await createNativeAppServer({ onboardingComplete: false });
let textNodes = 0;
let minimumContrast = Infinity;
let cases = 0;
const fresh = { consent_version: null, accepted_at: null, completed_at: null };

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function audit(page: Page) {
  await assertFirstRunLayout(page);
  const result = await assertFirstRunContrast(page);
  textNodes += result.nodes;
  minimumContrast = Math.min(minimumContrast, result.minimum);
  const aligned = await page.locator('[data-test-class="memory-model-status"]').evaluate((node) => {
    const slot = node.querySelector('[data-slot="icon-slot"]')!;
    const text = slot.nextElementSibling!.querySelector("span")!;
    return Math.abs(slot.getBoundingClientRect().top - text.getBoundingClientRect().top) < 1;
  });
  assert(aligned, "memory icon aligns to first caption line");
}

async function runCase(language: "ko" | "en", theme: "light" | "dark", width: number) {
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language, appearance_theme: theme, onboarding: fresh }) });
  const context = await browser.newContext({ locale: language, colorScheme: theme, viewport: { width, height: 900 } });
  await server.signIn(context);
  const page = await context.newPage();
  let state = "downloading";
  let retried = false;
  const model = () => ({ state, bytes_done: state === "failed" ? 0 : 312_000_000, bytes_total: 570_000_000,
    reason: state === "failed" ? "embed_asset_download_failed" : undefined });
  await page.route("**/setup/readiness", (route) => route.fulfill({ json: { data: { status: "ready", steps: [], memory_model: model() } } }));
  await page.route("**/setup/readiness/retry", (route) => {
    assert(route.request().postDataJSON().memory_model_only === true, "model retry preserves setup readiness");
    retried = true;
    state = "downloading";
    return route.fulfill({ json: { data: { status: "ready", steps: [], memory_model: model() } } });
  });
  const copy = firstRunCopy[language];
  const row = page.locator('[data-test-class="memory-model-status"]');
  await page.goto(server.url);
  await row.waitFor();
  for (const next of ["downloading", "verifying", "failed"]) {
    state = next;
    await row.getByText(next === "downloading" ? `${copy.memoryModel.downloading} · 54% · 312 / 570 MB`
      : next === "verifying" ? copy.memoryModel.verifying : copy.memoryModel.failed, { exact: true }).waitFor();
    if (next === "failed") {
      assert(!/\d+%|\d+ \/ \d+ MB/u.test(await row.innerText()), "failed has no stale progress");
      assert(await row.getByText(copy.memoryModel.reasons.embed_asset_download_failed, { exact: true }).count() === 1, "localized reason");
      await page.locator("#first-run-start").focus();
      await page.keyboard.press("Tab");
      assert(await row.getByRole("button", { name: copy.memoryModel.retry, exact: true }).evaluate((node) =>
        node === document.activeElement && getComputedStyle(node).boxShadow !== "none"), "Start then retry with visible keyboard focus");
    }
    await audit(page);
    if (width === 375 || width === 1280) await page.screenshot({ path: `${output}/status-${next}-${language}-${theme}-${width}.png` });
    cases += 1;
  }
  await row.getByRole("button", { name: copy.memoryModel.retry, exact: true }).click();
  await row.getByText(`${copy.memoryModel.downloading} · 54% · 312 / 570 MB`, { exact: true }).waitFor();
  assert(retried, "first-run retry is sent");
  await page.getByRole("button", { name: copy.start, exact: true }).click();
  const agree = page.getByRole("button", { name: copy.agree, exact: true });
  assert(await agree.isEnabled(), "download does not block consent");
  await agree.click();
  await page.locator('[data-first-run-screen="connect"]').waitFor();
  await verifySettings(page, language, row, () => { state = "failed"; }, () => { state = "ready"; });
  await context.close();
}

async function verifySettings(page: Page, language: "ko" | "en", row: ReturnType<Page["locator"]>, fail: () => void, ready: () => void) {
  const now = new Date().toISOString();
  const copy = getAppCopy(language === "ko" ? "ko-KR" : "en-US");
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ ...onboardingCompletedPatch({}, now, now), language }) });
  await page.reload();
  await page.locator('[data-test-class="workspace"]').waitFor();
  const showSidebar = page.getByRole("button", { name: copy.titlebar.showLeftPanel, exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  await page.getByRole("button", { name: copy.sidebar.settings, exact: true }).click();
  const general = page.getByRole("button", { name: language === "ko" ? "일반" : "General", exact: true });
  if (await general.isVisible()) await general.click();
  await row.waitFor();
  const section = page.locator('[data-settings-section-id="memory-model"]');
  assert(await section.count() === 1, "own status section");
  assert(await section.getByText(copy.firstRun.memoryModel.label, { exact: true }).count() === 1, "labeled memory status");
  assert(await page.locator('[data-settings-section-id="app-behavior"] [data-test-class="memory-model-status"]').count() === 0, "not under Run setup again");
  fail();
  await row.getByText(copy.firstRun.memoryModel.failed, { exact: true }).waitFor();
  await row.getByRole("button", { name: copy.firstRun.memoryModel.retry, exact: true }).click();
  await row.getByText(`${copy.firstRun.memoryModel.downloading} · 54% · 312 / 570 MB`, { exact: true }).waitFor();
  ready();
  await row.waitFor({ state: "hidden" });
  assert(await section.getByText(copy.firstRun.memoryModel.ready, { exact: true }).count() === 1, "ready status stays labeled");
  await page.route("**/updates", route => route.fulfill({ json: { data: { components: [] } } }));
  const back = page.locator('[data-test-class="settings-view settings-view-active"] main')
    .getByRole("button", { name: copy.settings.back, exact: true });
  if (await back.isVisible()) await back.click();
  await page.getByRole("button", { name: copy.settings.sections.updates, exact: true }).click();
  const preview = page.getByRole("switch", { name: copy.settings.actions.receivePreviewVersions, exact: true });
  await preview.waitFor();
  const description = copy.settings.actions.receivePreviewVersionsDescription;
  assert(await page.getByText(description, { exact: true }).count() === 1, "localized preview description");
  assert(await preview.evaluate((node, text) =>
    document.getElementById(node.getAttribute("aria-describedby")!)?.textContent === text, description),
  "preview switch is described by its explanation");
}

try {
  for (const language of ["ko", "en"] as const) {
    for (const theme of ["light", "dark"] as const) {
      for (const width of [320, 375, 768, 1280, 1440]) await runCase(language, theme, width);
    }
  }
  console.log(JSON.stringify({ ok: true, cases, textNodes, minimumContrast, output, modelCalls: server.stubModelCalls.length }));
} finally {
  await browser.close();
  await server.stop();
}
