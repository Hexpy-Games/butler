import { launchSmokeBrowser } from "../support/smoke-browser.ts";
// App smoke: complete shipped wallpaper list, cold/reopen navigation, real CDP trace, stub model only.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { endTrace, instrument, navigateAppearance, startTrace, traceStats, settingsReady, toggleMotion } from "./appearance-perf-support.ts";

const out = resolve(Bun.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? ".tmp/appearance-perf");
const reportOnly = Bun.argv.includes("--report-only");
const widths = Bun.argv.includes("--mobile-only") ? [375] : [1280, 375];
const custom = Bun.argv.includes("--custom-only");
mkdirSync(out, { recursive: true });
const server = await createNativeAppServer();
const browser = await launchSmokeBrowser();
writeFileSync(`${out}/environment.json`, JSON.stringify({ browser: browser.version(), viewportHeight: 900, deviceScaleFactor: 1, custom, ownerScale: Bun.argv.includes("--owner-scale") }, null, 2));
const context = await browser.newContext({ reducedMotion: "no-preference" });
const page = await context.newPage();
await instrument(page);
const expected = ["none", "live:butler.bloom", "live:butler.silk", "live:butler.riso-flow", "live:butler.lamina", "live:butler.diatom", "live:butler.dusk", "live:butler.shoreline", "live:butler.photo-clouds", "live:butler.photo-daisies", "live:butler.stipple"];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-slot="wallpaper-picker"]')!;
    const images = [...root.querySelectorAll("img")];
    const state = (window as any).__appearance;
    return {
      ...state, options: [...root.querySelector('[role="radiogroup"]')!.querySelectorAll('[role="radio"]')].map((e) => e.closest("[data-option]")?.getAttribute("data-option")),
      images: images.map((e) => ({ width: e.naturalWidth, height: e.naturalHeight, complete: e.complete })),
      canvases: root.querySelectorAll("canvas").length, videos: root.querySelectorAll("video").length,
      domNodes: root.querySelectorAll("*").length,
      requests: performance.getEntriesByType("resource").map((e) => {
        const r = e as PerformanceResourceTiming;
        return { path: new URL(r.name).pathname, bytes: r.encodedBodySize, transfer: r.transferSize, ms: r.duration, ttfb: r.responseStart - r.requestStart };
      }).filter((r) => !r.path.startsWith("image/")),
    };
  });
}

async function measure(width: number, module: string, tone: string) {
  console.error(`measure ${width} ${module} ${tone}`);
  const params = custom ? (module === "butler.silk" ? { base: "#c9d2c6" } : { billow: 0.5 }) : undefined;
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: tone, wallpaper: { source: { kind: "live", module, params, paramsDark: params }, motion: "auto", pauseOnBattery: false } }) });
  await page.setViewportSize({ width, height: 900 });
  await server.signIn(context);

  await page.goto(server.url, { waitUntil: "load" });
  await page.locator('[data-test-class~="composer-card"]').waitFor();
  console.error("app loaded");
  const menu = page.getByRole("button", { name: "사이드바 보기", exact: true });
  if (await menu.count()) await menu.click();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("button", { name: "모양", exact: true }).waitFor();
  await settingsReady(page);
  console.error("settings loaded");
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const rounds = [];
  for (const round of ["cold", "reopen"]) {
    if (width === 375 && round === "reopen") await page.getByRole("button", { name: "돌아가기", exact: true }).filter({ visible: true }).click();
    await startTrace(cdp);
    const interactiveMs = await navigateAppearance(page);
    await page.waitForFunction(() => document.querySelectorAll('[data-slot="wallpaper-picker"] img').length === 10 && [...document.querySelectorAll<HTMLImageElement>('[data-slot="wallpaper-picker"] img')].every((e) => e.complete && e.naturalWidth > 0));
    const readyMs = await page.evaluate(() => performance.now() - (window as any).__appearance.start);
    await page.waitForTimeout(1000);
    const events = await endTrace(cdp);
    writeFileSync(`${out}/${width}-${module}-${tone}-${round}.trace.json`, JSON.stringify({ traceEvents: events }));
    const data = await snapshot(page);
    const metrics = await cdp.send("Performance.getMetrics");
    const memory = metrics.metrics.find((m) => m.name === "JSHeapUsedSize")!.value;
    const result = { width, module, tone, round, custom, interactiveMs, readyMs, memory, ...traceStats(events), ...data };
    writeFileSync(`${out}/${width}-${module}-${tone}-${round}.json`, JSON.stringify(result, null, 2));
    await startTrace(cdp);
    const toggle = await toggleMotion(page);
    await page.waitForTimeout(100);
    const toggleTrace = traceStats(await endTrace(cdp));
    Object.assign(result, { toggleMs: toggle.ms, toggleTrace });
    assert(toggle.ms <= 150, `Motion toggle took ${toggle.ms}ms`);
    assert(toggleTrace.longTasks.length === 0, `Motion toggle long tasks: ${toggleTrace.longTasks}`);
    assert(await page.getByRole("switch", { name: "움직임", exact: true }).isDisabled(), "Wallpaper motion must be held");
    assert(await page.getByRole("switch", { name: "움직임", exact: true }).getAttribute("aria-checked") === "false", "Wallpaper must show still");
    assert(await page.locator('[data-setting-id="main-screen-battery"]').count() === 0, "Battery field must be hidden");
    await page.waitForFunction(() => document.querySelector('[data-setting-id="reduce-motion"] [role="switch"]')?.getAttribute("aria-checked") === "true");
    await toggleMotion(page);
    await page.waitForFunction(() => document.querySelector('[data-setting-id="main-screen-battery"]'));
    writeFileSync(`${out}/${width}-${module}-${tone}-${round}.json`, JSON.stringify(result, null, 2));
    rounds.push(result);
    assert(JSON.stringify(data.options) === JSON.stringify(expected), `Wallpaper count/order changed: ${JSON.stringify(data.options)}`);
    assert(!data.canvases && !data.videos, "Picker must contain stills only");
    const selected = page.locator('[data-slot="wallpaper-picker"] [role="radiogroup"]').first().getByRole("radio", { checked: true });
    assert(await selected.evaluate((e) => e.closest("[data-option]")?.getAttribute("data-option")) === `live:${module}`, "Latest selection was lost");
    if (custom) {
      assert((await selected.locator("img").getAttribute("src"))?.startsWith("data:image/png"), "Edited params showed the default poster");
      const input = module === "butler.silk" ? page.getByLabel("바탕 색", { exact: true }) : page.getByRole("slider", { name: "구름 움직임", exact: true });
      assert(await input.inputValue() === (module === "butler.silk" ? "#c9d2c6" : "0.5"), "Edited params were lost");
    }
    if (!reportOnly) {
      assert(interactiveMs < 150, `Appearance took ${interactiveMs}ms`);
      assert(result.longTasks.length === 0, `Appearance long tasks: ${result.longTasks}`);
      assert(data.bitmaps.every(([w, h]: number[]) => w <= 960 && h <= 960), "Full resolution thumbnail decode");
      assert(data.images.every((e: { width: number; height: number }) => e.width === 320 && e.height === 200), "Thumbnail dimensions changed");
    }
    // Leave through public settings navigation; reopening must preserve the choice and params.
    if (width === 375) await page.getByRole("button", { name: "돌아가기", exact: true }).filter({ visible: true }).click();
    await page.getByRole("button", { name: "일반", exact: true }).evaluate((e: HTMLElement) => e.click());
  }
  await cdp.detach();
  return rounds;
}

const results = [];
try {
  if (Bun.argv.includes("--owner-scale")) {
    const ids: string[] = [];
    for (let start = 0; start < 600; start += 10) {
      const rows = await Promise.all(Array.from({ length: 10 }, (_, i) => server.api<{ session: { id: string } }>("/sessions", {
        method: "POST", body: JSON.stringify({ kind: "chat", title: `Appearance scale ${start + i}` }),
      })));
      ids.push(...rows.map((row) => row.session.id));
    }
    const navigation = await server.api<{ chats: { id: string }[] }>("/navigation");
    const listed = new Set(navigation.chats.map((chat) => chat.id));
    assert(ids.every((id) => listed.has(id)), "Owner-scale navigation dropped chats");
    console.error(`owner-scale: ${ids.length} complete chat summaries`);
  }
  for (const width of widths) {
    for (const module of ["butler.silk", "butler.photo-clouds"]) {
      for (const tone of ["light", "dark"]) results.push(...await measure(width, module, tone));
    }
  }
  assert(server.stubModelCalls.length === 0, "Appearance must not call a model");
} finally {
  await browser.close();
  await server.stop();
  writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
}
console.log(JSON.stringify(results.map(({ width, module, tone, round, interactiveMs, readyMs, longTasks, maxTaskMs, memory, requests, bitmaps, glDraws, components, commits }) => ({ width, module, tone, round, interactiveMs, readyMs, longTasks, maxTaskMs, heapMB: memory / 1e6, requests, bitmaps, glDraws, components, commits })), null, 2));
