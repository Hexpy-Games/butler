// UI behavior through the actual Settings screen; command handlers are mocked here.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser";
import { getAppCopy } from "../../packages/butler-i18n/src";
const output = process.env.HOOK_SCREENSHOTS ?? "/tmp/butler-hooks-screenshots";
mkdirSync(output, { recursive: true });
const root = process.env.HOOK_UI_ROOT ?? resolve("packages/butler-app/client/ui/dist");
const baseline = process.env.HOOK_BASELINE === "1";
const matrix = [1280, 375].flatMap(width => ["light", "dark"].flatMap(theme => ["en", "ko"].map(locale => `${width}-${theme}-${locale}`)));
if (await runSmokeCases(matrix, "HOOK_SMOKE_CASE", import.meta.path)) {
  console.log(`Hooks Settings: ${matrix.length} isolated viewport/theme/language cases passed; ${output}`);
  process.exit(0);
}
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const file = Bun.file(join(root, new URL(request.url).pathname));
  return new Response(await file.exists() ? file : Bun.file(join(root, "index.html")));
} });
const browser = await launchSmokeBrowser();
try {
  for (const width of [1280, 375]) for (const theme of ["light", "dark"]) for (const locale of ["en", "ko"]) {
    if (process.env.HOOK_SMOKE_CASE && process.env.HOOK_SMOKE_CASE !== `${width}-${theme}-${locale}`) continue;
    const copy = getAppCopy(locale === "ko" ? "ko-KR" : "en-US");
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
    let hooks: unknown[] = [], revision = 0;
    const runs: unknown[] = [];
    let outcome = "continue";
    const capture = async (state: string, shot = page) => {
      await shot.evaluate(() => document.fonts.ready);
      await shot.waitForFunction(() => document.getAnimations().every(animation =>
        animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
      assert.equal(await shot.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, state);
      await shot.screenshot({ path: join(output, `${state}-${width}-${theme}-${locale}.png`), fullPage: true });
    };
    await page.route("**/personalization", route => route.fulfill({ json: { data: {
      persona: "", eol: "", persona_presets: [], profile: { principal_name: "" }, profiling: { mode: "off" },
    } } }));
    await page.route("**/hooks**", async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (request.method() === "PUT") { hooks = request.postDataJSON().config.hooks; revision += 1; }
      if (path.endsWith("/test")) runs.push({ time: "2026-10-06T09:00:00Z", hook_id: "test", event: "UserPromptSubmit", session_id: null,
        outcome, duration_ms: outcome === "continue" ? 4 : 31, exit_code: outcome === "continue" ? 0 : 1, stdout: "test output", stderr: "", reason: null });
      await route.fulfill({ json: { data: path.endsWith("/runs") ? runs : path.endsWith("/test") ? runs.at(-1) : { revision, config: { version: 1, hooks }, error: null } } });
    });
    await page.goto(`http://127.0.0.1:${server.port}/?visual=components&locale=${locale}&theme=${theme}`);
    await page.locator('[data-test-class~="visual-harness"]').waitFor();
    const hideRight = page.getByRole("button", { name: copy.titlebar.hideRightPanel, exact: true }).first();
    if (width === 375 && await hideRight.isVisible()) await hideRight.click();
    const showSidebar = page.getByRole("button", { name: copy.titlebar.showLeftPanel, exact: true });
    if (await showSidebar.isVisible()) await showSidebar.click();

    await page.getByRole("button", { name: copy.sidebar.settings, exact: true }).click();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(output, `settings-${width}-${theme}-${locale}.png`) });
    if (!baseline) {
      await page.getByRole("button", { name: copy.settings.sections.hooks, exact: true }).click();
      await page.getByText(copy.settings.hooks.emptyRuns, { exact: true }).waitFor();
      await capture("empty");
      await page.getByRole("button", { name: copy.settings.hooks.add, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: copy.settings.hooks.add, exact: true });
      await dialog.waitFor();
      assert.equal(await dialog.getByRole("button", { name: copy.common.save, exact: true }).isDisabled(), true);
      await page.locator("#hook-args").fill('["printf", "okay"]');
      assert.equal(await page.locator("#hook-command").isDisabled(), true);
      await page.locator("#hook-args").fill("");
      // A guard's failure blocks by default; another event starts from its own default.
      assert.equal(await page.locator("#hook-fail-closed").isChecked(), true);
      await page.locator("#hook-event").selectOption("PostToolUse");
      assert.equal(await page.locator("#hook-fail-closed").count(), 0);
      await page.locator("#hook-event").selectOption("PreToolUse");
      assert.equal(await page.locator("#hook-fail-closed").isChecked(), true);
      await page.locator("#hook-name").fill("Test guard");
      await page.locator("#hook-command").fill("printf okay");
      await capture("add");
      await page.getByRole("button", { name: copy.common.save, exact: true }).click();
      await page.getByText("Test guard", { exact: true }).waitFor();
      assert.equal(hooks.length, 1);
      assert.equal((hooks[0] as { failClosed: boolean }).failClosed, true);
      await capture("list");
      assert(await page.getByText("Test guard", { exact: true }).evaluate(node => node.parentElement!.scrollWidth <= node.parentElement!.clientWidth), "name is not truncated");
      await page.getByRole("button", { name: copy.settings.hooks.edit, exact: true }).click();
      await page.getByRole("dialog", { name: copy.settings.hooks.editTitle, exact: true }).waitFor();
      await page.locator("#hook-name").fill("Edited guard");
      await capture("edit");
      await page.locator("#hook-fail-closed").click();
      await page.getByRole("button", { name: copy.common.save, exact: true }).click();
      await page.getByText("Edited guard", { exact: true }).waitFor();
      assert.equal((hooks[0] as { failClosed: boolean }).failClosed, false);
      await page.getByRole("button", { name: copy.settings.hooks.test, exact: true }).click();
      const success = page.locator('[data-sonner-toast][data-type="success"]').filter({ hasText: copy.settings.hooks.testSuccess }).last();
      await success.waitFor();
      assert((await success.textContent())?.includes(copy.settings.hooks.testSuccess));
      await capture("test-success");
      outcome = "error";
      await page.getByRole("button", { name: copy.settings.hooks.test, exact: true }).click();
      const failure = page.locator('[data-sonner-toast][data-type="error"]').filter({ hasText: copy.settings.hooks.testFailure }).last();
      await failure.waitFor();
      assert((await failure.textContent())?.includes(copy.settings.hooks.testFailure));
      await capture("test-failure");
      const log = page.locator('[data-settings-section-id="hook-runs"]');
      await log.getByRole("button").filter({ hasText: copy.settings.hooks.testFailure }).click();
      await log.locator("pre").getByText("test output", { exact: true }).waitFor();
      assert.equal(await log.locator("textarea").count(), 0);
      assert((await log.textContent())?.includes(`${copy.settings.hooks.exitCode} 1`));
      assert(!(await log.textContent())?.includes("· ·"));
      assert(!(await log.textContent())?.includes("2026-10-06T09:00:00Z"));
      assert.equal(runs.length, 2);
      await capture("runs-log");
      await page.getByRole("button", { name: copy.settings.hooks.remove, exact: true }).click();
      const confirmation = page.getByRole("alertdialog", { name: copy.common.delete, exact: true });
      await confirmation.waitFor();
      assert.equal(hooks.length, 1);
      await capture("delete-confirm");
      await confirmation.getByRole("button", { name: copy.common.cancel, exact: true }).click();
      assert.equal(hooks.length, 1);
      await page.getByRole("button", { name: copy.settings.hooks.remove, exact: true }).click();
      await confirmation.getByRole("button", { name: copy.common.delete, exact: true }).click();
      await page.getByText("Edited guard", { exact: true }).waitFor({ state: "hidden" });
      assert.equal(hooks.length, 0);
    }
    await page.close();
    if (!baseline) {
      // A failing guard blocked a tool mid-turn: the live stream tells the open chat.
      const chat = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
      let sent = 0, releaseBlock = () => {};
      const blockReleased = new Promise<void>(resolve => { releaseBlock = resolve; });
      await chat.route("**/events/live**", async route => {
        if (sent++) return route.fulfill({ status: 204 });
        await blockReleased;
        await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `data: ${JSON.stringify({
          id: 900_000, type: "hook.blocked", created_at: new Date().toISOString(), payload: {
            hook: "Test guard", event: "PreToolUse", tool: "run_command", session_id: "general",
            reason: "Test guard: hook failed (exited with code 1)" } })}\n\n` });
      });
      await chat.goto(`http://127.0.0.1:${server.port}/?visual=components&surface=win-fixes&locale=${locale}&theme=${theme}`);
      await chat.locator('[data-harness-ready="true"]').waitFor();
      // The fixture chat's unmocked reads raise their own toasts; clear them first.
      await chat.waitForLoadState("networkidle");
      for (const close of await chat.locator("[data-sonner-toast] [data-close-button]").all()) await close.click().catch(() => {});
      await chat.locator("[data-sonner-toast]").first().waitFor({ state: "detached" }).catch(() => {});
      releaseBlock();
      await chat.locator('[data-sonner-toast][data-type="error"]')
        .filter({ hasText: copy.settings.hooks.failedBlock("Test guard", "run_command") }).waitFor();
      await capture("hook-blocked", chat);
      await chat.close();
    }
  }
  console.log(`Hooks Settings: ${baseline ? "baseline" : "CRUD/test/log"}, ${process.env.HOOK_SMOKE_CASE ? 1 : matrix.length} viewport/theme/language combinations passed; ${output}`);
} finally { await browser.close(); await server.stop(true); }
