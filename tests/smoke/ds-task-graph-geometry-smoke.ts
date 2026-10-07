import { existsSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import type { Page } from "playwright";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";

// Geometry smoke for the task graph blocks on the built DS site (run build:ds-site first).
// Desktop 1280: every edge starts on its source card's right edge and ends on its target's left
// edge at the cards' vertical centres; columns share one left edge; an out-of-view selection is
// scrolled so its column rests on the canvas inset. Inspector stories: the section row box, the
// header and the first card share the inspector inset; header to first row is the Section gap.
// Phone 375: every lane dot sits on its card's first text line; nothing scrolls sideways.
// Geometry only: no pixel sampling.

const dist = resolve(process.cwd(), "packages/butler-app/client/ui/dist-ds-site");
if (!existsSync(join(dist, "index.html"))) throw new Error(`missing ${dist}/index.html; run build:ds-site first`);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname);
    const file = normalize(join(dist, path === "/" ? "index.html" : path));
    if (!file.startsWith(dist + sep) && file !== join(dist, "index.html")) return new Response("forbidden", { status: 403 });
    return existsSync(file) && statSync(file).isFile() ? new Response(Bun.file(file)) : new Response(Bun.file(join(dist, "index.html")));
  },
});
const origin = `http://127.0.0.1:${server.port}`;
const failures: string[] = [];
const fail = (message: string) => failures.push(message);

async function open(page: Page, item: string, locale: "ko" | "en") {
  await page.goto(`${origin}/?page=blocks/${item}&theme=light&locale=${locale}`);
  await page.waitForSelector('[data-test-class="task-graph-card"]', { timeout: 20_000 });
  await page.waitForTimeout(600);
}

const checkCanvasEdges = (page: Page, label: string) => page.evaluate(() => {
  const problems: string[] = [];
  let edges = 0;
  for (const canvas of document.querySelectorAll<HTMLElement>('[data-test-class="task-graph-canvas"]')) {
    const svg = canvas.querySelector("svg");
    if (!svg) continue;
    const base = svg.getBoundingClientRect();
    const slot = (id: string) => canvas.querySelector<HTMLElement>(`[data-graph-slot="${CSS.escape(id)}"]`)!.getBoundingClientRect();
    for (const path of svg.querySelectorAll<SVGPathElement>("path[data-edge]")) {
      edges += 1;
      const [from, to] = path.dataset.edge!.split("->") as [string, string];
      const start = path.getPointAtLength(0);
      const end = path.getPointAtLength(path.getTotalLength());
      const a = slot(from);
      const b = slot(to);
      const near = (x: number, y: number) => Math.abs(x - y) <= 1.5;
      if (!near(start.x + base.left, a.right) || !near(start.y + base.top, a.top + a.height / 2)) problems.push(`${path.dataset.edge} start off ${from}`);
      if (!near(end.x + base.left, b.left) || !near(end.y + base.top, b.top + b.height / 2)) problems.push(`${path.dataset.edge} end off ${to}`);
    }
    const columns = canvas.querySelectorAll<HTMLElement>("[data-graph-slot]");
    const lefts = new Map<HTMLElement, number>();
    columns.forEach((node) => lefts.set(node.parentElement!, Math.round(node.getBoundingClientRect().left)));
    columns.forEach((node) => { if (Math.abs(Math.round(node.getBoundingClientRect().left) - lefts.get(node.parentElement!)!) > 1) problems.push(`column misaligned at ${node.dataset.graphSlot}`); });
  }
  return { problems, edges };
}).then(({ problems, edges }) => {
  if (edges === 0) fail(`${label}: no edges measured`);
  problems.forEach((problem) => fail(`${label}: ${problem}`));
  return edges;
});

const browser = await launchSmokeBrowser();
try {
  // Desktop canvas.
  const desktop = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  for (const locale of ["ko", "en"] as const) {
    await open(desktop, "TaskGraphCanvas", locale);
    const edges = await checkCanvasEdges(desktop, `canvas ${locale}`);
    console.log(`canvas ${locale}: ${edges} edges on their cards`);
  }
  // Scroll-into-inset: the long story's selected (running) card rests where the first column rests.
  const inset = await desktop.evaluate(() => {
    const canvases = [...document.querySelectorAll<HTMLElement>('[data-test-class="task-graph-canvas"]')];
    const long = canvases.find((canvas) => canvas.querySelectorAll("[data-graph-slot]").length >= 16)!;
    const scroller = long; // data-test-class sits on the scrolling element itself
    const selected = long.querySelector<HTMLElement>('[aria-pressed="true"]')!.getBoundingClientRect();
    const first = long.querySelector<HTMLElement>("[data-graph-slot]")!.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    return { scrollLeft: scroller.scrollLeft, selected: selected.left - box.left, rest: first.left + scroller.scrollLeft - box.left };
  });
  if (inset.scrollLeft > 0 && Math.abs(inset.selected - inset.rest) > 1) fail(`long graph: selected column at ${inset.selected}px, inset ${inset.rest}px`);
  console.log(`scroll-into-inset: scrollLeft ${inset.scrollLeft}, selected ${inset.selected.toFixed(1)} vs rest ${inset.rest.toFixed(1)}`);

  // Inspector stories: one inset, Section gap.
  await open(desktop, "TaskGraphSection", "ko");
  await checkCanvasEdges(desktop, "section");
  const section = await desktop.evaluate(() => {
    const panel = [...document.querySelectorAll<HTMLElement>('[data-test-class="task-graph-section"]')]
      .find((item) => item.querySelectorAll('[data-test-class="task-graph-group"]').length >= 6)!;
    const shell = panel.closest<HTMLElement>('[data-test-class~="right-inspector"]')!.getBoundingClientRect();
    const title = panel.querySelector("h3")!.getBoundingClientRect();
    const row = panel.querySelector<HTMLElement>('[data-test-class="task-graph-group"] [data-surface]')!.getBoundingClientRect();
    // The first card in view (an out-of-view selection scrolls earlier columns off to the left).
    const canvas = panel.querySelector<HTMLElement>('[data-test-class="task-graph-canvas"]')!;
    const view = canvas.getBoundingClientRect();
    const card = [...canvas.querySelectorAll<HTMLElement>("[data-graph-slot]")].map((slot) => slot.getBoundingClientRect())
      .filter((rect) => rect.left >= view.left - 1).sort((a, b) => a.left - b.left)[0]!;
    return { header: title.left - shell.left, row: row.left - shell.left, card: card.left - shell.left, gap: row.top - title.bottom };
  });
  if (Math.abs(section.row - section.card) > 1.5) fail(`section: row box at ${section.row}px but first card at ${section.card}px`);
  if (Math.abs(section.gap - 16) > 1.5) fail(`section: header to first row ${section.gap}px (Section gap is 16px)`);
  console.log(`section insets: header ${section.header.toFixed(1)}, row ${section.row.toFixed(1)}, card ${section.card.toFixed(1)}; gap ${section.gap.toFixed(1)}`);

  // Phone lanes.
  const phone = await (await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true })).newPage();
  for (const item of ["TaskGraphLanes", "TaskGraphSection"]) {
    await open(phone, item, "ko");
    const lanes = await phone.evaluate(() => {
      const problems: string[] = [];
      let dots = 0;
      // The lane gutter is the group's own SVG (card glyphs are SVGs too).
      for (const group of document.querySelectorAll<HTMLElement>('[role="group"]')) {
        const svg = [...group.children].find((child): child is SVGSVGElement => child.tagName.toLowerCase() === "svg");
        if (!svg || group.closest('[data-test-class="task-graph-canvas"]')) continue;
        const base = svg.getBoundingClientRect();
        const rows = [...group.querySelectorAll<HTMLElement>("[data-graph-slot]")];
        svg.querySelectorAll("circle").forEach((circle, i) => {
          dots += 1;
          const glyph = rows[i]?.querySelector('[data-slot="icon-slot"]')?.getBoundingClientRect();
          if (!glyph) return;
          const y = Number(circle.getAttribute("cy")) + base.top;
          if (Math.abs(y - (glyph.top + glyph.height / 2)) > 1) problems.push(`dot ${rows[i]!.dataset.graphSlot} off its first line`);
        });
      }
      return { problems, dots, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    if (lanes.dots === 0) fail(`${item} 375: no lane dots`);
    if (lanes.overflow) fail(`${item} 375: page scrolls sideways`);
    lanes.problems.forEach((problem) => fail(`${item} 375: ${problem}`));
    console.log(`${item} 375: ${lanes.dots} dots on first lines`);
  }
} finally {
  await browser.close();
  server.stop(true);
}

if (failures.length) {
  for (const failure of failures) console.error(failure);
  throw new Error(`task graph geometry: ${failures.length} problem(s)`);
}
console.log("ds-task-graph-geometry-smoke: ok");
