import { chromium } from "playwright";
import { smokeBrowserArgs } from "./smoke-browser";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function captureQuickFixes(root: string, output: string, revision: string) {
  mkdirSync(output, { recursive: true });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const file = Bun.file(join(root, new URL(request.url).pathname));
    return new Response(await file.exists() ? file : Bun.file(join(root, "index.html")));
  } });
  const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });
  const report: unknown[] = [];
  try {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    page.setDefaultTimeout(30_000);
    await page.route("**/credentials", route => route.fulfill({ json: { data: { credentials: [] } } }));
    for (const width of [1280, 375]) for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const mode of ["composer", "settings", "activity"]) for (const state of mode === "activity" ? ["running", "completed"] : ["default"]) {
        await page.goto(`http://127.0.0.1:${server.port}/?visual=components&surface=quick-fixes&mode=${mode}&theme=${theme}&state=${state}`);
        await page.locator('[data-harness-ready="true"]').waitFor();
        const name = `${mode}-${state}-${width}-${theme}`;
        const capture = async (suffix: string) => {
          console.log(`Capturing ${revision} ${name}-${suffix}`);
          await page.evaluate(() => document.fonts.ready);
          await page.waitForFunction(() => document.getAnimations().every(animation =>
            animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
          await page.screenshot({ path: join(output, `${name}-${suffix}.png`), fullPage: true });
        };
        if (mode === "composer") {
          await page.locator('[contenteditable="true"]').fill("첫째 줄 hello\n둘째 줄 한국어");
          await capture("draft");
        } else if (mode === "settings") {
          const trigger = page.locator('[data-test-class="settings-models-advanced"] [data-slot="clickable"]');
          await trigger.hover();
          await capture("hover");
          await trigger.click();
          await capture("expanded");
        } else {
          const conversation = page.locator('[data-test-class~="turn-work-collapsed"]').first();
          await conversation.locator('[data-test-class="toggle-turn-activity-disclosure"]').click();
          await conversation.locator('[data-test-class~="turn-work-tool-group"] > button').click();
          await capture("conversation");
          await page.getByRole("button", { name: "위임 작업", exact: true }).click();
          const dialog = page.locator('[data-test-class="steward-observer-dialog"]');
          await dialog.waitFor();
          await capture("observer");
          const toggle = dialog.locator('[data-test-class="toggle-turn-activity-disclosure"]');
          if (await toggle.count()) {
            for (const item of await toggle.all()) await item.click();
            for (const item of await dialog.locator('[data-test-class~="turn-work-tool-group"] > button').all()) await item.click();
            await capture("observer-expanded");
          }
          report.push({ revision, width, theme, state,
            conversationTools: await conversation.locator('[data-test-class="turn-work-tool-detail-row"]').allTextContents(),
            observerTools: await dialog.locator('[data-test-class="turn-work-tool-detail-row"]').allTextContents() });
        }
      }
    }
    writeFileSync(join(output, "evidence.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ revision, screenshots: output, report }));
  } finally { await browser.close(); server.stop(true); }

}

if (import.meta.main) {
  const [root, output, revision] = process.argv.slice(2);
  await captureQuickFixes(root!, output!, revision!);
}
