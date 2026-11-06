// React side of the DS View state shots (hover, press, focus, click), driven by scenes/ds-view-states.json.
// Output per <size>-<theme>: <out>/react/<size>-<theme>/<page>.<name>.png and <page>.<name>.json {crop, story}.
//   bun ds-view-states.ts --site <dist-ds-site> --out <dir> [--sizes ..] [--themes ..] [--scale 2] [--locale ko] [--only page,page]
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
const pages = JSON.parse(readFileSync(new URL("./scenes/ds-view.json", import.meta.url), "utf8")).pages as Array<{ page: string; entry: string }>;
const states = (JSON.parse(readFileSync(new URL("./scenes/ds-view-states.json", import.meta.url), "utf8")).states as Array<{ page: string; name: string; state: string; target: number; wait_ms: number; clicks?: number; dx?: number; dy?: number }>).filter(s => !only || only.includes(s.page));
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
const SELECTOR = 'button, [role="button"], [role="radio"], [role="switch"], input[type="range"], [tabindex="0"]';
async function shoot(page: import("playwright").Page, s: { page: string; name: string }, story: number, dir: string, width: number) {
  const canvas = await page.evaluate(`(() => { const b = document.querySelectorAll("[data-ds-fixture-canvas]")[${story}].getBoundingClientRect(); return { x: b.x + scrollX, y: b.y + scrollY, w: b.width, h: b.height }; })()`) as { x: number; y: number; w: number; h: number };
  const x0 = Math.max(0, canvas.x - MARGIN), y0 = Math.max(0, canvas.y - MARGIN);
  const x1 = Math.min(width, canvas.x + canvas.w + MARGIN), y1 = Math.min(TALL, canvas.y + canvas.h + MARGIN);
  const crop = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  await page.screenshot({ path: join(dir, `${s.page}.${s.name}.png`), clip: { x: crop.x, y: crop.y, width: crop.w, height: crop.h } });
  writeFileSync(join(dir, `${s.page}.${s.name}.json`), JSON.stringify({ crop, story }, null, 2));
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
      const handle = await page.evaluateHandle(`window.__targets[${s.target}].el`);
      const element = handle.asElement();
      const story = (await page.evaluate(`window.__targets[${s.target}].si`)) as number;
      if (!element) throw new Error(`${s.page}.${s.name}: target ${s.target} missing`);
      await element.scrollIntoViewIfNeeded();
      if (s.state === "hover") await element.hover();
      else if (s.state === "press") { const b = (await element.boundingBox())!; await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down(); }
      else if (s.state === "focus") { await page.keyboard.press("Shift"); await element.focus(); }
      else for (let n = 0; n < (s.clicks ?? 1); n++) { await element.click(); if (n + 1 < (s.clicks ?? 1)) await page.waitForTimeout(700); }
      await page.waitForTimeout(s.state === "press" || s.state === "focus" ? Math.max(150, s.wait_ms) : s.wait_ms);
      await shoot(page, s, story, dir, width);
      if (s.state === "press") await page.mouse.up();
      await page.close();
    }
    await context.close();
  }
} finally { await browser.close(); server.stop(true); }
