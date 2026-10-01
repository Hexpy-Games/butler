import type { CDPSession, Page } from "playwright";

export type TraceEvent = { name: string; ph: string; ts: number; dur?: number; pid: number; tid: number; args?: { name?: string; data?: { used_bytes?: number } } };

/** Capture real renderer work, including GPU readbacks and image decodes. */
export async function startTrace(cdp: CDPSession) {
  await cdp.send("Tracing.start", {
    categories: "devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,toplevel",
    transferMode: "ReturnAsStream",
  });
}

export async function endTrace(cdp: CDPSession): Promise<TraceEvent[]> {
  const completed = new Promise<string>((resolve, reject) => cdp.once("Tracing.tracingComplete", (event) => {
    if (event.stream) resolve(event.stream);
    else reject(new Error("Missing trace stream"));
  }));
  await cdp.send("Tracing.end");
  const handle = await completed;
  let json = "";
  for (;;) {
    const chunk = await cdp.send("IO.read", { handle });
    json += chunk.data;
    if (chunk.eof) break;
  }
  await cdp.send("IO.close", { handle });
  return JSON.parse(json).traceEvents;
}

export function traceStats(events: TraceEvent[]) {
  const thread = events.find((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain");
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
    const state = { components: 0, commits: 0, bitmaps: [] as number[][], glDraws: 0, start: 0, interactive: 0 };
    (window as any).__appearance = state;
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
