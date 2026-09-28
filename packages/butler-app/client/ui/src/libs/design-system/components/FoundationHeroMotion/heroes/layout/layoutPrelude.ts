import type { Key, Track } from "../../heroTimeline";
import { TRANSITION } from "../shared/beats";
import { introTracks } from "../shared/Intro";
import { reveal, select } from "../shared/Reveal";
import { rollerTracks } from "../shared/Roller";
import type { Prelude, TimelineContext } from "../shared/types";
import { LEGEND, MODES, WIDTHS, tokenValue, type LayoutCopy } from "./layoutCopy";
import { inset } from "./LayoutScenes";

/**
 * 10 Layout prelude, beat marks:
 *
 *   0–7.4     Intro    "Layout"; frame, modes, platform
 *   6.8–14    Frame    the camera glides to the page frame as it draws: the
 *                      titlebar band, the max-width guides, the columns and
 *                      their gutter, the safe-area hatches; a legend names each
 *   16.4–20.4 Resize   the camera travels on to a frame at 1280 with a handle
 *   22–29.4   Drag     the handle drags it to 1023, 640 and 375: the width
 *                      rolls, the mode reads expanded, medium, compact
 *                      (responsive.ts), the tiles rewrap, the sidebar goes
 *   30.4      Drawer   the sidebar comes back as a drawer; safe areas hatch
 */
const AT = { field: 6.8, title: 9.6, guides: 10.6, columns: 11.4, hatch: 12.8, resize: 16.4, source: 20.8, drawer: 30.4, end: 33.4 } as const;
/** Beats at which the frame arrives at each width (the handle glides in before). */
const STEPS = [0, 23.2, 26, 28.8] as const;
const GLIDE = 1.2;
const LEGEND_AT = [AT.title, AT.guides, AT.columns, AT.columns + 0.6, AT.hatch];

export function layoutPrelude(copy: LayoutCopy): Pick<Prelude, "end" | "tracks"> {
  return {
    end: () => AT.end,
    tracks: ({ g, close, view }: TimelineContext) => {
      const front = view("intro", g.boxes.intro!, 1, 1);
      const field = view("field", g.boxes.field!, 0.86, 2);
      const resize = view("resize", g.boxes.resize!, g.layout === "tall" ? 0.97 : 0.9, 2);
      const camera: Key[] = [
        { at: 0, ...front }, { at: AT.field, ...front }, { at: AT.field + TRANSITION, ...field, ease: "standard" },
        { at: AT.resize, ...field }, { at: AT.resize + TRANSITION, ...resize, ease: "standard" }, { at: AT.end, ...resize },
      ];
      /** A value held from `at` on, reset at the cycle's close. */
      const grow = (name: string, at: number, prop: "sx" | "sy" | "o", beats = 0.9): Track => ({
        select: select(name),
        keys: [{ at: 0, [prop]: 0 }, { at, [prop]: 0 }, { at: at + beats, [prop]: 1, ease: "decelerate" }, { at: close - 0.01 }, { at: close, [prop]: 0 }],
      });
      /** A property stepping through `values` as the frame arrives at each width (gliding in before). */
      const stepped = (name: string, values: (k: number) => Omit<Key, "at">): Track => ({
        select: select(name),
        keys: [{ at: 0, ...values(0) }, ...STEPS.slice(1).flatMap((at, j): Key[] => [{ at: at - GLIDE, ...values(j) }, { at, ...values(j + 1), ease: "standard" }]), { at: close - 0.01 }, { at: close, ...values(0) }],
      });
      /** Shown while the frame is at widths `from`…`to` (cut at each arrival). */
      const during = (name: string, from: number, to: number): Track => {
        const on = (k: number) => (k >= from && k <= to ? 1 : 0);
        return { select: select(name), keys: [{ at: 0, o: on(0) }, ...STEPS.slice(1).flatMap((at, j): Key[] => [{ at: at - 0.01, o: on(j) }, { at: at + 0.3, o: on(j + 1), ease: "standard" }]), { at: close - 0.01 }, { at: close, o: on(0) }] };
      };
      const edge = (k: number) => inset(WIDTHS[k]!.px);
      const tracks: Track[] = [
        ...introTracks(copy.title, copy.lead, close),
        // The page frame draws, its legend naming each part as it lands.
        grow("lf-title", AT.title, "sx"), grow("lf-gl", AT.guides, "sy"), grow("lf-gr", AT.guides + 0.2, "sy"),
        ...Array.from({ length: 6 }, (_, k) => grow(`lf-c${k}`, AT.columns + k * 0.15, "sy", 0.7)),
        ...(["t", "r", "b", "l"] as const).map((side, k) => grow(`lf-h-${side}`, AT.hatch + k * 0.2, "o", 0.6)),
        ...LEGEND.flatMap((row, k): Track[] => [
          grow(`lg-${k}`, LEGEND_AT[k]!, "o", 0.4),
          ...reveal(`lg-${k}-n`, LEGEND_AT[k]! + 0.2, row.token, close),
          ...(row.value ? reveal(`lg-${k}-v`, LEGEND_AT[k]! + 0.8, tokenValue(row.token) || "0", close) : []),
        ]),
        // The drag: the edge, lines and handle follow; the shell clips behind, then relays out.
        stepped("rs-win", (k) => ({ x: -edge(k) })), stepped("rs-win-in", (k) => ({ x: edge(k) })),
        stepped("rs-right", (k) => ({ x: -edge(k) })), stepped("rs-handle", (k) => ({ x: -edge(k) })),
        stepped("rs-top", (k) => ({ sx: WIDTHS[k]!.px / WIDTHS[0].px })), stepped("rs-bot", (k) => ({ sx: WIDTHS[k]!.px / WIDTHS[0].px })),
        ...WIDTHS.map((_, k) => during(`rs-l${k}`, k, k)),
        ...MODES.map((mode, m) => {
          const ks = WIDTHS.flatMap((w, k) => (w.mode === mode ? [k] : []));
          return during(`md-${m}`, Math.min(...ks), Math.max(...ks));
        }),
        ...rollerTracks("rw", WIDTHS.map((w) => String(w.px)), 0, STEPS.map((at, k) => [at, k] as [number, number]), g.lines.rw ?? 0, close, GLIDE),
        ...reveal("rs-src", AT.source, copy.source, close),
        // Compact at 375: the sidebar comes back as a drawer over a dim; the safe areas hatch.
        grow("rs-ht", AT.drawer - 0.8, "o", 0.5), grow("rs-hb", AT.drawer - 0.6, "o", 0.5),
        grow("rs-dim", AT.drawer, "o", 0.6),
        { select: select("rs-drawer"), keys: [{ at: 0, x: -120 }, { at: AT.drawer, x: -120 }, { at: AT.drawer + 0.8, x: 0, ease: "decelerate" }, { at: close - 0.01 }, { at: close, x: -120 }] },
      ];
      return { tracks, camera };
    },
  };
}
