// #1186: a reasoning select never renders empty. The built app's visual
// harness over an offline gateway stub (no model calls, no native agent):
// Settings → Models with a custom model that offers only "none" (disabled,
// named why in a tooltip), and with a stored effort the model does not offer
// (enabled so the owner can pick a valid one). Both show the effort the
// runtime uses. Light and dark, desktop.
// Run `npm --prefix packages/butler-app/client/ui run build` first
// (`bun run app:reasoning-select:smoke`). BUTLER_REASONING_SHOTS=<dir> saves captures.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import { reasoningEffortLabel } from "../../packages/butler-i18n/src/reasoning-effort.ts";
import { HARNESS_MESSAGES, HARNESS_MODEL_CATALOG, HARNESS_PRIMARY_MODEL } from "../../packages/butler-app/client/ui/src/app/fixtures.ts";
import type { AppModelSummary, ModelCatalogView } from "../../packages/butler-app/client/ui/src/app/types";
import { launchSmokeBrowser } from "../support/smoke-browser";

const root = process.cwd();
const copy = getAppCopy("ko-KR");
const shots = process.env.BUTLER_REASONING_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const dist = join(root, "packages/butler-app/client/ui/dist");
assert(existsSync(join(dist, "index.html")), "build the UI first: npm --prefix packages/butler-app/client/ui run build");
const base = "http://reasoning-select.localhost/";
const types: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".json": "application/json", ".wasm": "application/wasm" };
function distFile(pathname: string): string | null {
  const path = normalize(join(dist, decodeURIComponent(pathname)));
  return path.startsWith(dist + sep) && existsSync(path) && statSync(path).isFile() ? path : null;
}

const custom = (model_id: string, efforts: AppModelSummary["reasoning_efforts"], fallback: AppModelSummary["default_reasoning_effort"]): AppModelSummary => ({
  ...HARNESS_PRIMARY_MODEL, provider_id: "custom", provider_label: "Custom", model_id, model_ref: `custom/${model_id}`,
  display_name: model_id, status: "available", reasoning_efforts: efforts, default_reasoning_effort: fallback,
});
const noReasoning = custom("plain-chat", ["none"], "none");
const limited = custom("two-step", ["low", "high"], "high");
const catalog: ModelCatalogView = { ...HARNESS_MODEL_CATALOG, models: [...HARNESS_MODEL_CATALOG.models, noReasoning, limited],
  providers: [...HARNESS_MODEL_CATALOG.providers, { provider_id: "custom", provider_label: "Custom", latest_model_ref: noReasoning.model_ref, models: [noReasoning, limited] }] };
const cases = [
  { name: "single-option", model: noReasoning, stored: "high", effective: "none", fixed: true },
  { name: "stored-not-offered", model: limited, stored: "none", effective: "high", fixed: false },
] as const;

const browser = await launchSmokeBrowser();
const errors: string[] = [];
let fixture: object = {};
let checked = 0;
const failures: string[] = [];
try {
  const page = await browser.newPage({ reducedMotion: "reduce", locale: "ko-KR", timezoneId: "Asia/Seoul" });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(base).origin) return route.abort();
    if (url.pathname === "/") {
      const body = readFileSync(join(dist, "index.html"), "utf8")
        .replace("<head>", `<head><script>window.butlerConversationFixture=${JSON.stringify(fixture).replaceAll("<", "\\u003c")}</script>`);
      return route.fulfill({ contentType: "text/html", body });
    }
    const file = distFile(url.pathname);
    if (file) return route.fulfill({ contentType: types[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
    if (["/session-view", "/summary", "/navigation", "/events/live", "/health"].includes(url.pathname)) return route.fulfill({ json: { ok: true, data: {} } });
    return route.fulfill({ status: 404, json: { ok: false, error: { code: "not_found" } } });
  });
  for (const theme of ["light", "dark"] as const) {
    for (const item of cases) {
      fixture = { messages: HARNESS_MESSAGES, background: "plain", modelCatalog: catalog,
        settings: { model: item.model.model_ref, reasoning_effort: item.stored } };
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.goto(`${base}?visual=components&theme=${theme}&locale=ko`);
      const show = page.getByRole("button", { name: copy.titlebar.showLeftPanel });
      await show.first().waitFor();
      await show.first().click();
      await page.getByRole("button", { name: copy.sidebar.settings }).first().click();
      await page.locator('[data-test-class~="settings-view"]').waitFor();
      await page.getByRole("button", { name: copy.settings.sections.models, exact: true }).first().click();
      const trigger = page.locator('[data-test-class~="settings-primary-reasoning-select"]');
      await trigger.waitFor();
      await page.evaluate(() => document.fonts.ready);
      await trigger.scrollIntoViewIfNeeded();
      await trigger.hover({ force: true });
      const tooltip = page.getByRole("tooltip").filter({ hasText: copy.settings.descriptions.reasoningFixed });
      const shown = await tooltip.first().waitFor({ timeout: item.fixed ? 3000 : 500 }).then(() => true, () => false);
      if (shots) await page.screenshot({ path: join(shots, `models-${item.name}-${theme}.png`) });
      const label = reasoningEffortLabel(item.effective, "ko-KR");
      const where = `${item.name} ${theme}`;
      if (await trigger.isDisabled() !== item.fixed) failures.push(`${where}: select ${item.fixed ? "enabled" : "disabled"}`);
      const text = (await trigger.innerText()).trim();
      if (text !== label) failures.push(`${where}: shows "${text}", not the effective "${label}"`);
      if (shown !== item.fixed) failures.push(`${where}: tooltip ${shown ? "shown" : "missing"}`);
      if (!item.fixed) {
        // The owner can pick: the list holds exactly the model's efforts.
        await trigger.click();
        const offered = await page.getByRole("option").allInnerTexts();
        const expected = item.model.reasoning_efforts.map((effort) => reasoningEffortLabel(effort, "ko-KR"));
        if (JSON.stringify(offered.map((text) => text.trim())) !== JSON.stringify(expected)) failures.push(`${where}: offers ${offered.join(", ")}`);
        await page.keyboard.press("Escape");
      }
      checked += 1;
    }
  }
  console.log(JSON.stringify({ checked, rendererErrors: errors.length }));
  assert.equal(checked, 4);
  assert.deepEqual(failures, [], `reasoning selects:\n${failures.join("\n")}`);
  assert.deepEqual(errors, [], "no uncaught renderer errors");
} finally {
  await browser.close();
}
