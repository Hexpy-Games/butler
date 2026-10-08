// Production Settings renderer + agent-shaped stub snapshots; no model calls.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page, Locator } from "playwright";
import { launchSmokeBrowser } from "../support/smoke-browser";
import { createNativeAppServer } from "../support/native-app-server";
import { getAppCopy } from "../../packages/butler-i18n/src";

// Real gateway settings and manifest selection, rendered by production Settings.
async function assertChannelDefaults() {
  const output = process.env.BUTLER_UPDATE_CHANNEL_SCREENSHOTS ?? join(tmpdir(), "butler-update-channel");
  mkdirSync(output, { recursive: true });
  const browser = await launchSmokeBrowser();
  let cells = 0;
  try {
    for (const [name, version, saved, expected] of [
      ["fresh-preview", "0.1.0-preview.9", undefined, true],
      ["explicit-off", "0.1.0-preview.9", false, false],
      ["fresh-stable", "0.1.0", undefined, false],
    ] as const) {
      const scratch = mkdtempSync(join(tmpdir(), "butler-channel-manifest-"));
      const manifest = join(scratch, "manifest.json");
      writeFileSync(manifest, JSON.stringify({ artifacts: ["0.1.1-preview.10", "0.0.9"].map(version => ({
        component: "app", version, channel: version.includes("preview") ? "preview" : "stable",
        staging_policy: "butler-data-updates", activation_policy: "user-installs-app-package", rollback_policy: "not-managed-by-butler",
      })) }));
      const server = await createNativeAppServer({ uiRoot: resolve("packages/butler-app/client/ui/dist"),
        config: saved === undefined ? {} : { update: { previews: saved } },
        env: { BUTLER_APP_VERSION: version, BUTLER_APP_UPDATE_MANIFEST: manifest } });
      try {
        const settings = await server.api<{ update_previews: boolean }>("/settings");
        assert.equal(settings.update_previews, expected, name);
        const checked = await server.api<{ receive_previews: boolean; components: Array<{ update_available: boolean }> }>("/updates/check",
          { method: "POST", body: JSON.stringify({ component: "app" }) });
        assert.equal(checked.receive_previews, expected, name);
        assert.equal(checked.components[0]!.update_available, expected, name);
        for (const width of [375, 1280]) for (const theme of ["light", "dark"]) {
          await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme }) });
          const page = await browser.newPage({ viewport: { width, height: 900 } });
          try {
            await server.signIn(page);
            await page.goto(server.url);
            await page.locator('[data-test-class~="composer-card"]').waitFor();
            await page.keyboard.press("ControlOrMeta+k");
            const dialog = page.getByRole("dialog", { name: getAppCopy("ko-KR").commandPalette.label });
            await dialog.getByRole("combobox").fill(getAppCopy("ko-KR").settings.sections.updates);
            await dialog.getByRole("option").filter({ has: page.getByText(getAppCopy("ko-KR").settings.sections.updates, { exact: true }) }).click();
            await dialog.waitFor({ state: "hidden" });
            const control = page.locator('[data-setting-id="update-previews"] [role="switch"]');
            await control.waitFor();
            assert.equal(await control.getAttribute("aria-checked"), String(expected), name);
            await page.evaluate(() => document.fonts.ready);
            await page.waitForFunction(() => document.getAnimations().every(animation =>
              animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
            await page.screenshot({ path: join(output, `${name}-${width}-${theme}.png`) });
            cells++;
          } finally { await page.close(); }
        }
        const config = JSON.parse(readFileSync(join(server.butlerData, "butler.config.json"), "utf8"));
        assert.equal(config.update?.previews, saved, "effective default never writes config");
        assert.equal(server.stubModelCalls.length, 0);
      } finally { await server.stop(); rmSync(scratch, { recursive: true, force: true }); }
    }
    console.log(JSON.stringify({ ok: true, channelCases: 3, rendererCells: cells, modelCalls: 0, screenshots: output }));
  } finally { await browser.close(); }
}

if (process.argv.includes("--channel-defaults")) {
  await assertChannelDefaults();
  process.exit(0);
}

const uiRoot = resolve("packages/butler-app/client/ui/dist");
const output = process.env.BUTLER_UPDATE_PROGRESS_SCREENSHOTS ?? join(tmpdir(), "butler-update-progress");
mkdirSync(output, { recursive: true });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  const file = Bun.file(join(uiRoot, path === "/" ? "index.html" : path));
  return new Response(await file.exists() ? file : Bun.file(join(uiRoot, "index.html")));
} });
const browser = await launchSmokeBrowser();
const stages = ["idle", "checking", "downloading", "verifying", "ready", "applying", "restarting", "failed", "completed"] as const;
const errors: string[] = [];
type Copy = ReturnType<typeof getAppCopy>["settings"];
let cells = 0;
let errorCells = 0;
let motionCells = 0;

async function assertGeometry(page: Page, row: Locator) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "no viewport overflow");
  const bounds = await row.boundingBox();
  assert(bounds);
  for (const child of await row.locator('button, [role="progressbar"], [data-slot="spinner"]').all()) {
    const box = await child.boundingBox();
    assert(box && box.x >= bounds.x && box.x + box.width <= bounds.x + bounds.width + 1, "content stays inside row");
  }
  const spinner = row.locator('[data-slot="spinner"]').first();
  if (await spinner.count()) {
    const caption = spinner.locator('xpath=../following-sibling::*');
    const glyph = await spinner.boundingBox();
    const text = await caption.boundingBox();
    assert(glyph && text && Math.abs(glyph.y + glyph.height / 2 - text.y - text.height / 2) <= 1, "caption spinner centered");
  }
}

async function assertStage(page: Page, row: Locator, stage: typeof stages[number], copy: Copy) {
  await page.locator(`[data-test-id="stage-${stage}"]`).click();
  await row.locator(`xpath=self::*[@data-stage="${stage}"]`).waitFor();
  const actions = row.getByRole("button");
  const busy = ["checking", "verifying", "applying", "restarting"].includes(stage);
  assert.equal(await actions.count(), busy ? 0 : 1, `${stage}: only available action`);
  if (busy || stage === "ready") assert.equal(await row.getByText(copy.updateProgress[stage], { exact: true }).count(), 1, "stage appears once");
  if (["idle", "completed", "ready"].includes(stage)) assert.equal(await row.locator('[data-test-id="update-progress"]').count(), 0, "no idle panel");
  if (stage === "ready") assert.equal(await actions.textContent(), copy.updateProgress.restart);
  if (stage === "completed") { await row.getByRole("button", { name: copy.actions.upToDate, exact: true }).waitFor(); assert.equal(await actions.isDisabled(), true); }
  if (stage === "failed") {
    await row.getByText(copy.updateErrors.damaged, { exact: true }).waitFor();
    assert.equal(await actions.textContent(), copy.updateProgress.retry);
  }
  if (stage !== "downloading") assert.equal(await row.getByRole("progressbar").count(), 0);
  if (stage === "downloading") {
    assert.equal(await row.getByRole("progressbar").getAttribute("aria-valuenow"), "42");
    assert.equal(await actions.textContent(), copy.updateProgress.cancel);
    assert.equal(await row.getByText(copy.updateProgress.downloading, { exact: true }).count(), 1);
    const bytes = (value: number) => new Intl.NumberFormat(localeForCopy(copy), { style: "unit", unit: "megabyte", unitDisplay: "short", maximumFractionDigits: 0 }).format(value);
    const expected = copy.updateProgress.downloadMeta.replace("{percent}", "42").replace("{done}", bytes(44.102)).replace("{total}", bytes(104.8576));
    assert((await row.textContent())?.includes(expected), "complete decimal localized byte counts");
  }
  await assertGeometry(page, row);
}
function localeForCopy(copy: Copy) { return copy.updateProgress.cancel === "취소" ? "ko-KR" : "en-US"; }

async function assertUnknownAndRecovery(page: Page, row: Locator, copy: Copy, name: string) {
  await page.goto(page.url());
  await row.waitFor();
  await page.locator('[data-test-id="stage-downloading"]').click();
  await page.locator('[data-test-id="harness-bytes"]').click();
  const meter = row.locator('[data-indeterminate="true"]');
  await meter.waitFor();
  assert.equal(await row.getByRole("progressbar").count(), 0, "no fake bar");
  assert.equal(await row.locator('[data-slot="spinner"]').count(), 1);
  assert.equal(await row.getByRole("button").isDisabled(), false, "cancel stays available");
  const done = new Intl.NumberFormat(localeForCopy(copy), { style: "unit", unit: "megabyte", unitDisplay: "short", maximumFractionDigits: 0 }).format(44.102);
  assert.equal(await meter.textContent(), `${copy.updateProgress.downloading} · ${copy.updateProgress.downloadedBytes.replace("{done}", done)}`);
  assert(await meter.evaluate((element) => {
    const animations = element.getAnimations({ subtree: true });
    return animations.length > 0 && animations.every(animation => {
      const target = (animation.effect as KeyframeEffect | null)?.target;
      return target instanceof Element && Boolean(target.closest('[data-slot="spinner"]'));
    });
  }), "only the DS Spinner breathes under reduced motion");
  await assertGeometry(page, row);
  await row.scrollIntoViewIfNeeded();
  await row.screenshot({ path: join(output, `unknown-row-${name}.png`) });
  await page.screenshot({ path: join(output, `unknown-${name}.png`) });
  await page.locator('[data-test-id="harness-no-bytes"]').click();
  await meter.getByText(copy.updateProgress.downloading, { exact: true }).waitFor();
  assert.equal(await meter.textContent(), copy.updateProgress.downloading, "no invented received bytes");
  await page.locator('[data-test-id="harness-no-bytes"]').click();
  await page.locator('[data-test-id="harness-stale"]').click();
  assert.equal(await row.getAttribute("data-stage"), "downloading", "revision fence rejects stale SSE");
  await page.locator('[data-test-id="harness-navigation"]').click();
  await row.waitFor({ state: "hidden" });
  await page.locator('[data-test-id="stage-verifying"]').click();
  await page.locator('[data-test-id="harness-navigation"]').click();
  await row.locator('xpath=self::*[@data-stage="verifying"]').waitFor();
  await page.locator('[data-test-id="stage-downloading"]').click();
  await row.getByRole("button", { name: copy.updateProgress.cancel, exact: true }).click();
  await row.locator('xpath=self::*[@data-stage="idle"]').waitFor();
  assert.equal(await row.locator('[data-test-id="update-progress"]').count(), 0);
  await page.getByText(copy.updateProgress.cancelled, { exact: true }).waitFor();
  assert.equal(await row.getByRole("button").textContent(), copy.actions.updateComponent);
  await page.locator('[data-test-id="harness-bytes"]').click();
}

async function assertFailuresAndActions(page: Page, row: Locator, copy: Copy) {
  const keys = ["download", "damaged", "damaged", "incompatible", "storage", "apply", "generic"] as const;
  for (const [index, key] of keys.entries()) {
    await page.locator(`[data-test-id="harness-error-${index}"]`).click();
    await row.getByText(copy.updateErrors[key], { exact: true }).waitFor();
    assert(!(await row.textContent())?.includes("update_"), "no raw codes");
    await row.getByRole("button", { name: copy.updateProgress.retry, exact: true }).click();
    await row.locator('xpath=self::*[@data-stage="checking"]').waitFor();
    errorCells++;
  }
  await page.locator('[data-test-id="harness-error-7"]').click();
  await row.locator('xpath=self::*[@data-stage="idle"]').waitFor();
  assert.equal(await row.locator('[data-test-id="update-progress"]').count(), 0, "cancelled snapshot is not failure");
  await page.locator('[data-test-id="stage-ready"]').click();
  await row.getByRole("button", { name: copy.updateProgress.restart, exact: true }).click();
  await row.locator('xpath=self::*[@data-stage="restarting"]').waitFor();
  await page.locator('[data-test-id="harness-deferred"]').click();
  await row.getByText(copy.actions.updateDeferred, { exact: true }).waitFor();
  assert.equal(await row.getByRole("button").textContent(), copy.actions.updateAfterWork);
  assert.equal(await row.getByRole("button").isDisabled(), true);
  await page.locator('[data-test-id="harness-deferred"]').click();
}

try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(error.message));
  for (const width of [375, 1280]) for (const theme of ["light", "dark"]) for (const locale of ["ko", "en"] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`http://127.0.0.1:${server.port}/?visual=update-progress&theme=${theme}&locale=${locale}`);
    const row = page.locator('[data-test-id="update-component-app"]');
    await row.waitFor();
    assert.equal(await page.locator("[data-theme]").first().getAttribute("data-theme"), theme);
    const copy = getAppCopy(locale === "ko" ? "ko-KR" : "en-US").settings;
    const name = `${width}-${theme}-${locale}`;
    for (const stage of stages) {
      await assertStage(page, row, stage, copy);
      await row.scrollIntoViewIfNeeded();
      await row.screenshot({ path: join(output, `${stage}-row-${name}.png`) });
      await page.screenshot({ path: join(output, `${stage}-${name}.png`) });
      cells++;
    }
    await assertUnknownAndRecovery(page, row, copy, name);
    await assertFailuresAndActions(page, row, copy);
  }
  const motionPage = await browser.newPage({ reducedMotion: "no-preference" });
  motionPage.on("pageerror", (error) => errors.push(error.message));
  for (const width of [375, 1280]) for (const theme of ["light", "dark"]) for (const locale of ["ko", "en"]) {
    await motionPage.setViewportSize({ width, height: 900 });
    await motionPage.goto(`http://127.0.0.1:${server.port}/?visual=update-progress&theme=${theme}&locale=${locale}&bytes=unknown`);
    const meter = motionPage.locator('[data-indeterminate="true"]');
    await meter.waitFor();
    assert.equal(await meter.getByRole("progressbar").count(), 0);
    assert(await meter.evaluate((element) => element.getAnimations({ subtree: true }).some((animation) => animation.effect?.getTiming().iterations === Infinity)), "normal motion spinner animates");
    motionCells++;
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, cells, errorCells, motionCells, widths: [375, 1280], themes: ["light", "dark"], locales: ["ko", "en"], revisionFence: true, navigationRecovery: true, cancelled: true, restart: true, deferred: true, errors: 0 }));
} finally { await browser.close(); server.stop(true); }
