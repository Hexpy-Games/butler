import assert from "node:assert/strict";
import type { Browser, Page } from "playwright";
import { traceCoastal } from "./composer-decoration-trace";

interface Metrics {
  edits: number; frames: number; mainMs: number; maxInputMs: number; active: boolean;
  drawMs: number; gpuMs: number; gpuSamples: number;
}
const metrics = (page: Page): Promise<Metrics> => page.locator("[data-decoration-perf]").evaluate(node => JSON.parse((node as HTMLElement).dataset.metrics!));
const idle = (page: Page) => page.waitForFunction(() => {
  const raw = document.querySelector<HTMLElement>("[data-decoration-perf]")?.dataset.metrics;
  return raw && !JSON.parse(raw).active;
});

export async function measureDecorations(page: Page, browser: Browser, density = 1) {
  const input = page.getByRole("textbox", { name: "Try your message" });
  const results = [];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const taskSeconds = async () => (await cdp.send("Performance.getMetrics")).metrics.find(m => m.name === "TaskDuration")!.value;
  for (const theme of ["none", "flowers", "cherry", "characters", "coastal"]) {
    await page.getByLabel("Decoration", { exact: true }).selectOption(theme);
    await input.fill("");
    await page.waitForTimeout(400);
    await idle(page);
    const before = await metrics(page);
    const taskBefore = await taskSeconds();
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(3);
    await input.pressSequentially(text, { delay: 8 });
    await page.waitForTimeout(400);
    await idle(page);
    const after = await metrics(page);
    const browserTaskMsPerEdit = ((await taskSeconds()) - taskBefore) * 1000 / text.length;
    assert.equal(await input.inputValue(), text, "perf run preserves every character in order");
    assert.equal(after.edits - before.edits, theme === "none" ? 0 : text.length, "every interactive edit counted");
    const ms = (after.mainMs - before.mainMs) / text.length;
    assert(ms < 1, `${theme}: ${ms} ms/edit exceeds 1ms`);
    await page.waitForTimeout(600);
    const resting = await metrics(page);
    const idleFrames = resting.frames - after.frames;
    if (theme === "coastal") assert(idleFrames > 0 && idleFrames <= 19, "ambient rate capped at 30fps");
    else assert.deepEqual(resting, after, "idle schedules no work");
    assert.equal(await page.locator("[data-decoration-layer]").evaluate(node => node.getAnimations({ subtree: true }).filter(a => a.playState === "running").length), 0);
    results.push({ density, theme, edits: text.length, msPerEdit: ms, browserTaskMsPerEdit,
      drawJsMsPerFrame: theme === "coastal" ? (after.drawMs - before.drawMs) / (after.frames - before.frames) : null,
      maxInputMs: after.maxInputMs, frames: after.frames - before.frames, idleFrames });
  }
  await cdp.detach();
  const coastal = await traceCoastal(page, browser);
  console.log(JSON.stringify({ results, coastal }, null, 2));
  await Bun.write(`.tmp/composer-decorations/measurements-${density}x.json`, JSON.stringify({ results, coastal }, null, 2));
}
