// Real App on a stub agent: the composer's model picker never locks (#1193).
// A deleted selected model falls back to the Settings default and still sends;
// a failed controls read leaves the picker usable.
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { createNativeAppServer, type NativeAppServerHandle } from "../support/native-app-server.ts";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser.ts";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";

const CELLS = ["deleted-light", "deleted-dark", "error-light", "error-dark"];
const out = process.env.BUTLER_COMPOSER_MODEL_SHOTS;
const phase = process.env.BUTLER_COMPOSER_MODEL_PHASE ?? "after";
if (out) mkdirSync(out, { recursive: true });
const copy = getAppCopy("en-US");

async function capture(page: Page, name: string): Promise<void> {
  if (!out) return;
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(out, `${phase}-${name}.png`) });
}

async function registerSecondModel(server: NativeAppServerHandle): Promise<void> {
  const config = JSON.parse(readFileSync(join(server.butlerData, "butler.config.json"), "utf8"));
  await server.api("/model-catalog/local-models", { method: "POST", body: JSON.stringify({
    provider_id: "local", api_type: "openai_compatible", platform: "custom", server_url: config.models.local[0].server_url,
    model_id: "stub-b", display_name: "Stub B", context_window_tokens: 128000, source: "manual",
  }) });
}

async function expandComposer(page: Page): Promise<void> {
  const preview = page.locator('[data-slot="composer-compact-preview"]');
  await page.locator('[data-slot="composer-compact-preview"]:visible, [data-test-class="model-button"]:visible').first().waitFor();
  if (await preview.isVisible()) await preview.click();
}

async function send(page: Page, server: NativeAppServerHandle, text: string): Promise<string> {
  const before = server.stubModelCalls.length;
  await expandComposer(page);
  await page.locator('[contenteditable="true"]').fill(text);
  await page.locator('[data-test-class="composer-card"]').getByRole("button", { name: "Send", exact: true }).click();
  await page.getByLabel("Answer").getByText(`Reply to ${text}`, { exact: true }).last().waitFor();
  // The turn's own request carries tools; background title or memory requests do not.
  const call = server.stubModelCalls.slice(before)
    .find((item) => Array.isArray(item.body.tools) && JSON.stringify(item.messages).includes(text));
  assert(call, `the stub model ran the turn for ${text}`);
  return String(call.body.model);
}

async function modelButton(page: Page) {
  await expandComposer(page);
  const button = page.locator('[data-test-class="model-button"]');
  await button.waitFor();
  return button;
}

async function assertPickerUsable(page: Page, name: string): Promise<void> {
  const button = await modelButton(page);
  await page.locator('[data-test-class="composer-model-name"]').getByText(name, { exact: true }).waitFor();
  assert.equal(await button.isDisabled(), false, "the model picker is enabled");
  assert.equal(await button.getAttribute("aria-disabled"), null, "the model picker is not aria-disabled");
  await button.click();
  await page.getByText("Stub", { exact: true }).last().waitFor();
  await page.keyboard.press("Escape");
}

async function deleteInSettings(page: Page, model: string): Promise<void> {
  await page.getByRole("button", { name: copy.sidebar.settings, exact: true }).first().click();
  await page.getByText(copy.settings.sections.models, { exact: true }).first().click();
  await page.getByRole("button", { name: copy.settings.modelManagement.manageButton }).first().click();
  await page.getByRole("button", { name: copy.settings.modelManagement.deleteLabel(model) }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: copy.common.delete, exact: true }).click();
  await page.getByText(copy.settings.modelManagement.deletedStatus(model)).first().waitFor();
  await page.keyboard.press("Escape");
}

async function deletedCase(page: Page, server: NativeAppServerHandle, theme: string): Promise<void> {
  await registerSecondModel(server);
  await page.goto(server.url);
  await (await modelButton(page)).click();
  await page.getByText("Stub B", { exact: true }).last().click();
  assert.equal(await send(page, server, "first"), "stub-b");
  await deleteInSettings(page, "Stub B");
  const button = await modelButton(page);
  await capture(page, `deleted-${theme}`);
  assert.equal(await button.isDisabled(), false);
  await assertPickerUsable(page, "Stub");
  assert.equal(await send(page, server, "second"), "stub", "the chat falls back to the Settings default");
  // A fresh load reads the stored controls from the agent, which resolves the deleted model too.
  await page.reload();
  await assertPickerUsable(page, "Stub");
  assert.equal(await send(page, server, "third"), "stub");
}

async function errorCase(page: Page, server: NativeAppServerHandle, theme: string): Promise<void> {
  await page.goto(server.url);
  await send(page, server, "seed");
  await page.route("**/sessions/*/controls", (route) =>
    route.request().method() === "GET" ? route.abort("connectionrefused") : route.fallback());
  await page.reload();
  const failedRead = page.waitForEvent("requestfailed", (request) => request.url().endsWith("/controls"));
  await page.locator('[data-test-class="app-sidebar"]').getByText("Reply to seed", { exact: true }).click();
  await failedRead;
  await modelButton(page);
  await capture(page, `error-${theme}`);
  await assertPickerUsable(page, "Stub");
  await page.unroute("**/sessions/*/controls");
  assert.equal(await send(page, server, "after error"), "stub");
}

async function runCell(cell: string): Promise<void> {
  const [kind, theme] = cell.split("-") as [string, string];
  const server = await createNativeAppServer({
    uiRoot: resolve("packages/butler-app/client/ui/dist"),
    config: { user: { name: "Smoke", language: "en" } },
    stubReply: (request) =>
      `Reply to ${[...JSON.stringify(request.messages.at(-1)).matchAll(/first|second|third|seed|after error/gu)].at(-1)?.[0] ?? "other"}`,
  });
  const browser = await launchSmokeBrowser();
  try {
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en", appearance_theme: theme }) });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
    await server.signIn(page);
    try {
      if (kind === "deleted") await deletedCase(page, server, theme);
      else await errorCase(page, server, theme);
    } catch (error) {
      await capture(page, `failure-${cell}`);
      throw error;
    }
    console.log(JSON.stringify({ ok: true, cell, modelCalls: server.stubModelCalls.length }));
  } finally {
    await browser.close();
    await server.stop();
  }
}

if (!(await runSmokeCases(CELLS, "BUTLER_COMPOSER_MODEL_CELL", import.meta.path))) {
  const selected = process.env.BUTLER_COMPOSER_MODEL_CELL;
  for (const cell of selected ? [selected] : CELLS) await runCell(cell);
}
