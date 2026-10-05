import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { projectSharedWorkBlocks } from "../../packages/butler-progress-projection/src/index.ts";
import type { SharedProgressRow } from "../../packages/butler-progress-projection/src/index.ts";

/** Optional sanitised gateway capture through the ordinary activity harness. */
export async function checkCapturedActivity(page: Page, origin: string, output: string) {
  const path = process.env.BUTLER_SMOKE_ACTIVITY_CAPTURE;
  if (!path) return;
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  const rows: SharedProgressRow[] = fixture.latest_turn.progress.safe_progress_rows;
  const calls = new Set(rows.filter(row => row.bridge_phase === "btcc_operation").map(row => row.tool_call_id));
  const blocks = projectSharedWorkBlocks(rows).blocks;
  assert.deepEqual(new Set(blocks.flatMap(block => block.rows).map(row => row.tool_call_id)), calls);
  await page.addInitScript(value => {
    (window as Window & { butlerActivityFixture?: unknown }).butlerActivityFixture = value;
  }, fixture);
  // Bookkeeping is already represented by Work state; these are the visible capabilities.
  const bookkeeping = new Set(["start_work", "continue_work", "replace_work_plan", "record_work_checkpoint", "record_work_review", "record_work_disposition"]);
  const expected = blocks.flatMap(block => block.rows).filter(row => !bookkeeping.has(row.safe_tool_name ?? "")).length;
  assert(expected > 0);
  for (const width of [375, 1280]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/?visual=components&surface=activity-layout&theme=${theme}&state=completed`);
    await page.locator('[data-test-class~="turn-work-collapsed"]').first().waitFor();
    for (const button of await page.locator('[data-test-class~="turn-work-collapsed"] [data-test-class="toggle-turn-activity-disclosure"]').all()) await button.click();
    const conversationTools = page.locator('[data-test-class="message assistant"]').last().locator('[data-test-class="turn-work-tool-row"]');
    assert.equal(await conversationTools.count(), expected, "captured conversation retains every visible tool call");
    await page.screenshot({ path: join(output, `captured-conversation-${width}-${theme}.png`) });
    await page.getByRole("button", { name: "작업 기록", exact: true }).click();
    const dialog = page.locator('[data-test-class="activity-layout-observer"]');
    await dialog.locator('[data-test-class~="turn-work-collapsed"] [data-test-class="toggle-turn-activity-disclosure"]').click();
    assert.equal(await dialog.locator('[data-test-class="turn-work-tool-row"]').count(), expected, "captured observer retains every visible tool call");
    await dialog.screenshot({ path: join(output, `captured-observer-${width}-${theme}.png`) });
  }
  console.log(JSON.stringify({ captured: true, inputRows: rows.length, calls: calls.size, visibleTools: expected, screenshots: 8 }));
}
