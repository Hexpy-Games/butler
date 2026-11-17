// Web side of the per-control DS layout diff: for each page of scenes/ds-view.json, writes
//   <out>/react/1280x800-light/<page>.parts.json
// the box of every story canvas (key `canvas`) and of the controls whose centre lies inside it
// (`control-<n>`, document order, counted again from 0 in each story; controls in no canvas are dropped)
// and of every scroller (`slot:<data-slot>#<n>`, its parent as `slot:<data-slot>:frame#<n>`, with `client_h` and
// `scroll_h`), in logical px relative to the canvas. The native side is `butler-ds-view --shots --parts`.
//
//   bun ds-layout.ts --site <dist-ds-site> --out <dir> [--locale ko] [--only page,page]
// Serving, URL state, viewport growing and page mapping are those of ds-view.ts (light, 1280x800, scale 2).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";

const args = Bun.argv.slice(2);
const value = (flag: string, fallback?: string) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
const site = value("--site");
const output = value("--out");
if (!site || !output) throw new Error("usage: ds-layout.ts --site <dist-ds-site> --out <dir> [--locale ko|en] [--only page,page]");
const locale = value("--locale", "ko")!;
const only = value("--only")?.split(",");
const scene = JSON.parse(readFileSync(new URL("./scenes/ds-view.json", import.meta.url), "utf8")) as { pages: Array<{ page: string; entry: string }> };
const root = resolve(site);
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".txt": "text/plain" };
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(join(root, path));
    return file.exists().then(found => found ? new Response(file, { headers: { "content-type": types[extname(path)] ?? "application/octet-stream" } }) : new Response("not found", { status: 404 }));
  },
});
/** Control selector of the native side (queried over the whole document, as shots.rs does). */
const SELECTOR = "button, [role=\"button\"], [role=\"radio\"], [role=\"switch\"], input:not([type=hidden]):not([aria-hidden=true]), textarea, select, [tabindex=\"0\"]";
/** Viewport height used to lay every story canvas out on screen (CSS px). */
const TALL = 7000;
const [width, height] = [1280, 800];
const theme = "light";
// Linux headless Chromium hints glyph advances (text a few percent wider than macOS and gpui); unhint to match.
const browser = await chromium.launch(process.platform === "linux" ? { args: ["--font-render-hinting=none"] } : {});
try {
  const dir = join(resolve(output), "react", `${width}x${height}-${theme}`);
  mkdirSync(dir, { recursive: true });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: "reduce" });
  for (const { page: id, entry } of scene.pages.filter(p => !only || only.includes(p.page))) {
    const page = await context.newPage();
    await page.goto(`http://localhost:${server.port}/?page=${entry}&theme=${theme}&locale=${locale}&motion=reduced`);
    await page.waitForSelector("[data-ds-story]");
    await page.evaluate("document.fonts.ready.then(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))");
    // The viewer scrolls inside its window: grow the viewport so every story canvas is on screen.
    await page.setViewportSize({ width, height: TALL });
    await page.evaluate("new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))");
    const parts = await page.evaluate(`(() => {
      const stories = [...document.querySelectorAll("[data-ds-story]")].map(story => ({ name: story.getAttribute("data-ds-story"), canvas: story.querySelector("[data-ds-fixture-canvas]").getBoundingClientRect(), n: 0 }));
      const part = (s, key, b) => ({ story: s.name, key, x: b.x - s.canvas.x, y: b.y - s.canvas.y, w: b.width, h: b.height });
      const out = stories.map(s => part(s, "canvas", s.canvas));
      for (const e of document.querySelectorAll(${JSON.stringify(SELECTOR)})) {
        const b = e.getBoundingClientRect();
        const s = stories.find(c => b.x + b.width / 2 >= c.canvas.x && b.x + b.width / 2 < c.canvas.right && b.y + b.height / 2 >= c.canvas.y && b.y + b.height / 2 < c.canvas.bottom);
        if (s) out.push(part(s, "control-" + s.n++, b));
      }
      // Scrollers: overflow-y auto or scroll, keyed by data-slot (data-test-class when there is none, scroll:<n>
      // otherwise), with the parent box as the frame; counted again from 0 per name in each story.
      for (const e of document.querySelectorAll("*")) {
        if (!/^(auto|scroll)$/.test(getComputedStyle(e).overflowY)) continue;
        const b = e.getBoundingClientRect();
        const s = stories.find(c => b.x + b.width / 2 >= c.canvas.x && b.x + b.width / 2 < c.canvas.right && b.y + b.height / 2 >= c.canvas.y && b.y + b.height / 2 < c.canvas.bottom);
        if (!s) continue;
        const slot = e.getAttribute("data-slot") ?? e.getAttribute("data-test-class");
        const name = slot ? "slot:" + slot : "scroll";
        s.seen = s.seen ?? {};
        const n = s.seen[name] = (s.seen[name] ?? -1) + 1;
        const [key, frame] = slot ? [name + "#" + n, name + ":frame#" + n] : ["scroll:" + n, "scroll:" + n + ":frame"];
        out.push({ ...part(s, key, b), client_h: e.clientHeight, scroll_h: e.scrollHeight });
        out.push(part(s, frame, e.parentElement.getBoundingClientRect()));
      }
      return stories.flatMap(s => out.filter(p => p.story === s.name));
    })()`);
    writeFileSync(join(dir, `${id}.parts.json`), JSON.stringify(parts, null, 2));
    await page.close();
  }
  await context.close();
} finally {
  await browser.close();
  server.stop(true);
}
