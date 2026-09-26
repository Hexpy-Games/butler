/**
 * Motion verification on the DS Viewer (DS spec Motion Contract):
 * - Chrome traces (CDP tracing) of overlay open/close and 25 chunks/s
 *   streaming; asserts no long task (>50ms) during streaming, CLS ~0, and
 *   reports Layout/Paint work inside overlay animation frames.
 * - M6: AnimatedNumber keeps its width while counting (tabular sizers) and
 *   ProgressMeter fills through transform, never width.
 * - M7: the send flight (QueuedMessage "Send flight" story) travels with a
 *   translate animation whose frames run no Layout and no long task.
 * - Optional `--video`: Playwright recordings of each motion in light and dark.
 *
 * Usage: bun run tests/smoke/ds-motion-trace.ts [--video] [--out=DIR]
 * Needs a built UI (`npm --prefix packages/butler-app/client/ui run build`).
 */
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createAppServer } from "../../packages/butler-agent/src/gateways/app/interface/server/create-app-server.ts";

const root = process.cwd();
const uiRoot = resolve(root, "packages", "butler-app", "client", "ui", "dist");
const outArg = Bun.argv.find((arg) => arg.startsWith("--out="));
const outDir = resolve(outArg ? outArg.slice("--out=".length) : join(root, ".tmp", "ds-motion"));
const recordVideo = Bun.argv.includes("--video");
const tempDir = mkdtempSync(join(tmpdir(), "butler-ds-motion-"));
const LONG_TASK_MS = 50;
const viewport = { width: 960, height: 720 };

type TraceEvent = { name: string; cat: string; ph: string; ts: number; dur?: number; pid: number; tid: number; args?: Record<string, unknown> };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function viewerUrl(serverUrl: string, params: Record<string, string>): string {
  return `${serverUrl}?${new URLSearchParams({ visual: "design-system", ...params }).toString()}`;
}

async function itemIds(page: Page, serverUrl: string): Promise<Map<string, string>> {
  const items = new Map<string, string>();
  for (const gallery of ["components", "blocks"]) {
    await page.goto(viewerUrl(serverUrl, { page: gallery }), { waitUntil: "load" });
    await page.locator(`[data-ds-gallery="${gallery}"]`).waitFor({ state: "attached" });
    for (const [name, id] of await page.locator("[data-ds-component]").evaluateAll((elements) =>
      elements.map((element) => [element.getAttribute("data-ds-component"), element.getAttribute("data-ds-item")]))) {
      if (name && id) items.set(name, id);
    }
  }
  return items;
}

async function openItem(page: Page, serverUrl: string, id: string, theme: string, story?: string, extra: Record<string, string> = {}) {
  await page.goto(viewerUrl(serverUrl, { page: id, theme, ...extra }), { waitUntil: "load" });
  const scope = story ? page.locator(`[data-ds-story="${story}"]`) : page.locator("[data-ds-story]").first();
  await scope.waitFor({ state: "visible" });
  // Put the story at the top so growing content (streams, reveals) stays in view.
  await scope.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(250);
  return scope;
}

type Scenario = {
  name: string;
  item: string;
  story?: string;
  run: (page: Page, scope: ReturnType<Page["locator"]>) => Promise<void>;
};

const scenarios: Scenario[] = [
  {
    name: "menu-open-close",
    item: "DropdownMenu",
    run: async (page, scope) => {
      await scope.getByRole("button", { name: "Menu" }).click();
      await page.waitForTimeout(500);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
    },
  },
  {
    name: "dialog-open-close",
    item: "Dialog",
    run: async (page, scope) => {
      await scope.getByRole("button", { name: "Open dialog" }).click();
      await page.waitForTimeout(600);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
    },
  },
  {
    name: "button-press",
    item: "Button",
    story: "Variants",
    run: async (page, scope) => {
      const box = await scope.locator("button").first().boundingBox();
      assert(box, "button is not visible");
      for (let press = 0; press < 3; press += 1) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(220);
        await page.mouse.up();
        await page.waitForTimeout(300);
      }
    },
  },
  {
    name: "switch-toggle",
    item: "Switch",
    run: async (page, scope) => {
      const toggle = scope.getByRole("switch").first();
      for (let flip = 0; flip < 4; flip += 1) {
        await toggle.click();
        await page.waitForTimeout(450);
      }
    },
  },
  {
    name: "send-stream-shimmer",
    item: "MessageRow",
    story: "Send and stream",
    run: async (page, scope) => {
      await scope.locator('[data-ds-motion="send"]').click();
      await page.waitForTimeout(6_500);
    },
  },
  {
    name: "tool-row-expand",
    item: "Collapsible",
    story: "Tool row",
    run: async (page, scope) => {
      const toggle = scope.locator("[aria-expanded]").first();
      await toggle.click();
      await page.waitForTimeout(600);
      await toggle.click();
      await page.waitForTimeout(600);
    },
  },
  {
    name: "copy-morph",
    item: "CopyButton",
    story: "Copy and confirm",
    run: async (page, scope) => {
      await scope.locator("button").first().click();
      await page.waitForTimeout(2_000);
    },
  },
  {
    name: "animated-number",
    item: "MetricCard",
    story: "Counting values",
    run: async (page, scope) => {
      for (let round = 0; round < 3; round += 1) {
        await scope.locator('[data-ds-motion="replay"]').click();
        await page.waitForTimeout(900);
      }
    },
  },
  {
    name: "progress-fill",
    item: "ProgressMeter",
    story: "Fill change",
    run: async (page, scope) => {
      for (let round = 0; round < 3; round += 1) {
        await scope.locator('[data-ds-motion="replay"]').click();
        await page.waitForTimeout(800);
      }
    },
  },
  {
    name: "send-flight",
    item: "QueuedMessage",
    story: "Send flight",
    run: async (page, scope) => {
      for (const trigger of ["send-flight", "send-flight-queued", "send-flight-fallback"]) {
        await scope.locator(`[data-ds-motion="${trigger}"]`).click();
        await page.waitForTimeout(900);
      }
    },
  },
  {
    name: "queued-delivery",
    item: "QueuedMessage",
    story: "Delivery",
    run: async (page, scope) => {
      await scope.locator('[data-ds-motion="replay"]').click();
      await page.waitForTimeout(1_400);
    },
  },
  {
    name: "worker-complete",
    item: "WorkerActivityRow",
    story: "Completes",
    run: async (page, scope) => {
      for (let round = 0; round < 2; round += 1) {
        await scope.locator('[data-ds-motion="replay"]').click();
        await page.waitForTimeout(1_400);
      }
    },
  },
];

/** Samples AnimatedNumber widths while it counts; every sample must match. */
async function measureNumberAndMeter(page: Page, serverUrl: string, ids: Map<string, string>) {
  const scope = await openItem(page, serverUrl, ids.get("MetricCard")!, "light", "Counting values");
  const widths = await scope.evaluate(async (story) => {
    const numbers = [...story.querySelectorAll('[data-slot="animated-number"]')];
    (story.querySelector('[data-ds-motion="replay"]') as HTMLElement).click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const samples: number[][] = [];
    const start = performance.now();
    while (performance.now() - start < 420) {
      samples.push(numbers.map((node) => node.getBoundingClientRect().width));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return samples;
  });
  const jitter = Math.max(...widths[0]!.map((_, index) => {
    const column = widths.map((row) => row[index]!);
    return Math.max(...column) - Math.min(...column);
  }));
  const meter = await openItem(page, serverUrl, ids.get("ProgressMeter")!, "light", "Fill change");
  const fill = await meter.evaluate((story) => {
    const node = story.querySelector('[data-slot="progress-fill"]') as HTMLElement;
    const style = getComputedStyle(node);
    return { transitionProperty: style.transitionProperty, transform: style.transform, inlineWidth: node.style.width };
  });
  assert(widths.length > 5, "AnimatedNumber width was not sampled");
  assert(jitter <= 0.5, `AnimatedNumber width changed by ${jitter}px while counting`);
  assert(fill.transitionProperty === "transform" && fill.inlineWidth === "", `ProgressMeter fill must animate transform only: ${JSON.stringify(fill)}`);
  return { animatedNumberWidthJitterPx: Math.round(jitter * 100) / 100, samples: widths.length, progressFill: fill };
}

/**
 * M7 send flight: the sent bubble flies from the composer with a WAAPI
 * translate. Its travel frames (after the mount and retarget frames) must stay
 * on the compositor: no long task, no Layout or Paint, and it must travel.
 */
async function measureSendFlight(page: Page, serverUrl: string, ids: Map<string, string>) {
  const browser = page.context().browser()!;
  const scope = await openItem(page, serverUrl, ids.get("QueuedMessage")!, "light", "Send flight");
  const rounds = 3;
  const { events, thread } = await traced(browser, page, async () => {
    for (let round = 0; round < rounds; round += 1) {
      // The window is anchored on the click itself: the mark and a
      // programmatic click (which keeps the pointer and the send tooltip out
      // of the frames) run in one task. A mark from a separate evaluate
      // landed 4-50ms before the click depending on load, sliding the
      // mount/retarget frames into the judged window (the old flake).
      await scope.evaluate((story, label) => {
        performance.mark(label);
        (story.querySelector('[data-ds-motion="send-flight"]') as HTMLElement).click();
      }, `flight-${round}`);
      await page.waitForTimeout(700);
    }
    return {};
  });
  const travel = await scope.evaluate(async (story) => {
    const button = story.querySelector('[data-ds-motion="send-flight"]') as HTMLElement;
    button.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const bubbles = story.querySelectorAll('[data-ds-motion="send-flight-list"] [data-test-class="message-body"]');
    const bubble = bubbles[bubbles.length - 1] as HTMLElement;
    const first = bubble.getBoundingClientRect();
    await new Promise((resolve) => setTimeout(resolve, 600));
    const last = bubble.getBoundingClientRect();
    return {
      flying: bubble.closest("article")?.getAttribute("data-enter") ?? null,
      travelledPx: Math.round(Math.hypot(first.left - last.left, first.top - last.top)),
    };
  });
  const windows = Array.from({ length: rounds }, (_, round) => {
    const start = markTs(events, `flight-${round}`);
    // Skip the mount and retarget frames (sendFlight bounds retargeting to
    // 64ms, whatever the frame rate) and the final ~40ms, where Chromium hands
    // the finishing animation back to the main thread; judge the travel
    // frames in between. The bubble starts
    // right-aligned to the composer text, so travel is mostly vertical and
    // can use the shorter --motion-slow (220ms) flight.
    return windowStats(events, thread, start + 80_000, start + 160_000);
  });
  const whole = windowStats(events, thread, markTs(events, "flight-0"), markTs(events, `flight-${rounds - 1}`) + 700_000);
  const mainThreadFrames = windows.reduce((sum, stats) => sum + stats.layouts + stats.paints, 0);
  assert(whole.longTasks === 0, `send flight produced ${whole.longTasks} task(s) over ${LONG_TASK_MS}ms (max ${whole.maxTaskMs}ms)`);
  assert(mainThreadFrames === 0, `send flight travel frames ran Layout/Paint ${mainThreadFrames} time(s); it must run on the compositor`);
  assert(travel.flying === "fly" && travel.travelledPx > 20, `send flight did not run: ${JSON.stringify(travel)}`);
  return { animationFrames: windows, whole, travel };
}

async function newContext(browser: Browser, video: string | null): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    ...(video ? { recordVideo: { dir: video, size: viewport } } : {}),
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  return context;
}

async function recordVideos(browser: Browser, serverUrl: string, ids: Map<string, string>): Promise<string[]> {
  const written: string[] = [];
  const staging = join(tempDir, "video");
  for (const theme of ["light", "dark"]) {
    for (const scenario of scenarios) {
      const id = ids.get(scenario.item);
      assert(id, `DS Viewer has no ${scenario.item} item`);
      const context = await newContext(browser, staging);
      const page = await context.newPage();
      const scope = await openItem(page, serverUrl, id, theme, scenario.story);
      await scenario.run(page, scope);
      const video = page.video();
      await context.close();
      const source = await video?.path();
      if (!source) continue;
      const target = join(outDir, `${scenario.name}-${theme}.webm`);
      renameSync(source, target);
      written.push(target);
    }
  }
  return written;
}

function mainThread(events: TraceEvent[]): { pid: number; tid: number } {
  const meta = events.find((event) => event.ph === "M" && event.name === "thread_name" &&
    (event.args as { name?: string } | undefined)?.name === "CrRendererMain" &&
    events.some((other) => other.pid === event.pid && other.name === "RunTask"));
  assert(meta, "trace has no renderer main thread");
  return { pid: meta.pid, tid: meta.tid };
}

type WindowStats = {
  windowMs: number;
  longTasks: number;
  maxTaskMs: number;
  mainThreadBusyPct: number;
  layouts: number;
  layoutMs: number;
  paints: number;
  paintMs: number;
  styleRecalcs: number;
};

function windowStats(events: TraceEvent[], thread: { pid: number; tid: number }, from: number, to: number): WindowStats {
  const inWindow = events.filter((event) => event.pid === thread.pid && event.tid === thread.tid &&
    event.ph === "X" && event.ts >= from && event.ts <= to);
  const tasks = inWindow.filter((event) => event.name === "RunTask").map((event) => (event.dur ?? 0) / 1000);
  const total = (name: string) => Math.round(inWindow.filter((event) => event.name === name)
    .reduce((sum, event) => sum + (event.dur ?? 0) / 1000, 0) * 10) / 10;
  const windowMs = (to - from) / 1000;
  return {
    windowMs: Math.round(windowMs),
    longTasks: tasks.filter((duration) => duration > LONG_TASK_MS).length,
    maxTaskMs: Math.round(Math.max(0, ...tasks) * 10) / 10,
    mainThreadBusyPct: Math.round((tasks.reduce((sum, duration) => sum + duration, 0) / windowMs) * 1000) / 10,
    layouts: inWindow.filter((event) => event.name === "Layout").length,
    layoutMs: total("Layout"),
    paints: inWindow.filter((event) => event.name === "Paint").length,
    paintMs: total("Paint"),
    styleRecalcs: inWindow.filter((event) => event.name === "UpdateLayoutTree").length,
  };
}

async function traced(browser: Browser, page: Page, action: () => Promise<Record<string, [number, number]>>) {
  await browser.startTracing(page, {
    categories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "toplevel", "blink.user_timing"],
  });
  const marks = await action();
  const buffer = await browser.stopTracing();
  const events = (JSON.parse(buffer.toString("utf8")) as { traceEvents: TraceEvent[] }).traceEvents;
  return { events, thread: mainThread(events), marks };
}

/** Page-clock (performance.now) ms converted to trace microseconds via a user-timing mark. */
async function markNow(page: Page, name: string): Promise<void> {
  await page.evaluate((label) => performance.mark(label), name);
}

function markTs(events: TraceEvent[], name: string): number {
  const mark = events.find((event) => event.name === name && event.cat.includes("user_timing"));
  assert(mark, `trace is missing mark ${name}`);
  return mark.ts;
}

async function measureStream(page: Page, serverUrl: string, ids: Map<string, string>, withFade: boolean) {
  const browser = page.context().browser()!;
  const scope = await openItem(page, serverUrl, ids.get("MessageRow")!, "light", "Send and stream",
    withFade ? {} : { "ds-stream-reveal": "off" });
  // Count only shifts of nodes inside the story: the viewer's README below the
  // story moves down as any streamed answer grows, which is not a jump.
  await scope.evaluate((story) => {
    const state = window as unknown as { __cls: number };
    state.__cls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
        sources?: Array<{ node?: Node | null }>;
      }>) {
        const inStory = (entry.sources ?? []).some((source) => source.node && story.contains(source.node));
        if (!entry.hadRecentInput && inStory) state.__cls += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: false });
  });
  const { events, thread } = await traced(browser, page, async () => {
    await scope.locator('[data-ds-motion="send"]').click();
    await page.waitForTimeout(1_150);
    await markNow(page, "stream-start");
    await page.waitForTimeout(4_000);
    await markNow(page, "stream-end");
    await page.waitForTimeout(1_000);
    return {};
  });
  const settledChunkSpans = await page.locator('[data-ds-motion="stream"] span[style*="animation-delay"]').count();
  const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
  const stats = windowStats(events, thread, markTs(events, "stream-start"), markTs(events, "stream-end"));
  return { ...stats, cls: Math.round(cls * 10_000) / 10_000, settledChunkSpans };
}

async function measure(browser: Browser, serverUrl: string, ids: Map<string, string>) {
  const context = await newContext(browser, null);
  const page = await context.newPage();
  const results: Record<string, unknown> = {};
  try {
    // Overlay open/close: animation windows are the enter/exit token durations
    // after the first rendered frame (the mount frame itself lays out).
    for (const [name, item, trigger] of [
      ["menu", "DropdownMenu", "Menu"],
      ["dialog", "Dialog", "Open dialog"],
    ] as const) {
      const scope = await openItem(page, serverUrl, ids.get(item)!, "light");
      const { events, thread } = await traced(browser, page, async () => {
        await markNow(page, `${name}-open`);
        await scope.getByRole("button", { name: trigger }).click();
        await page.waitForTimeout(400);
        await markNow(page, `${name}-close`);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
        await markNow(page, `${name}-end`);
        return {};
      });
      const open = markTs(events, `${name}-open`);
      const close = markTs(events, `${name}-close`);
      const end = markTs(events, `${name}-end`);
      // Skip the input + mount frames (~2 frames) before judging animation frames.
      const settle = 40_000;
      results[name] = {
        openAnimation: windowStats(events, thread, open + settle, open + settle + 120_000),
        closeAnimation: windowStats(events, thread, close + settle, close + settle + 90_000),
        whole: windowStats(events, thread, open, end),
      };
    }

    // Streaming: 25 chunks/s markdown with the chunk fade, plus the thinking
    // shimmer. A control run without the chunk fade attributes the cost.
    const fade = await measureStream(page, serverUrl, ids, true);
    const control = await measureStream(page, serverUrl, ids, false);
    results.streaming = { ...fade, chunksPerSecond: 25 };
    results.streamingWithoutChunkFade = control;
    results.chunkFadeCost = {
      mainThreadBusyPct: Math.round((fade.mainThreadBusyPct - control.mainThreadBusyPct) * 10) / 10,
      layoutMs: Math.round((fade.layoutMs - control.layoutMs) * 10) / 10,
      paintMs: Math.round((fade.paintMs - control.paintMs) * 10) / 10,
      cls: Math.round((fade.cls - control.cls) * 10_000) / 10_000,
    };
    assert(fade.longTasks === 0, `streaming produced ${fade.longTasks} task(s) over ${LONG_TASK_MS}ms (max ${fade.maxTaskMs}ms)`);
    // Streamed text reflows as words wrap; the fade itself must add no shift.
    assert(fade.cls - control.cls < 0.01, `chunk fade adds layout shift: ${fade.cls} vs ${control.cls} without it`);
    assert(fade.settledChunkSpans === 0, "settled streamed text should render without chunk spans");
    results.m6 = await measureNumberAndMeter(page, serverUrl, ids);
    results.sendFlight = await measureSendFlight(page, serverUrl, ids);
  } finally {
    await context.close();
  }
  return results;
}

assert(existsSync(join(uiRoot, "index.html")), "UI dist is missing; build the UI first.");
mkdirSync(outDir, { recursive: true });
const server = createAppServer({
  dbPath: join(tempDir, "ds-motion.sqlite"),
  butlerData: tempDir,
  uiRoot,
  port: 0,
  bridgeMode: "external",
});
const browser = await chromium.launch({ headless: true });
try {
  const lookup = await browser.newPage();
  const ids = await itemIds(lookup, server.url);
  await lookup.close();
  const results = await measure(browser, server.url, ids);
  const summaryPath = join(outDir, "trace-summary.json");
  writeFileSync(summaryPath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
  if (recordVideo) {
    const videos = await recordVideos(browser, server.url, ids);
    console.log(`Recorded ${videos.length} video(s) in ${outDir}`);
  }
} finally {
  await browser.close();
  await server.stop?.();
  rmSync(tempDir, { recursive: true, force: true });
}
