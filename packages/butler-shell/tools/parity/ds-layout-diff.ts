// Compares <web>/<page>.parts.json (ds-layout.ts) with <gpui>/<page>.parts.json (butler-ds-view --shots --parts)
// for the pages of scenes/ds-view.json, matching by (page, story, key). Prints JSON lines (one per part, one
// summary per story, one totals line) and then a table of the stories that differ by more than 0.5 px.
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
const rows: Array<{ page: string; story: string; max: number; canvas: Record<string, number>; first: Record<string, unknown> | null; web: number; gpui: number }> = [];
let mapped = 0, compared = 0, oneSided = 0, differing = 0;
for (const { page } of scene.pages) {
  const a = read(web, page), b = read(gpui, page);
  if (!a) unmappedWeb.push(page);
  if (!b) unmappedGpui.push(page);
  if (!a || !b) continue;
  mapped++;
  const stories = [...new Set([...a, ...b].map(p => p.story))];
  for (const story of stories) {
    const wp = a.filter(p => p.story === story), gp = b.filter(p => p.story === story);
    if (!wp.some(p => p.key === "canvas") || !gp.some(p => p.key === "canvas")) {
      oneSided++;
      out({ page, story, status: wp.length ? "web-only" : "gpui-only" });
      continue;
    }
    compared++;
    const matched: Array<{ key: string; web: Box; gpui: Box; dx: number; dy: number; dw: number; dh: number }> = [];
    let unmatched = 0;
    for (const p of wp) {
      const q = gp.find(c => c.key === p.key);
      if (!q) { unmatched++; out({ page, story, key: p.key, status: "web-only", web: box(p) }); continue; }
      const line = { key: p.key, web: box(p), gpui: box(q), dx: q.x - p.x, dy: q.y - p.y, dw: q.w - p.w, dh: q.h - p.h };
      matched.push(line);
      out({ page, story, ...line });
    }
    for (const q of gp) if (!wp.some(p => p.key === q.key)) { unmatched++; out({ page, story, key: q.key, status: "gpui-only", gpui: box(q) }); }
    const abs = (m: (typeof matched)[number]) => Math.max(Math.abs(m.dx), Math.abs(m.dy), Math.abs(m.dw), Math.abs(m.dh));
    const max_abs = Math.max(0, ...matched.map(abs));
    const first = matched.filter(m => Math.abs(m.dh) > TOLERANCE || Math.abs(m.dw) > TOLERANCE).sort((m, n) => m.web.y - n.web.y)[0] ?? null;
    out({ page, story, matched: matched.length, unmatched, max_abs, first });
    if (max_abs > TOLERANCE) {
      differing++;
      const canvas = matched.find(m => m.key === "canvas")!;
      rows.push({ page, story, max: max_abs, canvas: { dw: canvas.dw, dh: canvas.dh }, first: first && { key: first.key, dx: first.dx, dy: first.dy, dw: first.dw, dh: first.dh }, web: wp.filter(p => p.key.startsWith("control-")).length, gpui: gp.filter(p => p.key.startsWith("control-")).length });
    }
  }
}
const totals = { pages_mapped: mapped, pages_not_mapped_web: unmappedWeb, pages_not_mapped_gpui: unmappedGpui, stories_compared: compared, stories_one_side: oneSided, stories_over_tolerance: differing };
out({ totals });
const f = (n: number) => n.toFixed(1);
console.log("\npage | story | canvas dw/dh | first key dx/dy/dw/dh | controls web/gpui | max_abs");
for (const r of rows.sort((m, n) => n.max - m.max)) {
  const fk = r.first as { key: string; dx: number; dy: number; dw: number; dh: number } | null;
  console.log(`${r.page} | ${r.story} | ${f(r.canvas.dw)}/${f(r.canvas.dh)} | ${fk ? `${fk.key} ${f(fk.dx)}/${f(fk.dy)}/${f(fk.dw)}/${f(fk.dh)}` : "-"} | ${r.web}/${r.gpui} | ${f(r.max)}`);
}
