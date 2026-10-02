import { launchSmokeBrowser } from "../support/smoke-browser.ts";
/**
 * Motion verification on the DS Viewer (DS spec Motion Contract):
 * - Chrome traces (CDP tracing) of overlay open/close and 25 chunks/s
 *   streaming; asserts no long task (>50ms) during streaming, CLS ~0, and
 *   reports Layout/Paint work inside overlay animation frames.
 * - M6: AnimatedNumber keeps its width while counting (tabular sizers) and
 *   ProgressMeter fills through transform, never width.
 * - M7: the send flight (QueuedMessage "Send flight" story) travels with a
 *   translate animation whose frames run no Layout and no long task.
 * - Overlay enters: progress of each overlay's enter in the first 60Hz frame
 *   (seeked on the real CSS animation or transition) must be <= 30%.
 * - Thinking mark: working marks run without long tasks and stop drawing when
 *   offscreen or under reduced motion.
 * - Foundations chapter heroes (FoundationHeroMotion): each hero runs only
 *   CSS animations of transform/opacity, holds the frame rate with no long
 *   task and a small main-thread cost per frame, pauses offscreen and in a
 *   hidden tab, and has no animation under reduced motion.
 * - Optional `--video`: Playwright recordings of each motion in light and dark
 *   (with `--only=heroes`: one loop of every chapter hero instead).
 *
 * Usage: bun run tests/smoke/ds-motion-trace.ts [--video] [--out=DIR] [--only=overlays|heroes] [--report-only]
 * Needs a built UI (`npm --prefix packages/butler-app/client/ui run build`).
 */
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, type BrowserContext, type Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";

const root = process.cwd();
const uiRoot = resolve(root, "packages", "butler-app", "client", "ui", "dist");
const outArg = process.argv.find((arg) => arg.startsWith("--out="));
const outDir = resolve(outArg ? outArg.slice("--out=".length) : join(root, ".tmp", "ds-motion"));
const recordVideo = process.argv.includes("--video");
const onlyOverlays = process.argv.includes("--only=overlays");
const onlyHeroes = process.argv.includes("--only=heroes");
/** Report numbers without asserting (used to measure an older build). */
const reportOnly = process.argv.includes("--report-only");
const FIRST_FRAME_MAX = 0.3;
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
      await scope.getByRole("button", { name: "Session actions" }).click();
      await page.waitForTimeout(500);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
    },
  },
  {
    name: "dialog-open-close",
    item: "Dialog",
    run: async (page, scope) => {
      await scope.getByRole("button", { name: "Rename" }).click();
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

type EnterProbe = { name: string; durationMs: number; firstFrame60Hz: number; observedFirstFrame: { ms: number; progress: number } };

/** Watches for the next overlay enter (CSS *-enter animation or the toast opacity transition) and measures it. */
async function armEnterProbe(page: Page) {
  await page.evaluate(() => {
    const state = window as unknown as { __enter: unknown };
    state.__enter = null;
    const existing = new Set(document.getAnimations());
    const started = performance.now();
    const isEnter = (animation: Animation) => {
      if (existing.has(animation)) return false;
      // CSS module keyframe names are hashed (_menu-enter_x1y2_1).
      if (animation instanceof CSSAnimation) return /(?:^|_)(?:menu|context-menu|popover|tooltip|select|dialog)-enter(?:_|$)/u.test(animation.animationName);
      const target = (animation.effect as KeyframeEffect | null)?.target as Element | null;
      return animation instanceof CSSTransition && animation.transitionProperty === "opacity" && Boolean(target?.closest("[data-sonner-toast]"));
    };
    const loop = () => {
      const found = document.getAnimations().find(isEnter);
      if (found && Number(found.currentTime) > 0) {
        const effect = found.effect as KeyframeEffect;
        const element = effect.target as HTMLElement;
        const opacity = () => Number(getComputedStyle(element).opacity);
        const observedMs = Number(found.currentTime);
        const observed = opacity();
        const duration = Number(effect.getComputedTiming().duration);
        found.pause();
        const at = (time: number) => { found.currentTime = time; return opacity(); };
        const from = at(0);
        const to = at(duration - 0.01);
        const frame = at(1000 / 60);
        found.currentTime = observedMs;
        found.play();
        const progress = (value: number) => Math.round(((value - from) / (to - from)) * 1000) / 1000;
        state.__enter = {
          name: found instanceof CSSAnimation ? found.animationName : `transition:${(found as CSSTransition).transitionProperty}`,
          durationMs: Math.round(duration),
          firstFrame60Hz: progress(frame),
          observedFirstFrame: { ms: Math.round(observedMs * 10) / 10, progress: progress(observed) },
        };
        return;
      }
      if (performance.now() - started < 3_000) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}

async function readEnterProbe(page: Page): Promise<EnterProbe | null> {
  await page.waitForFunction(() => (window as unknown as { __enter: unknown }).__enter !== null, undefined, { timeout: 4_000 }).catch(() => undefined);
  return page.evaluate(() => (window as unknown as { __enter: EnterProbe | null }).__enter);
}

const OVERLAY_ENTERS: Array<{ name: string; item: string; story?: string; open: (page: Page, scope: ReturnType<Page["locator"]>) => Promise<void> }> = [
  { name: "menu", item: "DropdownMenu", open: (_page, scope) => scope.getByRole("button", { name: "Session actions" }).click() },
  { name: "contextMenu", item: "ContextMenu", story: "Message copy menu", open: (_page, scope) => scope.locator('[data-state="closed"]').first().click({ button: "right" }) },
  { name: "popover", item: "Popover", story: "Composer access menu", open: (_page, scope) => scope.getByRole("button").first().click() },
  { name: "tooltip", item: "Tooltip", story: "Icon button label", open: (_page, scope) => scope.getByRole("button").first().hover() },
  { name: "select", item: "Select", story: "Default", open: (_page, scope) => scope.getByRole("combobox").first().click() },
  { name: "toast", item: "Toast", story: "Motion", open: (_page, scope) => scope.locator('[data-ds-motion="toast"]').click() },
  { name: "dialog", item: "Dialog", open: (_page, scope) => scope.getByRole("button", { name: "Rename" }).click() },
];

/** First-frame progress of every overlay enter; the first 60Hz frame must carry at most 30% of the change. */
async function measureOverlayEnters(page: Page, serverUrl: string, ids: Map<string, string>) {
  const results: Record<string, EnterProbe | null> = {};
  for (const overlay of OVERLAY_ENTERS) {
    const scope = await openItem(page, serverUrl, ids.get(overlay.item)!, "light", overlay.story);
    await armEnterProbe(page);
    await overlay.open(page, scope);
    results[overlay.name] = await readEnterProbe(page);
    await page.keyboard.press("Escape");
  }
  if (!reportOnly) {
    for (const [name, probe] of Object.entries(results)) {
      assert(probe, `${name} enter animation was not observed`);
      assert(probe.firstFrame60Hz <= FIRST_FRAME_MAX, `${name} enter lands ${Math.round(probe.firstFrame60Hz * 100)}% in the first 60Hz frame (max ${FIRST_FRAME_MAX * 100}%)`);
    }
  }
  return results;
}

/**
 * Thinking mark: working marks draw without long tasks; marks scrolled
 * offscreen and marks under reduced motion stop drawing (counted per canvas).
 */
async function measureThinkingMark(page: Page, serverUrl: string, ids: Map<string, string>) {
  const browser = page.context().browser()!;
  const scope = await openItem(page, serverUrl, ids.get("ButlerThinkingMark")!, "light", "Idle to working");
  await page.evaluate(() => {
    const counts = new Map<HTMLCanvasElement, number>();
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function drawImage(this: CanvasRenderingContext2D, ...args: unknown[]) {
      if (this.canvas.isConnected) counts.set(this.canvas, (counts.get(this.canvas) ?? 0) + 1);
      return (draw as (...values: unknown[]) => void).apply(this, args);
    } as typeof draw;
    (window as unknown as { __markDraws: () => number }).__markDraws = () =>
      [...document.querySelectorAll<HTMLCanvasElement>("[data-ds-thinking-mark-demo] canvas")].reduce((sum, canvas) => sum + (counts.get(canvas) ?? 0), 0);
    (window as unknown as { __perMarkDraws: () => number[] }).__perMarkDraws = () =>
      [...document.querySelectorAll<HTMLCanvasElement>("[data-ds-thinking-mark-demo] canvas")].map((canvas) => counts.get(canvas) ?? 0);
  });
  // Page frame rate and the slowest mark's own frame rate while every mark works.
  const markFps = async (ms: number) => {
    const before = await page.evaluate(() => (window as unknown as { __perMarkDraws: () => number[] }).__perMarkDraws());
    const pageFps = await page.evaluate((span) => new Promise<number>((done) => {
      let frames = 0;
      const start = performance.now();
      const step = () => {
        frames += 1;
        if (performance.now() - start < span) requestAnimationFrame(step);
        else done((frames * 1000) / (performance.now() - start));
      };
      requestAnimationFrame(step);
    }), ms);
    const after = await page.evaluate(() => (window as unknown as { __perMarkDraws: () => number[] }).__perMarkDraws());
    const perMark = after.map((count, index) => ((count - (before[index] ?? 0)) * 1000) / ms);
    return { pageFps: Math.round(pageFps), slowestMarkFps: Math.round(Math.min(...perMark)), marks: perMark.length };
  };
  const draws = () => page.evaluate(() => (window as unknown as { __markDraws: () => number }).__markDraws());
  const drawsOver = async (ms: number) => {
    const before = await draws();
    await page.waitForTimeout(ms);
    return (await draws()) - before;
  };
  await scope.locator('[data-ds-motion="thinking-mark"]').click();
  await page.waitForTimeout(300);
  const { events, thread } = await traced(browser, page, async () => {
    await markNow(page, "mark-start");
    await page.waitForTimeout(2_000);
    await markNow(page, "mark-end");
    return {};
  });
  const working = windowStats(events, thread, markTs(events, "mark-start"), markTs(events, "mark-end"));
  const fps = await markFps(1_000);
  const visibleDrawsPerSecond = await drawsOver(1_000);
  await page.evaluate(() => {
    const demo = document.querySelector("[data-ds-thinking-mark-demo]")!;
    let node: HTMLElement | null = demo.parentElement;
    while (node && node.scrollHeight <= node.clientHeight) node = node.parentElement;
    (node ?? document.scrollingElement!).scrollTop = 1e6;
  });
  await page.waitForTimeout(300);
  const offscreen = await scope.evaluate((story) => {
    const rect = story.querySelector("[data-ds-thinking-mark-demo]")!.getBoundingClientRect();
    return rect.bottom < 0 || rect.top > window.innerHeight;
  });
  const offscreenDrawsPerSecond = await drawsOver(1_000);
  await scope.evaluate((story) => story.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(300);
  await page.evaluate(() => { document.body.dataset.motion = "reduced"; });
  await page.waitForTimeout(300);
  const reducedDrawsPerSecond = await drawsOver(1_000);
  // Control window: the same page with every mark still (reduced motion), to attribute the cost.
  const control = await traced(browser, page, async () => {
    await markNow(page, "still-start");
    await page.waitForTimeout(2_000);
    await markNow(page, "still-end");
    return {};
  });
  const still = windowStats(control.events, control.thread, markTs(control.events, "still-start"), markTs(control.events, "still-end"));
  const markCount = await page.evaluate(() => document.querySelectorAll('[data-mark-state="working"]').length);
  const breathe = await scope.evaluate((story) => story.querySelector("[data-ds-thinking-mark-demo] canvas")?.getAttribute("data-breathe") ?? null);
  await page.evaluate(() => { delete document.body.dataset.motion; });
  assert(working.longTasks === 0, `thinking mark produced ${working.longTasks} task(s) over ${LONG_TASK_MS}ms (max ${working.maxTaskMs}ms)`);
  assert(visibleDrawsPerSecond > 60, `working marks did not animate: ${visibleDrawsPerSecond} draws/s`);
  // Each working mark draws at (about) the 60fps cap and the page keeps its frame rate.
  assert(fps.pageFps >= 50, `thinking marks dropped the page to ${fps.pageFps}fps`);
  assert(fps.slowestMarkFps >= 45, `a working thinking mark drew at only ${fps.slowestMarkFps}fps`);
  assert(offscreen, "the thinking-mark demo did not scroll offscreen");
  assert(offscreenDrawsPerSecond === 0, `offscreen marks kept drawing: ${offscreenDrawsPerSecond} draws/s`);
  assert(reducedDrawsPerSecond === 0, `reduced-motion marks kept drawing: ${reducedDrawsPerSecond} draws/s`);
  assert(breathe === "on", `reduced-motion working marks should breathe in CSS, got ${breathe}`);
  return { workingMarksOnPage: markCount, working, stillControl: still, fps, visibleDrawsPerSecond, offscreenDrawsPerSecond, reducedDrawsPerSecond, reducedBreathe: breathe };
}

/** Chapter heroes by viewer page; Motion lives on its own page. */
const HERO_PAGES: Array<[string, string]> = [
  ["color", "foundations/color"], ["typography", "foundations/typography"], ["spacing", "foundations/spacing"],
  ["sizing", "foundations/sizing"], ["radius", "foundations/radius"], ["iconography", "foundations/iconography"],
  ["focus", "foundations/focus"], ["motion", "motion"], ["z-index", "foundations/z-index"], ["layout", "foundations/layout"],
];
/** What one hero video records: a full loop at the default beat (--motion-deliberate 320ms), capped at 13s except the 64-beat Typography sequence. */
const HERO_VIDEO_MS: Record<string, number> = {
  color: 13_000, typography: 24_400, spacing: 13_000, sizing: 9_800, radius: 11_700,
  iconography: 13_000, focus: 10_400, motion: 13_000, "z-index": 9_800, layout: 10_400,
};
/** Main-thread budget per frame for a playing hero, over a still (reduced-motion) control. */
const HERO_FRAME_BUDGET_MS = 0.5;
/** The Typography feature hero runs a 64-beat, ~75-animation sequence over real components: its budget is 1ms. */
const HERO_FRAME_BUDGET_OVERRIDE_MS: Record<string, number> = { typography: 1 };
/** The Typography specimen draws its outlines (stroke-dashoffset) and moves along the weight axis (font-weight) on one SVG; it may re-lay that text. */
const HERO_SPECIMEN_PROPERTIES: Record<string, string[]> = { typography: ["strokeDashoffset", "fontWeight"] };

async function openHero(page: Page, serverUrl: string, pageId: string, theme: string) {
  await page.goto(viewerUrl(serverUrl, { page: pageId, theme }), { waitUntil: "load" });
  const hero = page.locator('[data-slot="foundation-hero"]').first();
  await hero.waitFor({ state: "visible" });
  await page.waitForTimeout(400);
  return hero;
}

type HeroAnimations = { state: string | null; count: number; running: number; cssOnly: boolean; properties: string[] };

function heroAnimations(hero: ReturnType<Page["locator"]>): Promise<HeroAnimations> {
  return hero.evaluate((node) => {
    const list = node.getAnimations({ subtree: true });
    const properties = new Set<string>();
    for (const animation of list) {
      for (const frame of (animation.effect as KeyframeEffect).getKeyframes()) {
        for (const key of Object.keys(frame)) if (!["offset", "computedOffset", "easing", "composite"].includes(key)) properties.add(key);
      }
    }
    return {
      state: node.getAttribute("data-hero-state"),
      count: list.length,
      running: list.filter((animation) => animation.playState === "running").length,
      cssOnly: list.every((animation) => animation instanceof CSSAnimation),
      properties: [...properties].sort(),
    };
  });
}

async function frameRate(page: Page, ms: number): Promise<number> {
  return page.evaluate((span) => new Promise<number>((done) => {
    let frames = 0;
    const start = performance.now();
    const step = () => {
      frames += 1;
      if (performance.now() - start < span) requestAnimationFrame(step);
      else done((frames * 1000) / (performance.now() - start));
    };
    requestAnimationFrame(step);
  }), ms);
}

/**
 * Every Foundations chapter hero: compositor-friendly CSS only, no long task,
 * frame rate held, main-thread cost per frame over a still control, paused
 * offscreen and in a hidden tab, still under reduced motion.
 */
async function measureHeroes(page: Page, serverUrl: string) {
  const browser = page.context().browser()!;
  const results: Record<string, unknown> = {};
  for (const [variant, pageId] of HERO_PAGES) {
    const hero = await openHero(page, serverUrl, pageId, "light");
    const playingAnimations = await heroAnimations(hero);
    const sample = async (label: string) => {
      const { events, thread } = await traced(browser, page, async () => {
        await markNow(page, `${label}-start`);
        await page.waitForTimeout(2_000);
        await markNow(page, `${label}-end`);
        return {};
      });
      return windowStats(events, thread, markTs(events, `${label}-start`), markTs(events, `${label}-end`));
    };
    // Two windows, the quieter one judged: a one-off task (GC, a font slice
    // landing) is not the hero's per-frame cost.
    const windows = [await sample(`${variant}-playing-a`), await sample(`${variant}-playing-b`)];
    const playing = windows.reduce((best, stats) => (stats.mainThreadBusyPct < best.mainThreadBusyPct ? stats : best));
    const fps = Math.round(await frameRate(page, 1_000));
    await page.evaluate(() => {
      const node = document.querySelector('[data-slot="foundation-hero"]')!;
      let scroller: HTMLElement | null = node.parentElement;
      while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement;
      (scroller ?? document.scrollingElement!).scrollTop = 1e6;
    });
    await page.waitForTimeout(300);
    const offscreen = await heroAnimations(hero);
    await hero.evaluate((node) => node.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(300);
    const hidden = await hero.evaluate(async (node) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const state = node.getAttribute("data-hero-state");
      delete (document as unknown as { visibilityState?: string }).visibilityState;
      document.dispatchEvent(new Event("visibilitychange"));
      return state;
    });
    await page.evaluate(() => { document.body.dataset.motion = "reduced"; });
    await page.waitForTimeout(300);
    const reduced = await heroAnimations(hero);
    const still = await sample(`${variant}-still`);
    await page.evaluate(() => { delete document.body.dataset.motion; });
    const frameCostMs = Math.max(0, Math.round(((playing.mainThreadBusyPct - still.mainThreadBusyPct) / 100) * (1000 / Math.max(fps, 1)) * 100) / 100);
    results[variant] = {
      animations: playingAnimations.count, properties: playingAnimations.properties, fps, frameCostMs,
      playing, still, offscreen: offscreen.state, hidden, reduced: { state: reduced.state, animations: reduced.count },
    };
    if (reportOnly) continue;
    assert(playingAnimations.state === "playing" && playingAnimations.running > 0, `${variant} hero is not playing: ${JSON.stringify(playingAnimations)}`);
    assert(playingAnimations.cssOnly, `${variant} hero runs a non-CSS animation`);
    const allowed = ["transform", "opacity", ...(HERO_SPECIMEN_PROPERTIES[variant] ?? [])];
    assert(playingAnimations.properties.every((property) => allowed.includes(property)),
      `${variant} hero animates ${playingAnimations.properties.join(", ")}; only ${allowed.join(", ")}`);
    assert(windows.every((stats) => stats.longTasks === 0), `${variant} hero produced ${playing.longTasks} task(s) over ${LONG_TASK_MS}ms (max ${playing.maxTaskMs}ms)`);
    // The Motion page runs its own demos; the hero adds no layout beyond the still control.
    // (Frame counts of two 2s windows differ by a frame or two.)
    assert(HERO_SPECIMEN_PROPERTIES[variant] !== undefined || playing.layouts <= still.layouts * 1.05 + 2, `${variant} hero laid out ${playing.layouts} time(s) while playing (${still.layouts} still)`);
    assert(fps >= 50, `${variant} hero dropped the page to ${fps}fps`);
    const budget = HERO_FRAME_BUDGET_OVERRIDE_MS[variant] ?? HERO_FRAME_BUDGET_MS;
    assert(frameCostMs <= budget, `${variant} hero costs ${frameCostMs}ms of main thread per frame (max ${budget}ms)`);
    assert(offscreen.state === "paused" && offscreen.running === 0, `${variant} hero kept running offscreen: ${JSON.stringify(offscreen)}`);
    assert(hidden === "paused", `${variant} hero kept playing in a hidden tab (${hidden})`);
    assert(reduced.state === "still" && reduced.count === 0, `${variant} hero animates under reduced motion: ${JSON.stringify(reduced)}`);
  }
  return results;
}

async function recordHeroVideos(browser: Browser, serverUrl: string): Promise<string[]> {
  const written: string[] = [];
  const staging = join(tempDir, "hero-video");
  for (const theme of ["light", "dark"]) {
    for (const [variant, pageId] of HERO_PAGES) {
      const context = await newContext(browser, staging);
      const page = await context.newPage();
      const hero = await openHero(page, serverUrl, pageId, theme);
      const box = await hero.boundingBox();
      await page.waitForTimeout(HERO_VIDEO_MS[variant] ?? 10_000);
      const video = page.video();
      await context.close();
      const source = await video?.path();
      if (!source) continue;
      const target = join(outDir, `hero-${variant}-${theme}.webm`);
      renameSync(source, target);
      if (box) writeFileSync(`${target}.box.json`, JSON.stringify(box));
      written.push(target);
    }
  }
  return written;
}

async function newContext(browser: Browser, video: string | null): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    ...(video ? { recordVideo: { dir: video, size: viewport } } : {}),
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await server.signIn(context);
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
    ["CrRendererMain", "Chrome_InProcRendererThread"].includes((event.args as { name?: string } | undefined)?.name ?? "") &&
    events.some((other) => other.pid === event.pid && other.tid === event.tid && other.name === "RunTask"));
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
    if (onlyHeroes) {
      results.heroes = await measureHeroes(page, serverUrl);
      return results;
    }
    results.overlayEnter = await measureOverlayEnters(page, serverUrl, ids);
    if (onlyOverlays) return results;
    results.thinkingMark = await measureThinkingMark(page, serverUrl, ids);
    // Overlay open/close: animation windows are the enter/exit token durations
    // after the first rendered frame (the mount frame itself lays out).
    for (const [name, item, trigger] of [
      ["menu", "DropdownMenu", "Session actions"],
      ["dialog", "Dialog", "Rename"],
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
    results.heroes = await measureHeroes(page, serverUrl);
  } finally {
    await context.close();
  }
  return results;
}

assert(existsSync(join(uiRoot, "index.html")), "UI dist is missing; build the UI first.");
mkdirSync(outDir, { recursive: true });
const server = await createNativeAppServer({ uiRoot });
const browser = await launchSmokeBrowser();
try {
  const lookup = await browser.newPage();
  await server.signIn(lookup);
  const ids = await itemIds(lookup, server.url);
  await lookup.close();
  const results = await measure(browser, server.url, ids);
  const summaryPath = join(outDir, "trace-summary.json");
  writeFileSync(summaryPath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
  if (recordVideo) {
    const videos = onlyHeroes ? await recordHeroVideos(browser, server.url) : await recordVideos(browser, server.url, ids);
    console.log(`Recorded ${videos.length} video(s) in ${outDir}`);
  }
} finally {
  await browser.close();
  await server.stop?.();
  rmSync(tempDir, { recursive: true, force: true });
}
