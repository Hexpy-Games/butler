// Public settings UI against the isolated native gateway; no provider calls.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src";
import { LEGACY_FIRST_RUN_STORAGE_KEY, legacyFirstRunCompleteRecord } from "../../packages/butler-app/client/ui/src/app/onboarding";
import type { ImageUsageView } from "../../packages/butler-app/client/ui/src/components/usage/imageUsageTypes";
import { createNativeAppServer } from "../support/native-app-server";
import { launchSmokeBrowser } from "../support/smoke-browser";
import { insightsMonitor } from "../support/usage-insights-fixtures";

const copy = getAppCopy("ko-KR");
const output = process.env.BUTLER_IMAGE_USAGE_SHOTS;
if (output) mkdirSync(output, { recursive: true });
const server = await createNativeAppServer({ uiRoot: resolve("packages/butler-app/client/ui/dist") });
const browser = await launchSmokeBrowser();
const imageSection = (page: Page) => page.locator('[data-settings-section-id="usage-images"]');
const model = "openai/gpt-image-2.5-sunburst";
const secondModel = "google/retired-image";
const json = (body: unknown, method = "POST") => ({ method, body: JSON.stringify(body) });

async function openUsage(page: Page) {
  await page.goto(server.url);
  await page.locator('[data-test-class~="composer-card"]').waitFor();
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: copy.commandPalette.label });
  await dialog.getByRole("combobox").fill(copy.settings.sections.usage);
  await dialog.getByRole("option").filter({ has: page.getByText(copy.settings.sections.usage, { exact: true }) }).click();
  await page.locator('[data-settings-section-id="usage-history"]').waitFor();
}

async function capture(page: Page, state: string) {
  if (!output) return;
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    const target = state === "before" ? page.locator('[data-settings-section-id="usage-history"]') : imageSection(page);
    await target.scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(output, `${state}-${width}.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  await page.setViewportSize({ width: 1280, height: 1000 });
}

async function record(modelRef: string, op: "generate" | "edit", images: number, age = 0, outputTokens = 1) {
  await server.api("/internal/e2e/images/usage", json({
    ts: new Date(Date.now() - age * 86400000).toISOString(), model_ref: modelRef,
    provider_id: modelRef.split("/")[0], op, images, quality: "high",
    input_text_tokens: modelRef === model ? 1 : null,
    input_image_tokens: modelRef === model ? 0 : null,
    output_image_tokens: modelRef === model ? outputTokens : null,
  }));
}

async function assertValues(page: Page, days: number, generated: number, edited: number) {
  const view = await server.api<ImageUsageView>(`/usage/images?days=${days}`);
  assert.equal(view.total.generated, generated);
  assert.equal(view.total.edited, edited);
  const expected = await page.evaluate(({ view, totalLabel }) => {
    const currency = new Intl.NumberFormat(document.documentElement.lang, { style: "currency", currency: "USD" });
    const format = (cost: number | null) => cost === null ? "—" : cost > 0 && cost < 0.005 ? "<$0.01" : currency.format(cost);
    const rows = view.models.map(row => [row.display_name, String(row.generated), String(row.edited), format(row.estimated_usd)]);
    rows.push([totalLabel, String(view.total.generated), String(view.total.edited), format(view.total.estimated_usd)]);
    return rows;
  }, { view, totalLabel: copy.composer.usage.imagesTotal });
  const rows = imageSection(page).locator("tbody tr, tfoot tr");
  await rows.first().waitFor();
  await page.waitForFunction(({ expected, selector }) => {
    const rows = Array.from(document.querySelectorAll(selector));
    return JSON.stringify(rows.map(row => Array.from(row.children, cell => (cell as HTMLElement).innerText.trim()))) === JSON.stringify(expected);
  }, { expected, selector: '[data-settings-section-id="usage-images"] tbody tr, [data-settings-section-id="usage-images"] tfoot tr' }).catch(async error => {
    console.error(JSON.stringify({ days, expected, observed: await rows.evaluateAll(nodes => nodes.map(row => Array.from(row.children, cell => (cell as HTMLElement).innerText.trim()))) }));
    throw error;
  });
  assert.deepEqual(await rows.evaluateAll(nodes => nodes.map(row => Array.from(row.children, cell => (cell as HTMLElement).innerText.trim()))), expected);
}

try {
  await server.api("/settings", json({ language: "ko", appearance_theme: "light" }, "PATCH"));
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ko-KR" });
  await server.signIn(context);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: LEGACY_FIRST_RUN_STORAGE_KEY, value: legacyFirstRunCompleteRecord(),
  });
  await page.route("**/usage-monitor?*", route => route.fulfill({ json: { data: insightsMonitor() } }));
  let imageReads = 0;
  page.on("requestfinished", request => { if (/\/(usage\/images|settings\/image-model)\?/u.test(request.url()) || request.url().endsWith("/settings/image-model")) imageReads += 1; });
  await openUsage(page);
  await page.waitForFunction(() => performance.getEntriesByType("resource").filter(entry => /\/(usage\/images|settings\/image-model)/u.test(entry.name)).length >= 3);
  assert.equal(await imageSection(page).count(), 0, "no selection and no thirty-day usage hides section");
  await capture(page, "before");
  const credential = await server.api<{ credential: { id: string } }>("/credentials", json({ provider_id: "openai", api_key: "image-smoke-placeholder" }));
  await server.api("/settings/image-model", json({ model_ref: model, credential_id: credential.credential.id }, "PUT"));
  await openUsage(page);
  await assertValues(page, 7, 0, 0);
  await record(model, "generate", 7, 10);
  await server.api("/settings/image-model", json({ selected: null }, "PUT"));
  await openUsage(page);
  await assertValues(page, 7, 0, 0);
  await imageSection(page).getByRole("radio", { name: copy.composer.usage.month, exact: true }).click();
  await assertValues(page, 30, 7, 0);
  await record(model, "generate", 2);
  await record(model, "edit", 1);
  await record(secondModel, "edit", 2);
  await openUsage(page);
  await assertValues(page, 7, 2, 3);
  const section = imageSection(page);
  assert.equal(await section.getByRole("heading", { name: copy.composer.usage.imagesTitle, exact: true }).count(), 1);
  assert.deepEqual(await section.locator("thead th").allTextContents(), ["", "생성", "편집", "추정 비용"]);
  assert.equal(await section.locator('tbody [data-slot="provider-logo"]').count(), 2);
  assert.equal(await section.locator("tbody tr").filter({ hasText: "—" }).count(), 1);
  assert.equal(await section.locator("tbody tr").filter({ hasText: "<$0.01" }).count(), 1);
  const ids = await page.locator("[data-settings-section-id]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-settings-section-id")));
  assert.deepEqual(ids.slice(ids.indexOf("usage-history"), ids.indexOf("usage-providers") + 1), ["usage-history", "usage-images", "usage-providers"]);
  await capture(page, "after");
  const readsBefore = imageReads;
  await section.getByRole("radio", { name: copy.composer.usage.month, exact: true }).click();
  await assertValues(page, 30, 9, 3);
  await section.getByRole("radio", { name: copy.composer.usage.week, exact: true }).click();
  await assertValues(page, 7, 2, 3);
  assert.equal(imageReads, readsBefore, "range toggles reuse cached responses");
  await record(model, "generate", 4, 0, 1000);
  await page.getByRole("button", { name: copy.common.refresh, exact: true }).click();
  await assertValues(page, 7, 6, 3);
  assert.deepEqual(errors, []);
  assert.equal(server.stubModelCalls.length, 0);
  console.log(JSON.stringify({ ok: true, ranges: [7, 30], generated: 6, edited: 3, modelCalls: 0, screenshots: output ? 4 : 0 }));
} finally {
  await browser.close();
  await server.stop();
}
