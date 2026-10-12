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
  let state = "unset";
  let retried = false;
  let chosen: boolean | null = null;
  const model = () => ({ state, bytes_done: ["failed", "unset"].includes(state) ? 0 : 312_000_000, bytes_total: 570_000_000,
    reason: state === "failed" ? "embed_asset_download_failed" : undefined });
  const view = () => ({ json: { data: { status: "ready", steps: [], memory_model: model() } } });
  await page.route("**/setup/readiness", (route) => route.fulfill(view()));
  await page.route("**/setup/memory-model", (route) => {
    chosen = route.request().postDataJSON().enabled === true;
    state = chosen ? "downloading" : "off";
    return route.fulfill(view());
  });
  await page.route("**/setup/readiness/retry", (route) => {
    assert(route.request().postDataJSON().memory_model_only === true, "model retry preserves setup readiness");
    retried = true;
    state = "downloading";
    return route.fulfill(view());
  });
  const copy = firstRunCopy[language];
  const row = page.locator("[data-test-class='memory-model-status']");
  await page.goto(server.url);
  await page.locator("#first-run-start").waitFor();
  assert(await row.count() === 0, "welcome shows no download before the choice");
  await page.getByRole("button", { name: copy.start, exact: true }).click();
  await page.getByRole("button", { name: copy.agree, exact: true }).click();
  const next = page.getByRole("button", { name: copy.memoryChoice.continue, exact: true });
  await next.waitFor();
  assert(await next.isDisabled(), "a memory choice is required");
  assert(chosen === null && await row.count() === 0, "nothing downloads before Continue");
  await page.locator("[data-memory-choice=on]").getByText(copy.memoryChoice.size(570), { exact: true }).waitFor();
  await page.locator("[data-memory-choice=on]").click();
  assert(chosen === null, "picking alone saves nothing");
  await next.click();
  await page.locator("[data-first-run-screen='connect']").waitFor();
  assert(chosen === true, "Continue saves on");
  for (const step of ["downloading", "verifying", "failed"]) {
    state = step;
    await row.getByText(step === "downloading" ? `${copy.memoryModel.downloading} · 54% · 312 / 570 MB`
      : step === "verifying" ? copy.memoryModel.verifying : copy.memoryModel.failed, { exact: true }).waitFor();
    if (step === "failed") {
      assert(!/\d+%|\d+ \/ \d+ MB/u.test(await row.innerText()), "failed has no stale progress");
      assert(await row.getByText(copy.memoryModel.reasons.embed_asset_download_failed, { exact: true }).count() === 1, "localized reason");
    }
    await audit(page);
    if (width === 375 || width === 1280) await page.screenshot({ path: `${output}/status-${step}-${language}-${theme}-${width}.png` });
    cases += 1;
  }
  await row.getByRole("button", { name: copy.memoryModel.retry, exact: true }).click();
  await row.getByText(`${copy.memoryModel.downloading} · 54% · 312 / 570 MB`, { exact: true }).waitFor();
  assert(retried, "first-run retry is sent");
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
  await page.getByRole("button", { name: copy.settings.sections.memory, exact: true }).click();
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
  const toggle = section.getByRole("switch", { name: copy.firstRun.memoryChoice.on, exact: true });
  assert(await toggle.getAttribute("aria-checked") === "true", "the first-run choice shows as on");
  await toggle.click();
  await section.getByText(copy.firstRun.memoryModel.ready, { exact: true }).waitFor({ state: "detached" });
  assert(await toggle.getAttribute("aria-checked") === "false", "the same switch turns the model off");
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
