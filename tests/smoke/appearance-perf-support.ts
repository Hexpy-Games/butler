import type { CDPSession, Page } from "playwright";

export type TraceEvent = { name: string; ph: string; ts: number; dur?: number; pid: number; tid: number; args?: { name?: string; data?: { used_bytes?: number } } };

type TracePacket = { value: Record<string, string>[] };
const traces = new WeakMap<CDPSession, { events: TraceEvent[]; collect: (chunk: TracePacket) => void }>();

/** Capture complete trace packets; single-process Chromium can stall IO.read streams. */
export async function startTrace(cdp: CDPSession) {
  const events: TraceEvent[] = [];
  const collect = (chunk: TracePacket) => { for (const event of chunk.value) events.push(event as unknown as TraceEvent); };
  traces.set(cdp, { events, collect });
  cdp.on("Tracing.dataCollected", collect);
  await cdp.send("Tracing.start", {
    categories: "devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,toplevel",
    transferMode: "ReportEvents",
  });
}

export async function endTrace(cdp: CDPSession): Promise<TraceEvent[]> {
  const trace = traces.get(cdp);
  if (!trace) throw new Error("No appearance trace started");
  const completed = new Promise<void>((done) => cdp.once("Tracing.tracingComplete", () => done()));
  await cdp.send("Tracing.end");
  await completed;
  cdp.off("Tracing.dataCollected", trace.collect);
  traces.delete(cdp);
  return trace.events;
}

export function traceStats(events: TraceEvent[]) {
  const thread = events.find((e) => e.name === "thread_name" && ["CrRendererMain", "Chrome_InProcRendererThread"].includes(e.args?.name ?? ""));
  if (!thread) throw new Error("Missing renderer main thread");
  const main = events.filter((e) => e.pid === thread.pid && e.tid === thread.tid && e.ph === "X");
  const sum = (names: string[]) => main.filter((e) => names.includes(e.name)).reduce((n, e) => n + (e.dur ?? 0) / 1000, 0);
  const tasks = main.filter((e) => e.name === "RunTask").map((e) => (e.dur ?? 0) / 1000);
  return {
    scriptingMs: sum(["FunctionCall", "EvaluateScript"]), layoutMs: sum(["Layout", "UpdateLayoutTree"]),
    paintMs: sum(["Paint", "PrePaint"]), decodeMs: sum(["Decode Image", "ImageDecodeTask"]),
    decodeOffThreadMs: events.filter((e) => e.ph === "X" && e.name === "Decode Image" && e.tid !== thread.tid)
      .reduce((n, e) => n + (e.dur ?? 0) / 1000, 0),
    gpuReportedPeakBytes: Math.max(0, ...events.map((e) => e.args?.data?.used_bytes ?? 0)) || null,
    longTasks: tasks.filter((ms) => ms > 50), maxTaskMs: Math.max(0, ...tasks),
  };
}

/** Observe React fibers without changing the production bundle. No private content is exported. */
export async function instrument(page: Page) {
  await page.addInitScript(() => {
    const state = { components: 0, commits: 0, bitmaps: [] as number[][], glDraws: 0, start: 0, interactive: 0, observedLongTasks: [] as { start: number; duration: number }[] };
    (window as any).__appearance = state;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) state.observedLongTasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ type: "longtask", buffered: true });
    (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true, inject: () => 1, onCommitFiberUnmount: () => {},
      onCommitFiberRoot: (_id: number, root: any) => {
        let components = 0;
        const walk = (fiber: any) => {
          if (!fiber) return;
          if (typeof fiber.type === "function") components++;
          walk(fiber.child); walk(fiber.sibling);
        };
        walk(root.current);
        state.components = components;
        if (state.start) state.commits++;
      },
    };
    const bitmap = window.createImageBitmap.bind(window);
    window.createImageBitmap = (async (...args: any[]) => {
      const image = await (bitmap as any)(...args);
      if (state.start) state.bitmaps.push([image.width, image.height]);
      return image;
    }) as typeof window.createImageBitmap;
    const draw = WebGL2RenderingContext.prototype.drawArrays;
    WebGL2RenderingContext.prototype.drawArrays = function (...args) {
      if (state.start) state.glDraws++;
      return draw.apply(this, args);
    };
  });
}

/** Click and wait for a painted, focusable picker; also report when every still is ready. */
export async function navigateAppearance(page: Page) {
  return page.getByRole("button", { name: "모양", exact: true }).evaluate(async (button) => {
    const state = (window as any).__appearance;
    Object.assign(state, { start: performance.now(), commits: 0, bitmaps: [], glDraws: 0 });
    performance.clearResourceTimings();
    (button as HTMLElement).click();
    while (!document.querySelector('[data-slot="wallpaper-picker"] [role="radio"]')) {
      await new Promise(requestAnimationFrame);
    }
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const radio = document.querySelector('[data-slot="wallpaper-picker"] [role="radio"]') as HTMLElement;
    radio.focus();
    if (document.activeElement !== radio) throw new Error("Picker cannot receive focus");
    state.interactive = performance.now() - state.start;
    return state.interactive;
  });
}

/** Settings is mounted and ready before timing the Appearance interaction. */
export async function settingsReady(page: Page) {
  await page.locator('[data-setting-id="language"]').waitFor({ state: "attached" });
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

/** Includes immediate control commit, deferred shell scope, and the following paint. */
export async function toggleMotion(page: Page) {
  const control = page.getByRole("switch", { name: "동작 줄이기", exact: true });
  await page.bringToFront();
  await control.scrollIntoViewIfNeeded();
  const persisted = page.waitForResponse((response) => response.url().endsWith("/settings") && response.request().method() === "PATCH");
  const switched = control.evaluate(async (node: HTMLElement) => {
    const rect = node.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > innerHeight || document.visibilityState !== "visible") {
      throw new Error("Motion interaction requires a visible switch");
    }
    const start = performance.now();
    const next = node.getAttribute("aria-checked") !== "true";
    return new Promise<{ ms: number; start: number; end: number; checked: boolean }>((done, reject) => {
      let frame = 0;
      const deadline = setTimeout(() => {
        cancelAnimationFrame(frame);
        reject(new Error(JSON.stringify({ message: "Motion toggle exceeded 150ms",
          checked: node.getAttribute("aria-checked"), disabled: node.hasAttribute("disabled"),
          connected: node.isConnected, visibility: document.visibilityState,
          motion: document.getElementById("root")?.dataset.motion,
        })));
      }, 150);
      const check = () => {
        if ((node.getAttribute("aria-checked") === "true") !== next ||
          (document.getElementById("root")?.dataset.motion === "reduced") !== next) {
          frame = requestAnimationFrame(check);
          return;
        }
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => {
            clearTimeout(deadline);
            done({ ms: performance.now() - start, start, end: performance.now(), checked: next });
          });
        });
      };
      node.click();
      frame = requestAnimationFrame(check);
    });
  });
  const [result, response] = await Promise.all([switched, persisted]);
  if (!response.ok()) throw new Error("Motion persistence failed");
  return result;
}

export async function interactionLongTasks(page: Page, start: number, end: number) {
  // Give the observer its delivery turn; the measured interval stays unchanged.
  await page.waitForTimeout(60);
  return page.evaluate(({ start, end }) => (window as any).__appearance.observedLongTasks
    .filter((task: { start: number; duration: number }) => task.start < end && task.start + task.duration > start), { start, end });
}
