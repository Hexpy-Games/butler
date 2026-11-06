// React side of the DS View state shots (hover, press, focus, click), driven by scenes/ds-view-states.json.
// Output per <size>-<theme>: <out>/react/<size>-<theme>/<page>.<name>.png and <page>.<name>.json {crop, story}.
//   bun ds-view-states.ts --site <dist-ds-site> --out <dir> [--sizes ..] [--themes ..] [--scale 2] [--locale ko] [--only page,page] [--names state,state]
// The crop is the owning story canvas +/- 64 logical px, clipped to the viewport; the gpui side uses the same rule.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";

const args = Bun.argv.slice(2);
const value = (flag: string, fallback?: string) => { const i = args.indexOf(flag); return i < 0 ? fallback : args[i + 1]; };
const site = value("--site");
const output = value("--out");
if (!site || !output) throw new Error("usage: ds-view-states.ts --site <dist-ds-site> --out <dir> [--sizes WxH,..] [--themes light,dark] [--scale 2] [--locale ko|en] [--only page,..]");
const sizes = value("--sizes", "1280x800,390x844")!.split(",");
const themes = value("--themes", "light,dark")!.split(",");
const scale = Number(value("--scale", "2"));
const locale = value("--locale", "ko")!;
const only = value("--only")?.split(",");
const names = value("--names")?.split(",");
const pages = JSON.parse(readFileSync(new URL("./scenes/ds-view.json", import.meta.url), "utf8")).pages as Array<{ page: string; entry: string }>;
/** One step after the opening click: hover, click or key a menu item, press a key, focus a control, or wait. */
type Step = { hover?: [string, number]; click_item?: [string, number]; key?: string; focus?: number; click?: number; move?: [number | "center", number]; scroll?: [number, number]; drag?: [number, number]; release?: boolean; park?: boolean; inset?: number; wait?: number };
type State = { page: string; name: string; state: string; target: number; wait_ms: number; clicks?: number; dx?: number; dy?: number; viewport_height?: number; top?: number; margin?: number; at?: [number, number]; steps?: Step[]; native?: number; native_menu?: string };
const states = (JSON.parse(readFileSync(new URL("./scenes/ds-view-states.json", import.meta.url), "utf8")).states as State[]).filter(s => (!only || only.includes(s.page)) && (!names || names.includes(s.name)));
const root = resolve(site);
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".txt": "text/plain" };
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname === "/" ? "/index.html" : new URL(request.url).pathname;
    const file = Bun.file(join(root, path));
    return file.exists().then(found => found ? new Response(file, { headers: { "content-type": types[extname(path)] ?? "application/octet-stream" } }) : new Response("not found", { status: 404 }));
  },
});
const TALL = 7000;
const MARGIN = 64;
/** The open menu or list of each level, by `data-slot`. */
const MENUS: Record<string, string> = { root: '[data-slot="dropdown-menu-content"], [data-slot="context-menu-content"], [data-slot="select-content"]', sub: '[data-slot="dropdown-menu-sub-content"]' };
const ITEMS = '[role^="menuitem"], [role="option"]';
/** The surfaces a shot reports the geometry of. */
const SURFACES = ['[data-slot="bottom-sheet"]', '[data-slot="popover-content"]', '[data-slot="dialog-content"]', '[data-sonner-toast]', '[data-slot="dropdown-menu-content"]', '[data-slot="context-menu-content"]', '[data-slot="select-content"]'];
const SELECTOR = 'button, [role="button"], [role="radio"], [role="switch"], input:not([type="hidden"]), textarea, select, [tabindex="0"]';
async function shoot(page: import("playwright").Page, s: { page: string; name: string; margin?: number }, story: number, dir: string, width: number, height = TALL) {
  // In a short viewport the crop is in viewport coordinates (the page is scrolled); in the tall one nothing scrolls.
  const scrolled = height === TALL ? "scrollX" : "0", scrolledY = height === TALL ? "scrollY" : "0";
  const canvas = await page.evaluate(`(() => { const b = document.querySelectorAll("[data-ds-fixture-canvas]")[${story}].getBoundingClientRect(); return { x: b.x + ${scrolled}, y: b.y + ${scrolledY}, w: b.width, h: b.height }; })()`) as { x: number; y: number; w: number; h: number };
  const margin = s.margin ?? MARGIN;
  const x0 = Math.max(0, canvas.x - margin), y0 = Math.max(0, canvas.y - margin);
  const x1 = Math.min(width, canvas.x + canvas.w + margin), y1 = Math.min(height, canvas.y + canvas.h + margin);
  const crop = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  await page.screenshot({ path: join(dir, `${s.page}.${s.name}.png`), clip: { x: crop.x, y: crop.y, width: crop.w, height: crop.h } });
  // The open overlay's surface (a portalled popover), in logical px relative to the crop's page, when there is one.
  const overlay = await page.evaluate(`(() => { const box = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x + ${scrolled}, y: b.y + ${scrolledY}, w: b.width, h: b.height }; }; const pick = (sel) => { const all = [...document.querySelectorAll(sel)]; return sel.includes("dialog-content") ? all[all.length - 1] : all[0]; }; const e = ${JSON.stringify(SURFACES)}.map(pick).find(Boolean); const o = box(e); if (o) o.sub = box(document.querySelector(${JSON.stringify(MENUS.sub)})); return o; })()`);
  writeFileSync(join(dir, `${s.page}.${s.name}.json`), JSON.stringify({ crop, story, canvas, overlay }, null, 2));
}
/** An item of the open menu at `level`, in DOM order. */
function item(page: import("playwright").Page, [level, n]: [string, number]) {
  return page.locator(MENUS[level]).locator(ITEMS).nth(n);
}
/** Presses the sheet's grabber row and holds it, moving `dy` px down (negative: up) over `ms` in 16ms frames, as the harness's `dragby` does. */
async function dragHandle(page: import("playwright").Page, dy: number, ms: number) {
  const box = (await page.locator('[data-slot="bottom-sheet-handle"]').last().boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  const frames = Math.max(1, Math.floor(ms / 16));
  for (let n = 1; n <= frames; n++) {
    await page.mouse.move(x, y + dy * n / frames);
    await page.waitForTimeout(ms / frames);
  }
}
async function runSteps(page: import("playwright").Page, steps: Step[]) {
  for (const step of steps) {
    if (step.hover) await item(page, step.hover).hover();
    else if (step.click_item) await item(page, step.click_item).click();
    else if (step.key) await page.keyboard.press(step.key);
    else if (step.focus !== undefined) { await page.keyboard.press("Shift"); await (await page.evaluateHandle(`window.__targets[${step.focus}].el`)).asElement()?.focus(); }
    else if (step.move) await page.mouse.move(step.move[0] === "center" ? (await page.evaluate("innerWidth")) as number / 2 : step.move[0], step.move[1]);
    else if (step.scroll) { const b = (await page.locator('[data-slot="dialog-content"]').first().boundingBox())!; await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.wheel(step.scroll[0], step.scroll[1]); }
    else if (step.drag) await dragHandle(page, step.drag[0], step.drag[1]);
    else if (step.release) await page.mouse.up();
    else if (step.park) await page.mouse.move(1, 1);
    else if (step.inset !== undefined) await page.evaluate(`document.querySelector('[data-slot="bottom-sheet"]').style.setProperty("--sheet-keyboard-inset", "${step.inset}px")`);
    else if (step.click !== undefined) await (await page.evaluateHandle(`window.__targets[${step.click}].el`)).asElement()?.click();
    await page.waitForTimeout(step.wait ?? 250);
  }
}
const browser = await chromium.launch();
try {
  for (const size of sizes) for (const theme of themes) {
    const [width, height] = size.split("x").map(Number);
    const dir = join(resolve(output), "react", `${size}-${theme}`);
    mkdirSync(dir, { recursive: true });
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: theme as "light" | "dark", reducedMotion: "reduce" });
    for (const s of states) {
      const entry = pages.find(p => p.page === s.page)?.entry;
      if (!entry) throw new Error(`unknown page ${s.page}`);
      const page = await context.newPage();
      await page.goto(`http://localhost:${server.port}/?page=${entry}&theme=${theme}&locale=${locale}&motion=reduced`);
      await page.waitForSelector("[data-ds-story]");
      await page.evaluate("document.fonts.ready");
      await page.setViewportSize({ width, height: TALL });
      await page.evaluate("new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))");
      await page.evaluate(`(() => { const seen = new Set(); window.__targets = []; document.querySelectorAll("[data-ds-fixture-canvas]").forEach((c, si) => c.querySelectorAll(${JSON.stringify(SELECTOR)}).forEach(el => { if (!seen.has(el)) { seen.add(el); window.__targets.push({ el, si }); } })); })()`);
      if (s.state === "scroll") {
        // target is the story index; scroll its first edge-fade scroller by (dx, dy).
        await page.evaluate(`(() => { const c = document.querySelectorAll("[data-ds-fixture-canvas]")[${s.target}]; const el = c.querySelector("[data-scroll-fade]"); el.scrollBy(${s.dx ?? 0}, ${s.dy ?? 0}); })()`);
        await page.waitForTimeout(s.wait_ms);
        await shoot(page, s, s.target, dir, width);
        await page.close();
        continue;
      }
      if (s.state === "contextmenu") {
        // target is the story index; `at` the point inside its canvas.
        const box = await page.evaluate(`(() => { const b = document.querySelectorAll("[data-ds-fixture-canvas]")[${s.target}].getBoundingClientRect(); return { x: b.x + scrollX, y: b.y + scrollY }; })()`) as { x: number; y: number };
        await page.mouse.click(box.x + (s.at?.[0] ?? 0), box.y + (s.at?.[1] ?? 0), { button: "right" });
        await page.waitForTimeout(s.wait_ms);
        await runSteps(page, s.steps ?? []);
        await shoot(page, s, s.target, dir, width);
        await page.close();
        continue;
      }
      const handle = await page.evaluateHandle(`window.__targets[${s.target}].el`);
      const element = handle.asElement();
      const story = (await page.evaluate(`window.__targets[${s.target}].si`)) as number;
      if (!element) throw new Error(`${s.page}.${s.name}: target ${s.target} missing`);
      await element.scrollIntoViewIfNeeded();
      const vh = s.viewport_height === -1 ? height : s.viewport_height;
      if (vh) {
        // A short viewport: scroll the owning canvas to `top` px from the window top, so the overlay can collide.
        await page.setViewportSize({ width, height: vh });
        await page.evaluate(`(() => { const c = document.querySelectorAll("[data-ds-fixture-canvas]")[${story}]; const scroller = (() => { for (let e = c.parentElement; e; e = e.parentElement) if (e.scrollHeight > e.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)) return e; return document.scrollingElement; })(); scroller.scrollBy(0, c.getBoundingClientRect().top - ${s.top ?? 0}); })()`);
        await page.evaluate("new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))");
      }
      if (s.state === "hover") await element.hover();
      else if (s.state === "press") { const b = (await element.boundingBox())!; await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down(); }
      else if (s.state === "focus") { await page.keyboard.press("Shift"); await element.focus(); }
      else for (let n = 0; n < (s.clicks ?? 1); n++) { await element.click(); if (n + 1 < (s.clicks ?? 1)) await page.waitForTimeout(700); }
      await page.waitForTimeout(s.state === "press" || s.state === "focus" ? Math.max(150, s.wait_ms) : s.wait_ms);
      await runSteps(page, s.steps ?? []);
      await shoot(page, s, story, dir, width, vh ?? TALL);
      if (s.state === "press") await page.mouse.up();
      await page.close();
    }
    await context.close();
  }
} finally { await browser.close(); server.stop(true); }
