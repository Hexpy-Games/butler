import { instrument, navigateAppearance, settingsReady, toggleMotion, interactionLongTasks, startTrace, endTrace, traceStats } from "./appearance-perf-support";
// Public Settings switch + native persistence; browser DS self-check (stub only).
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createNativeAppServer } from "../support/native-app-server";
import { launchSmokeBrowser } from "../support/smoke-browser";

const out = resolve(Bun.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? ".tmp/reduce-motion");
const scratch = mkdtempSync(join(tmpdir(), "butler-reduce-motion-"));
const uiRoot = join(scratch, "ui");
const butlerData = join(scratch, "data");
cpSync(resolve("packages/butler-app/client/ui/dist"), uiRoot, { recursive: true });
mkdirSync(out, { recursive: true });
const build = await Bun.build({ entrypoints: ["tests/smoke/reduce-motion-probe.ts"], outdir: uiRoot, target: "browser", naming: "probe.js" });
if (!build.success) throw new Error(`Probe build failed: ${build.logs}`);
let server = await createNativeAppServer({ uiRoot, butlerData });
const browser = await launchSmokeBrowser();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "no-preference" });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
const results: unknown[] = [];
const appearanceMs: number[] = [];
const toggles: Awaited<ReturnType<typeof toggleMotion>>[] = [];
await instrument(page);
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

async function appearance() {
  await server.signIn(context);
  await page.goto(server.url);
  await page.locator('[data-test-class~="composer-card"]').waitFor();
  const menu = page.getByRole("button", { name: "사이드바 보기", exact: true });
  if (await menu.count()) await menu.click();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await settingsReady(page);
  await startTrace(cdp);
  appearanceMs.push(await navigateAppearance(page));
  const interval = await page.evaluate(() => ({ start: (window as any).__appearance.start, end: performance.now() }));
  const longTasks = await interactionLongTasks(page, interval.start, interval.end);
  const events = await endTrace(cdp);
  writeFileSync(join(out, `open-${appearanceMs.length}.trace.json`), JSON.stringify({ traceEvents: events }));
  writeFileSync(join(out, `open-${appearanceMs.length}.json`), JSON.stringify({ ...interval, ms: appearanceMs.at(-1), longTasks, trace: traceStats(events) }, null, 2));
  assert(longTasks.length === 0, `Appearance has a task over 50ms: ${JSON.stringify(longTasks)}`);
  await page.getByRole("switch", { name: "동작 줄이기", exact: true }).waitFor();
}

async function timedToggle() {
  const result = await toggleMotion(page);
  toggles.push(result);
  assert(result.ms <= 150, `Toggle exceeded 150ms: ${result.ms}`);
  assert((await interactionLongTasks(page, result.start, result.end)).length === 0, "Toggle has a task over 50ms");
}

async function probe() {
  await page.evaluate(async () => {
    const probeUrl = "/probe.js";
    const module = await import(/* @vite-ignore */ probeUrl);
    (window as any).__motionProbe = module.mountProbe();
  });
}

async function verify(reduced: boolean) {
  await page.waitForFunction((expected) => (window as any).__motionProbe.read().reduced === expected, reduced);
  await page.waitForFunction((expected) => ((window as any).__motionProbe.read().pending === 0) === expected, reduced);
  const data = await page.evaluate(() => (window as any).__motionProbe.read());
  assert(data.distance === (reduced ? 0 : 8), `Wrong travel: ${JSON.stringify(data)}`);
  assert(data.frames.length === 2 && data.duration === 160, "Animation lost opacity frames or token timing");
  assert(data.frames.every((frame: any) => (frame.transform === undefined) === reduced), "Animation must become opacity-only");
  const transition = await page.getByRole("switch", { name: "동작 줄이기", exact: true }).evaluate((node) => getComputedStyle(node.firstElementChild!).transitionDuration);
  assert((transition === "0s") === reduced, `OS CSS rule was not reused: ${transition}`);
  results.push({ ...data, transition });
}

try {
  if (Bun.argv.includes("--owner-scale")) {
    const ids: string[] = [];
    for (let start = 0; start < 600; start += 10) {
      const rows = await Promise.all(Array.from({ length: 10 }, (_, i) => server.api<any>("/sessions", {
        method: "POST", body: JSON.stringify({ kind: "chat", title: `Motion scale ${start + i}` }),
      })));
      ids.push(...rows.map((row) => row.session.id));
    }
    const navigation = await server.api<any>("/navigation");
    const listed = new Set(navigation.chats.map((chat: any) => chat.id));
    assert(ids.every((id) => listed.has(id)), "Owner-scale navigation lost chats");
  }
  // The cached shell must render even when the authoritative request is held.
  await server.signIn(context);
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  await page.route("**/settings", async (route) => { await held; await route.continue(); });
  await page.goto(server.url, { waitUntil: "domcontentloaded" });
  await page.locator('[data-test-class~="app-boot"]').waitFor();
  release();
  await page.locator('[data-test-class~="composer-card"]').waitFor();
  await page.unroute("**/settings", undefined);
  await appearance();
  await probe();
  const toggle = page.getByRole("switch", { name: "동작 줄이기", exact: true });
  assert(await toggle.getAttribute("aria-checked") === "false", "Default must follow OS");
  await verify(false);
  await timedToggle();
  await verify(true);
  assert((await server.api<any>("/settings")).reduce_motion === true, "Switch was not persisted");
  await page.evaluate(() => (window as any).__motionProbe.dispose());
  // Restart both native gateway and page, without a renderer settings cache.
  await server.stop();
  server = await createNativeAppServer({ uiRoot, butlerData });
  await context.clearCookies();
  await page.addInitScript(() => {
    localStorage.clear();
    const observer = new MutationObserver(() => {
      if (!document.querySelector("#root")?.childElementCount) return;
      (window as any).__firstAppMotion = document.getElementById("root")?.dataset.motion;
      observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  await appearance();
  assert(await toggle.getAttribute("aria-checked") === "true", "Restart lost switch");
  assert(await page.evaluate(() => document.getElementById("root")?.dataset.motion) === "reduced", "Server settings were not reconciled before the workspace");
  await probe();
  await verify(true);
  await timedToggle();
  await verify(false);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await verify(true);
  assert(await toggle.getAttribute("aria-checked") === "true" && await toggle.isDisabled(), "OS preference must show on and disabled");
  await toggle.hover();
  await page.getByRole("tooltip").filter({ hasText: "시스템 설정에서 켜져 있습니다" }).waitFor();
  assert((await server.api<any>("/settings")).reduce_motion === false, "OS preference must not rewrite the saved setting");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await verify(false);
  await timedToggle();
  await verify(true);
  await page.evaluate(() => (window as any).__motionProbe.dispose());
  for (const width of [375, 1280]) {
    for (const theme of ["light", "dark"]) {
      await server.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: theme }) });
      await page.setViewportSize({ width, height: 900 });
      await appearance();
      await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('[data-slot="wallpaper-picker"] img')].every((image) => image.complete && image.naturalWidth > 0));
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined))));
      await toggle.evaluate((node) => {
        (node as HTMLElement).focus({ preventScroll: true });
        for (let parent = node.parentElement; parent; parent = parent.parentElement) parent.scrollTop = 0;
      });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await page.screenshot({ path: join(out, `appearance-${width}-${theme}-ko.png`), fullPage: true });
      assert(await toggle.isVisible(), "Motion row missing at viewport");
      const sections = await page.locator('[data-settings-section-id]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-settings-section-id")));
      assert(JSON.stringify(sections) === JSON.stringify(["theme", "sidebar", "home-screen", "accessibility"]), "Appearance section order changed");
      await toggle.scrollIntoViewIfNeeded();
      const fits = await toggle.evaluate((node) => {
        const section = node.closest('[data-settings-section-id="accessibility"]')!.getBoundingClientRect();
        const rect = node.getBoundingClientRect();
        return rect.left >= section.left && rect.right <= section.right && rect.top >= section.top && rect.bottom <= section.bottom;
      });
      assert(fits, "Accessibility switch is outside its section");
      await page.screenshot({ path: join(out, `accessibility-${width}-${theme}-ko.png`), fullPage: true });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Horizontal overflow");
    }
  }
  const options = await page.locator('[data-slot="wallpaper-picker"] [role="radiogroup"]').first().getByRole("radio").count();
  const ordered = await page.locator('[data-slot="wallpaper-picker"] [role="radiogroup"]').first().getByRole("radio").evaluateAll((rows) => rows.map((row) => row.closest("[data-option]")?.getAttribute("data-option")));
  const expected = ["none", "live:butler.bloom", "live:butler.silk", "live:butler.riso-flow", "live:butler.lamina", "live:butler.diatom", "live:butler.dusk", "live:butler.shoreline", "live:butler.photo-clouds", "live:butler.photo-daisies", "live:butler.stipple"];
  assert(JSON.stringify(ordered) === JSON.stringify(expected), "Wallpaper count/order changed");
  assert(await toggle.getAttribute("aria-checked") === "true", "Latest motion setting was lost");
  assert(appearanceMs.every((ms) => ms < 150), `Appearance exceeded 150ms: ${appearanceMs}`);
  writeFileSync(join(out, "appearance-timing.json"), JSON.stringify({ ownerScale: Bun.argv.includes("--owner-scale"), chats: Bun.argv.includes("--owner-scale") ? 600 : null, options, appearanceMs, toggles, maxMs: Math.max(...appearanceMs) }, null, 2));
  assert(server.stubModelCalls.length === 0, "Appearance called a model");
  writeFileSync(join(out, "self-check.json"), JSON.stringify(results, null, 2));
  console.log(`PASS: ${results.length} DS motion states; four KO screenshots; restart persistence; no model calls`);
} finally {
  await browser.close();
  await server.stop();
  rmSync(scratch, { recursive: true, force: true });
}
