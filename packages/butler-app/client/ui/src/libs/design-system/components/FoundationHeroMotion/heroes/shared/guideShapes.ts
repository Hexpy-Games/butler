import type { Box } from "../../heroTimeline";
import type { Annot, Marks } from "./types";

/** A guide drawn on the subject: a thin path (drawn along its length), a hatched band, a focus ring or a dot. */
export type Guide =
  | { t: "path"; d: string; len: number; dashed?: boolean }
  | { t: "hatch"; box: Box }
  | { t: "ring"; box: Box; r: number };

export type Place = "above" | "below" | "left" | "right";

/** A value set on its guide (opening). */
export interface Note { x: number; y: number; place: Place; text: string[] }

/** A badge far out in the gutter, joined to its guide by a leader (builds). */
export interface Badge { x: number; y: number; side: "l" | "r" | "b" | "t" | "d"; text: string[]; leader: { d: string; len: number } }

export interface AnnotItem {
  id: string;
  guides: Guide[];
  anchor: { x: number; y: number };
  note?: Note;
  badge?: Badge;
}

export const round = (value: number) => Math.round(value * 10) / 10;

function rect({ x, y, w, h }: Box): { d: string; len: number } {
  return { d: `M${round(x)} ${round(y)}H${round(x + w)}V${round(y + h)}H${round(x)}Z`, len: Math.ceil(2 * (w + h)) };
}

/** An I-beam dimension line from a to b (vertical when x1 = x2). */
function beam(x1: number, y1: number, x2: number, y2: number): { d: string; len: number } {
  const vertical = Math.abs(x1 - x2) < 0.5;
  const cap = 4;
  const d = vertical
    ? `M${round(x1 - cap)} ${round(y1)}H${round(x1 + cap)}M${round(x1)} ${round(y1)}V${round(y2)}M${round(x1 - cap)} ${round(y2)}H${round(x1 + cap)}`
    : `M${round(x1)} ${round(y1 - cap)}V${round(y1 + cap)}M${round(x1)} ${round(y1)}H${round(x2)}M${round(x2)} ${round(y2 - cap)}V${round(y2 + cap)}`;
  return { d, len: Math.ceil(Math.abs(x2 - x1) + Math.abs(y2 - y1) + cap * 4) };
}

const inflate = (b: Box, by: number): Box => ({ x: b.x - by, y: b.y - by, w: b.w + by * 2, h: b.h + by * 2 });

export interface Shape { guides: Guide[]; anchor: { x: number; y: number }; note: Omit<Note, "text"> }

/** The guides of one annotation and the point its note or leader attaches to; null when it has nothing to show. */
export function shape(annot: Annot, marks: Marks): Shape | null {
  if (annot.kind === "gap") {
    const a = marks[annot.from];
    const b = marks[annot.to];
    if (!a || !b) return null;
    const [p, q] = [a.box, b.box];
    if (q.y >= p.y + p.h - 0.5) {
      const [y1, y2] = [p.y + p.h, q.y];
      const [x1, x2] = [Math.max(p.x, q.x), Math.min(p.x + p.w, q.x + q.w)];
      if (y2 - y1 < 0.5) return null;
      // The bracket stands near the band's right end; its value sits just past the band.
      const x = x2 - Math.min(16, (x2 - x1) / 2);
      return { guides: [{ t: "hatch", box: { x: x1, y: y1, w: Math.max(1, x2 - x1), h: y2 - y1 } }, { t: "path", ...beam(x, y1, x, y2) }], anchor: { x, y: (y1 + y2) / 2 }, note: { x: x2 + 10, y: (y1 + y2) / 2, place: "right" } };
    }
    const [x1, x2] = [p.x + p.w, q.x];
    const [y1, y2] = [Math.max(p.y, q.y), Math.min(p.y + p.h, q.y + q.h)];
    if (x2 - x1 < 0.5) return null;
    const y = y2 + 6;
    return { guides: [{ t: "hatch", box: { x: x1, y: y1, w: x2 - x1, h: Math.max(1, y2 - y1) } }, { t: "path", ...beam(x1, y, x2, y) }], anchor: { x: (x1 + x2) / 2, y }, note: { x: (x1 + x2) / 2, y: y + 6, place: "below" } };
  }
  if (annot.kind === "contrast") {
    const f = marks[annot.fg];
    const b = marks[annot.bg];
    if (!f || !b) return null;
    const x = f.box.x - 6;
    const cy = f.box.y + f.box.h / 2;
    const d = `M${round(x)} ${round(f.box.y)}V${round(f.box.y + f.box.h)}M${round(x)} ${round(cy)}H${round(b.box.x - 10)}`;
    return { guides: [{ t: "path", d, len: Math.ceil(f.box.h + x - b.box.x + 10) }], anchor: { x: b.box.x - 10, y: cy }, note: { x: b.box.x - 14, y: cy, place: "left" } };
  }
  const m = marks[annot.target];
  if (!m) return null;
  const b = m.box;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  switch (annot.kind) {
    case "pad": {
      const [t, r, bt, l] = m.pad;
      const bands = [
        t > 0 ? { x: b.x, y: b.y, w: b.w, h: t } : null,
        r > 0 ? { x: b.x + b.w - r, y: b.y + t, w: r, h: b.h - t - bt } : null,
        bt > 0 ? { x: b.x, y: b.y + b.h - bt, w: b.w, h: bt } : null,
        l > 0 ? { x: b.x, y: b.y + t, w: l, h: b.h - t - bt } : null,
      ].filter((band): band is Box => Boolean(band) && band!.w > 0 && band!.h > 0);
      if (bands.length === 0) return null;
      return { guides: bands.map((band) => ({ t: "hatch", box: band })), anchor: l > 0 ? { x: b.x + l / 2, y: cy } : { x: b.x, y: b.y + t / 2 }, note: { x: b.x - 10, y: b.y + Math.max(t, 8) / 2, place: "left" } };
    }
    case "size":
      return annot.axis === "h"
        ? { guides: [{ t: "path", ...beam(b.x - 12, b.y, b.x - 12, b.y + b.h) }], anchor: { x: b.x - 12, y: cy }, note: { x: b.x - 20, y: cy, place: "left" } }
        : { guides: [{ t: "path", ...beam(b.x, b.y - 12, b.x + b.w, b.y - 12) }], anchor: { x: cx, y: b.y - 12 }, note: { x: cx, y: b.y - 20, place: "above" } };
    case "radius": {
      const r = m.r;
      if (r < 1) return null;
      const [ox, oy] = [b.x + r, b.y + r];
      const d = `M${round(ox - r)} ${round(oy)}A${round(r)} ${round(r)} 0 1 0 ${round(ox + r)} ${round(oy)}A${round(r)} ${round(r)} 0 1 0 ${round(ox - r)} ${round(oy)}`;
      return { guides: [{ t: "path", d, len: Math.ceil(2 * Math.PI * r) }], anchor: { x: ox - r * 0.71, y: oy - r * 0.71 }, note: { x: b.x - 10, y: b.y + Math.min(r, 8), place: "left" } };
    }
    case "box": {
      const to = annot.inflateTo ? marks[annot.inflateTo] : undefined;
      const area = inflate(b, to ? Math.max(0, (to.box.h - b.h) / 2) : annot.inflate ?? 0);
      return { guides: [{ t: "path", ...rect(area), dashed: true }], anchor: { x: area.x, y: cy }, note: { x: area.x + area.w + 8, y: cy, place: "right" } };
    }
    case "ring":
      return { guides: [{ t: "ring", box: b, r: m.r }], anchor: { x: b.x - 4, y: cy }, note: { x: cx, y: b.y + b.h + 10, place: "below" } };
    case "center":
      return annot.axis === "h"
        ? { guides: [{ t: "path", d: `M${round(b.x - 16)} ${round(cy)}H${round(b.x + b.w + 16)}`, len: Math.ceil(b.w + 32) }], anchor: { x: b.x - 16, y: cy }, note: { x: b.x + b.w + 22, y: cy, place: "right" } }
        : { guides: [{ t: "path", d: `M${round(cx)} ${round(b.y - 16)}V${round(b.y + b.h + 16)}`, len: Math.ceil(b.h + 32) }], anchor: { x: cx, y: b.y - 16 }, note: { x: cx, y: b.y - 22, place: "above" } };
    case "shadow": {
      const s = m.shadow;
      if (!s || (s.y === 0 && s.blur === 0)) return null;
      const area = inflate({ ...b, y: b.y + s.y }, s.blur / 2);
      const offset = { d: `M${round(cx)} ${round(b.y + b.h)}V${round(b.y + b.h + s.y)}`, len: Math.ceil(Math.max(1, s.y)) };
      return { guides: [{ t: "path", ...rect(area), dashed: true }, { t: "path", ...offset }], anchor: { x: area.x, y: area.y + area.h }, note: { x: cx, y: area.y + area.h + 6, place: "below" } };
    }
    case "tag":
      return { guides: [], anchor: { x: b.x, y: cy }, note: { x: b.x - 8, y: cy, place: "left" } };
  }
  return null;
}
