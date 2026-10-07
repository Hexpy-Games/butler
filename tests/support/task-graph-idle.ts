import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { Page } from "playwright";

export async function installGraphActivityCounters(page: Page) {
  await page.addInitScript(() => {
    const counts = { frames: 0, storage: 0, ticks: 0 };
    Object.assign(window, { __graphActivity: counts });
    const frame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => frame(time => { counts.frames++; callback(time); });
    const interval = window.setInterval.bind(window);
    window.setInterval = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => interval(() => {
      if (delay === 1000) counts.ticks++;
      if (typeof callback === "function") callback(...args);
    }, delay)) as typeof window.setInterval;
    const storage = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { counts.storage++; storage.call(this, key, value); };
  });
}

export async function assertTaskGraphIdle(page: Page, data: string) {
  // Pin WALs so an intervening checkpoint cannot hide commits made by read/view paths.
  const paths = ["agent-runtime/btcc.sqlite", "app-server/butler-client.sqlite"];
  const pins = paths.map(path => new Database(join(data, path), { readonly: true }));
  const sample = () => paths.map(path => {
    const file = join(data, `${path}-wal`);
    return existsSync(file) ? readFileSync(file).toString("base64") : "";
  });
  try {
    for (const db of pins) { db.run("BEGIN"); db.query("SELECT name FROM sqlite_master LIMIT 1").get(); }
    await page.waitForTimeout(1200); // settle the existing shell's persistence and finite DS motion
    const before = sample();
    const counters = () => page.evaluate(() => ({ ...(window as unknown as { __graphActivity: { frames: number; storage: number; ticks: number } }).__graphActivity }));
    const start = await counters();
    await page.waitForTimeout(2200);
    const end = await counters();
    assert.deepEqual(sample(), before, "viewing the task graph wrote a pinned database WAL");
    assert.equal(end.frames - start.frames, 0, "idle graphs scheduled animation-frame JS");
    assert.equal(end.storage - start.storage, 0, "idle task view wrote browser storage");
    assert.equal(end.ticks - start.ticks, 0, "a graph with no running nodes kept a clock");
    console.log(JSON.stringify({ idleMs: 2200, walWrites: 0, storageWrites: 0, frames: 0, ticks: end.ticks - start.ticks, runningGraphs: 0 }));
  } finally { for (const db of pins) { db.run("ROLLBACK"); db.close(); } }
}

export async function assertTaskGraphClocks(page: Page, running: number) {
  const count = () => page.evaluate(() => (window as unknown as { __graphActivity: { ticks: number } }).__graphActivity.ticks);
  const card = page.locator('[data-test-class="task-graph-card"][data-task-status="running"]').first();
  const before = await card.getAttribute("aria-label");
  const start = await count();
  await page.waitForTimeout(2200);
  const ticks = await count() - start;
  assert(ticks >= running * 2 && ticks <= running * 3, "one 1Hz clock per running graph");
  assert.notEqual(await card.getAttribute("aria-label"), before, "running elapsed time advances");
  await page.getByRole("button", { name: "Summary", exact: true }).click();
  const hidden = await count();
  await page.waitForTimeout(2200);
  assert.equal(await count(), hidden, "a hidden task tab kept its graph clocks");
  assert.equal(await page.locator('[data-test-class="task-graph-card"]').count(), 0, "Summary still has no graph");
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.locator('[data-test-class="task-graph-card"]').first().waitFor();
  console.log(JSON.stringify({ clockMs: 2200, runningGraphs: running, ticks, hiddenTicks: 0 }));
}
