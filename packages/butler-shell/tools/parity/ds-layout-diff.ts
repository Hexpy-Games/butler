// Compares <web>/<page>.parts.json (ds-layout.ts) with <gpui>/<page>.parts.json (butler-ds-view --shots --parts)
// for the pages of scenes/ds-view.json, matching by (page, story, key). Prints JSON lines (one per part, one
// summary per story, one totals line) and then two tables: (A) stories whose canvas differs by more than
// 0.5 px, (B) stories with equal control counts whose controls differ by more than 0.5 px. A story whose
// web and gpui control counts differ gets one `count-mismatch` line and no per-control rows.
//
//   bun ds-layout-diff.ts --web <dir> --gpui <dir>
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = Bun.argv.slice(2);
const web = args[args.indexOf("--web") + 1];
const gpui = args[args.indexOf("--gpui") + 1];
if (!web || !gpui || args.indexOf("--web") < 0 || args.indexOf("--gpui") < 0) throw new Error("usage: ds-layout-diff.ts --web <dir> --gpui <dir>");
const TOLERANCE = 0.5;
type Part = { story: string; key: string; x: number; y: number; w: number; h: number };
type Box = { x: number; y: number; w: number; h: number };
const scene = JSON.parse(readFileSync(new URL("./scenes/ds-view.json", import.meta.url), "utf8")) as { pages: Array<{ page: string }> };
const read = (dir: string, page: string) => existsSync(join(dir, `${page}.parts.json`)) ? JSON.parse(readFileSync(join(dir, `${page}.parts.json`), "utf8")) as Part[] : undefined;
const box = (p: Part): Box => ({ x: p.x, y: p.y, w: p.w, h: p.h });
const out = (line: object) => console.log(JSON.stringify(line));
const unmappedWeb: string[] = [];
const unmappedGpui: string[] = [];
const canvasRows: Array<{ page: string; story: string; dw: number; dh: number }> = [];
type Line = { key: string; web: Box; gpui: Box; dx: number; dy: number; dw: number; dh: number };
const controlRows: Array<{ page: string; story: string; first: Line; max: number }> = [];
const over = (m: Line) => Math.max(Math.abs(m.dx), Math.abs(m.dy), Math.abs(m.dw), Math.abs(m.dh)) > TOLERANCE;
let mapped = 0, compared = 0, oneSided = 0, withControls = 0, equalCount = 0, countMismatch = 0;
for (const { page } of scene.pages) {
  const a = read(web, page), b = read(gpui, page);
  if (!a) unmappedWeb.push(page);
  if (!b) unmappedGpui.push(page);
  if (!a || !b) continue;
  mapped++;
  for (const story of [...new Set([...a, ...b].map(p => p.story))]) {
    const wp = a.filter(p => p.story === story), gp = b.filter(p => p.story === story);
    const [wc, gc] = [wp.find(p => p.key === "canvas"), gp.find(p => p.key === "canvas")];
    if (!wc || !gc) {
      oneSided++;
      out({ page, story, status: wp.length ? "web-only" : "gpui-only" });
      continue;
    }
    compared++;
    const line = (p: Part, q: Part): Line => ({ key: p.key, web: box(p), gpui: box(q), dx: q.x - p.x, dy: q.y - p.y, dw: q.w - p.w, dh: q.h - p.h });
    const canvas = line(wc, gc);
    out({ page, story, ...canvas });
    if (Math.abs(canvas.dw) > TOLERANCE || Math.abs(canvas.dh) > TOLERANCE) canvasRows.push({ page, story, dw: canvas.dw, dh: canvas.dh });
    const wcs = wp.filter(p => p.key !== "canvas"), gcs = gp.filter(p => p.key !== "canvas");
    if (wcs.length || gcs.length) withControls++;
    if (wcs.length !== gcs.length) {
      countMismatch++;
      out({ page, story, status: "count-mismatch", web: wcs.length, gpui: gcs.length });
      continue;
    }
    if (wcs.length) equalCount++;
    const lines = wcs.map((p, n) => line(p, gcs[n]));
    for (const l of lines) out({ page, story, ...l });
    const bad = lines.filter(over).sort((m, n) => m.web.y - n.web.y || m.web.x - n.web.x);
    if (bad.length) controlRows.push({ page, story, first: bad[0], max: bad.length });
  }
}
out({ totals: { pages_mapped: mapped, pages_not_mapped_web: unmappedWeb, pages_not_mapped_gpui: unmappedGpui, stories_compared: compared, stories_one_side: oneSided, stories_canvas_over_tolerance: canvasRows.length, stories_with_controls: withControls, stories_equal_count: equalCount, stories_count_mismatch: countMismatch, stories_controls_over_tolerance: controlRows.length } });
const f = (n: number) => n.toFixed(1);
const size = (b: Box) => `${f(b.w)}x${f(b.h)}`;
console.log("\n(A) canvas: page | story | dw | dh");
for (const r of canvasRows.sort((m, n) => Math.max(Math.abs(n.dw), Math.abs(n.dh)) - Math.max(Math.abs(m.dw), Math.abs(m.dh)))) console.log(`${r.page} | ${r.story} | ${f(r.dw)} | ${f(r.dh)}`);
console.log("\n(B) controls: page | story | first offending control | web w x h | gpui w x h | dx | dy | dw | dh | offending controls");
for (const r of controlRows) console.log(`${r.page} | ${r.story} | ${r.first.key} | ${size(r.first.web)} | ${size(r.first.gpui)} | ${f(r.first.dx)} | ${f(r.first.dy)} | ${f(r.first.dw)} | ${f(r.first.dh)} | ${r.max}`);
