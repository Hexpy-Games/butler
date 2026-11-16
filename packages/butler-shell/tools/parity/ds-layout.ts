// Web side of the per-control DS layout diff: for each page of scenes/ds-view.json, writes
//   <out>/react/1280x800-light/<page>.parts.json
// the box of every story canvas (key `canvas`), of the controls inside it (`control-<n>`, DOM order,
// counted again from 0 in each story) and of the canvas's direct element children (`child-<i>`, web
// only), in logical px relative to the canvas. The native side is `butler-ds-view --shots --parts`.
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
/** Control definition of README.md line 92 (button, [role=button|radio|switch], [tabindex="0"]) and line 121 (input, textarea, select); same as SELECTOR in ds-view-states.ts. */
const SELECTOR = "button, [role=\"button\"], [role=\"radio\"], [role=\"switch\"], input:not([type=\"hidden\"]), textarea, select, [tabindex=\"0\"]";
/** Viewport height used to lay every story canvas out on screen (CSS px). */
const TALL = 7000;
const [width, height, theme] = [1280, 800, "light"];
const browser = await chromium.launch();
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
      const seen = new Set();
      return [...document.querySelectorAll("[data-ds-story]")].flatMap(story => {
        const canvas = story.querySelector("[data-ds-fixture-canvas]");
        const origin = canvas.getBoundingClientRect();
        const part = (key, e) => { const b = e.getBoundingClientRect(); return { story: story.getAttribute("data-ds-story"), key, x: b.x - origin.x, y: b.y - origin.y, w: b.width, h: b.height }; };
        const controls = [...canvas.querySelectorAll(${JSON.stringify(SELECTOR)})].filter(e => !seen.has(e) && seen.add(e));
        return [part("canvas", canvas), ...controls.map((e, n) => part("control-" + n, e)), ...[...canvas.children].map((e, i) => part("child-" + i, e))];
      });
    })()`);
    writeFileSync(join(dir, `${id}.parts.json`), JSON.stringify(parts, null, 2));
    await page.close();
  }
  await context.close();
} finally {
  await browser.close();
  server.stop(true);
}
