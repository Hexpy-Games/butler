// React side of the native DS View parity: loads the built standalone DS Viewer (`vite build
// --config vite.ds-site.config.ts`) in Chromium and captures, for each page of scenes/ds-view.json:
//   <out>/react/<size>-<theme>/<page>.png            the whole viewer window
//   <out>/react/<size>-<theme>/<page>.layout.json    story canvas boxes (logical px)
//   <out>/react/<size>-<theme>/<page>.<n>.png        each story canvas, cropped
// The native side (`butler-ds-view --shots`) writes the same names under <out>/gpui/<size>-<theme>.
//
//   bun ds-view.ts --site <dist-ds-site> --out <dir> [--sizes 1280x800,390x844] [--themes light,dark]
//                  [--scale 2] [--locale ko] [--only page,page]
// PLAYWRIGHT_BROWSERS_PATH must point at an installed Chromium.
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
if (!site || !output) throw new Error("usage: ds-view.ts --site <dist-ds-site> --out <dir> [--sizes WxH,..] [--themes light,dark] [--scale 2] [--locale ko|en]");
const sizes = value("--sizes", "1280x800,390x844")!.split(",");
const themes = value("--themes", "light,dark")!.split(",");
const scale = Number(value("--scale", "2"));
const locale = value("--locale", "ko")!;
const only = value("--only")?.split(",");
if (!Number.isFinite(scale) || scale <= 0 || sizes.some(size => !/^[1-9]\d*x[1-9]\d*$/u.test(size)) || themes.some(theme => !["light", "dark"].includes(theme))) throw new Error("Invalid size, theme or scale");
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
/** Viewport height used to lay every story canvas out on screen (CSS px). */
const TALL = 7000;
const browser = await chromium.launch();
try {
  for (const size of sizes) for (const theme of themes) {
    const [width, height] = size.split("x").map(Number);
    const dir = join(resolve(output), "react", `${size}-${theme}`);
    mkdirSync(dir, { recursive: true });
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: theme as "light" | "dark", reducedMotion: "reduce" });
    for (const { page: id, entry } of scene.pages.filter(p => !only || only.includes(p.page))) {
      const page = await context.newPage();
      await page.goto(`http://localhost:${server.port}/?page=${entry}&theme=${theme}&locale=${locale}&motion=reduced`);
      await page.waitForSelector("[data-ds-story]");
      await page.evaluate("document.fonts.ready.then(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))");
      await page.screenshot({ path: join(dir, `${id}.png`) });
      // The viewer scrolls inside its window: grow the viewport so every story canvas is on screen.
      await page.setViewportSize({ width, height: TALL });
      await page.evaluate("new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))");
      const boxes = await page.evaluate(`[...document.querySelectorAll("[data-ds-story]")].map((story, index) => {
        const canvas = story.querySelector("[data-ds-fixture-canvas]");
        const b = canvas.getBoundingClientRect();
        return { anchor: story.getAttribute("data-ds-story"), index, x: b.x, y: b.y, w: b.width, h: b.height };
      })`) as Array<{ anchor: string; index: number; x: number; y: number; w: number; h: number }>;
      writeFileSync(join(dir, `${id}.layout.json`), JSON.stringify(boxes, null, 2));
      for (const box of boxes) {
        if (box.w > 0 && box.h > 0) await page.screenshot({ path: join(dir, `${id}.${box.index}.png`), clip: { x: box.x, y: box.y, width: box.w, height: box.h } });
      }
      await page.close();
    }
    await context.close();
  }
} finally {
  await browser.close();
  server.stop(true);
}
