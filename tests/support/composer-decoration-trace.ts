import assert from "node:assert/strict";
import type { Browser, Page } from "playwright";

type TraceEvent = { name: string; ph: string; ts: number; dur?: number; pid: number; tid: number; args?: { name?: string } };

/** Warm, no-input windows. CDP process CPU includes all browser threads, not just input JS. */
export async function traceCoastal(page: Page, browser: Browser) {
  const session = await browser.newBrowserCDPSession();
  const system = await session.send("SystemInfo.getInfo");
  const cpu = async () => {
    const { processInfo } = await session.send("SystemInfo.getProcessInfo");
    return [...new Map(processInfo.map(p => [p.id, p.cpuTime])).values()].reduce((a, b) => a + b, 0);
  };
  const snapshots = () => page.locator("[data-decoration-perf]").evaluate(node => JSON.parse((node as HTMLElement).dataset.metrics!) as {
    frames: number; drawMs: number; gpuMs: number; gpuSamples: number;
  });
  const windows = [];
  const draft = await page.getByRole("textbox", { name: "Try your message" }).inputValue();
  for (const mode of ["static", "interactive"]) {
    await page.getByLabel("Mode", { exact: true }).selectOption(mode);
    await page.waitForTimeout(1200);
    const events: TraceEvent[] = [];
    const collect = ({ value }: { value: unknown[] }) => { events.push(...value as TraceEvent[]); };
    session.on("Tracing.dataCollected", collect);
    await session.send("Tracing.start", { categories: "toplevel,devtools.timeline,cc,gpu", transferMode: "ReportEvents" });
    const before = await snapshots();
    const cpuBefore = await cpu();
    const start = performance.now();
    await page.waitForTimeout(3000);
    const elapsed = performance.now() - start;
    const cpuSeconds = (await cpu()) - cpuBefore;
    const after = await snapshots();
    const complete = new Promise<void>(resolve => session.once("Tracing.tracingComplete", () => resolve()));
    await session.send("Tracing.end"); await complete;
    session.off("Tracing.dataCollected", collect);
    const frames = after.frames - before.frames;
    if (mode === "static") assert.equal(frames, 0, "static trace has no draws");
    else assert(frames > 0 && frames <= elapsed / 1000 * 30 + 1, "ambient draw rate is bounded");
    assert.equal(await page.getByRole("textbox", { name: "Try your message" }).inputValue(), draft);
    assert.equal(await page.locator("canvas").getAttribute("data-error"), null);
    const main = events.find(e => e.name === "thread_name" && (e.args?.name === "CrRendererMain" || e.args?.name === "Chrome_InProcRendererThread"));
    const mainTasks = events.filter(e => e.ph === "X" && (e.name === "RunTask" || e.name === "ThreadControllerImpl::RunTask") && e.pid === main?.pid && e.tid === main?.tid);
    const mainTaskMs = mainTasks.reduce((sum, e) => sum + (e.dur ?? 0), 0) / 1000;
    windows.push({ mode, elapsedMs: elapsed, frames, fps: frames / elapsed * 1000,
      browserCpuPercentOneCore: cpuSeconds / (elapsed / 1000) * 100,
      browserCpuMsPerDraw: frames ? cpuSeconds * 1000 / frames : null,
      tracedMainTaskMsPerDraw: frames && mainTasks.length ? mainTaskMs / frames : null,
      drawJsMsPerFrame: frames ? (after.drawMs - before.drawMs) / frames : null,
      gpuQueryMsPerDraw: after.gpuSamples > before.gpuSamples ? (after.gpuMs - before.gpuMs) / (after.gpuSamples - before.gpuSamples) : null });
    await Bun.write(`.tmp/composer-decorations/coastal-${mode}-trace.json`, JSON.stringify({ traceEvents: events }));
  }
  await session.detach();
  return { devices: system.gpu.devices, renderer: system.gpu.auxAttributes?.glRenderer, windows,
    scope: "Single-process headless Chromium on this Mac; total process CPU includes tracing/automation. GPU query covers shader draw only; full-frame presentation/GPU and system power are not inferred." };
}
