/** DS update decisions in the built App, including locale and narrow screens. */
import { strict as assert } from "node:assert";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { smokeBrowserArgs } from "../support/smoke-browser.ts";

const ui = resolve("packages/butler-app/client/ui/dist");
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  const asset = Bun.file(join(ui, path));
  return new Response(await asset.exists() ? asset : Bun.file(join(ui, "index.html")));
} });
const browser = await chromium.launch({ headless: true, channel: "chromium", args: smokeBrowserArgs() });
try {
  for (const language of ["en", "ko"]) {
    for (const width of [320, 375, 390, 430, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.addInitScript(() => {
        let state = { status: "idle", request_id: null as string | null };
        const listeners = new Set<(next: typeof state) => void>();
        const choices: Array<{ action: string; request_id: string | null }> = [];
        const emit = (next: typeof state) => { state = next; listeners.forEach(fn => fn(state)); };
        Object.assign(window, {
          updateSmoke: { emit, choices },
          butlerApp: {
            getAppUpdateState: async () => state,
            onAppUpdateState: (fn: (next: typeof state) => void) => { listeners.add(fn); return () => listeners.delete(fn); },
            chooseAppUpdate: async (input: { action: string; request_id: string | null }) => {
              choices.push(input); emit({ status: input.action === "now" ? "restarting" : "deferred", request_id: null });
              return { ok: true };
            },
          },
        });
      });
      await page.goto(`http://127.0.0.1:${server.port}/?visual=components&locale=${language}`);
      const dialog = page.locator('[data-test-id="app-update-choice"]');
      assert.equal(await dialog.count(), 0, "idle update has no decision");
      for (const action of ["now", "defer"]) {
        await page.evaluate((action) => {
          (window as unknown as { updateSmoke: { emit: (v: unknown) => void } }).updateSmoke.emit({
            status: "choice_required", request_id: `choice-${action}`,
          });
        }, action);
        await dialog.waitFor();
        const box = await dialog.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= width, `dialog overflow at ${width}`);
        const label = language === "ko"
          ? action === "now" ? "지금 업데이트" : "작업이 끝나면 업데이트"
          : action === "now" ? "Update now" : "Update after work finishes";
        await dialog.getByRole("button", { name: label, exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
      }
      const choices = await page.evaluate(() =>
        (window as unknown as { updateSmoke: { choices: unknown[] } }).updateSmoke.choices);
      assert.deepEqual(choices, [
        { request_id: "choice-now", action: "now" }, { request_id: "choice-defer", action: "defer" },
      ]);
      console.log(`PASS update DS choice: ${language} ${width}px, both actions, no idle dialog`);
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.stop(true);
}
