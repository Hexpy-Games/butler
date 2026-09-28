import type { Key, Pose, Track } from "../../heroTimeline";
import { TRANSITION } from "../shared/beats";
import { introTracks } from "../shared/Intro";
import { reveal, select } from "../shared/Reveal";
import { rollerTracks } from "../shared/Roller";
import type { SceneContext } from "../scene/types";
import { BANDS, RHYTHM, STEPS, type BandId, type SpacingCopy } from "./spacingCopy";
import { bandTag, count } from "./spacingTiles";

/**
 * 03 Spacing, "counted space", beat marks (1 beat = --motion-deliberate):
 *
 *   0–7.4     Title    the letters drift apart, a 4px block in each gap, and back
 *   6.8–19.2  Unit     the camera on one block; it becomes xs and the named
 *                      steps build beside it; the readout rolls `px = n×4`
 *   19.2–33.4 Explode  a real settings section pulls apart; each space fills
 *                      with blocks, counted (20 = 5×4); it snaps shut on them;
 *                      the blocks squeeze out
 *   33.4–44   Rhythm   the page: 3 blocks in a group, 5 between rows, 10
 *                      between sections, pulsed small to large
 *   44–53.6   Density  comfortable beside compact: the compact inset drops two
 *                      blocks, 24 → 16
 */
const AT = {
  spread: 2.6, gather: 5, stairs: 6.8, land: 12.2, grow: 14.2, explode: 19.2, open: 23.4, count: 24.8, fill: 27.6, shut: 30.4, squeeze: 32.2,
  rhythm: 33.4, pulse: 38.8, density: 44, drop: 49.2, end: 53.6,
} as const;
/** How far the title's letters drift apart (canvas px, the block in each gap). */
const DRIFT = 12;
/** The explode's step between neighbouring parts, and between a band's rows (canvas px). */
const E = 16;
const ROW_GAP = 3;

const looped = (keys: Key[], close: number): Key[] => {
  const { at: _at, ease: _ease, ...first } = keys[0]!;
  return [...keys, { at: close - 0.01 }, { at: close, ...first }];
};

const rows = (band: BandId) => count(BANDS.find((item) => item.id === band)!.px);

export function spacingTracks(copy: SpacingCopy) {
  return ({ g, close, view }: SceneContext): { tracks: Track[]; camera: Key[] } => {
    const { layout, canvas } = g;
    const tall = layout === "tall";
    const zoomAt = (cell: string, zoom: number): Pose => view(cell, { x: 0, y: 0, w: canvas.w / zoom, h: canvas.h / zoom }, 1, 99);
    const unit = g.boxes.unit ?? { x: 0, y: 0, w: 24, h: 24 };
    const xs = g.boxes["st-0"] ?? unit;
    const unitZoom = (tall ? canvas.w : canvas.h) * 0.42 / unit.h;
    const poses = {
      intro: view("intro", g.boxes.intro!, 1, 1), unit: zoomAt("stairs", unitZoom), stairs: view("stairs", g.boxes.stairs!, 0.86, 2),
      ex: view("ex", g.boxes.ex!, 0.9, tall ? 1.6 : 2), rh: view("rh", g.boxes.rh!, 0.9, 1.8), dn: view("dn", g.boxes.dn!, 0.92, 1.8),
    };
    const camera: Key[] = [
      { at: 0, ...poses.intro }, { at: AT.stairs, ...poses.intro }, { at: AT.stairs + TRANSITION, ...poses.unit, ease: "standard" },
      { at: AT.land - 0.6, ...poses.unit }, { at: AT.land + 3.4, ...poses.stairs, ease: "standard" },
      { at: AT.explode, ...poses.stairs }, { at: AT.explode + TRANSITION, ...poses.ex, ease: "standard" },
      { at: AT.rhythm, ...poses.ex }, { at: AT.rhythm + TRANSITION, ...poses.rh, ease: "standard" },
      { at: AT.density, ...poses.rh }, { at: AT.density + TRANSITION, ...poses.dn, ease: "standard" }, { at: AT.end, ...poses.dn },
    ];
    const shown = (name: string, from: number, to = close - 0.4): Track => ({
      select: select(name), keys: [{ at: 0, o: 0 }, { at: from, o: 0 }, { at: from + 0.5, o: 1, ease: "decelerate" }, { at: to, o: 1 }, { at: to + 0.4, o: 0 }],
    });
    const move = (selector: string, y: number): Track => ({
      select: selector, keys: looped([{ at: 0, y: 0 }, { at: AT.open, y: 0 }, { at: AT.open + 1.2, y, ease: "emphasized" }, { at: AT.shut, y }, { at: AT.shut + 1.2, y: 0, ease: "standard" }], close),
    });
    // Title: letters show one by one, drift apart with a block in each gap, and close again.
    const letters = [...copy.title];
    const title: Track[] = letters.flatMap((_, k): Track[] => [
      { select: select(`tl-${k}`), keys: looped([{ at: 0, o: 0, x: 0 }, { at: 0.4 + k * 0.1, o: 0 }, { at: 0.8 + k * 0.1, o: 1 }, { at: AT.spread, x: 0 }, { at: AT.spread + 1.2, x: k * DRIFT, ease: "emphasized" }, { at: AT.gather, x: k * DRIFT }, { at: AT.gather + 1, x: 0, ease: "standard" }], close) },
      ...(k < letters.length - 1 ? [{ select: select(`tb-${k}`), keys: looped([{ at: 0, o: 0, s: 0.4 }, { at: AT.spread + 0.4 + k * 0.08, o: 0, s: 0.4 }, { at: AT.spread + 1 + k * 0.08, o: 1, s: 1, ease: "decelerate" }, { at: AT.gather, o: 1, s: 1 }, { at: AT.gather + 0.6, o: 0, s: 0.4, ease: "accelerate" }], close) }] : []),
    ]);
    // The unit: the camera on one block, which lands on xs as the steps build beside it.
    const grows = STEPS.map((_, k) => AT.grow + k * 0.55);
    const stairs: Track[] = [
      { select: select("unit"), keys: looped([{ at: 0, x: 0, y: 0, o: 1 }, { at: AT.land, x: 0, y: 0 }, { at: AT.grow, x: xs.x - unit.x, y: xs.y + xs.h - unit.y - unit.h, ease: "standard" }, { at: AT.grow + 0.1, o: 1 }, { at: AT.grow + 0.2, o: 0 }], close) },
      ...grows.flatMap((at, k): Track[] => [
        { select: select(`st-${k}`), keys: looped([{ at: 0, o: 0, ...(tall ? { sx: 0 } : { sy: 0 }) }, { at: at - 0.01, o: 0 }, { at, o: 1 }, { at: at + 0.6, ...(tall ? { sx: 1 } : { sy: 1 }), ease: "decelerate" }], close) },
        shown(`st-n${k}`, at + 0.1),
      ]),
      shown("st-read", AT.grow), ...reveal("st-unit", AT.grow + 0.4, copy.unit, close),
      ...rollerTracks("stp", STEPS.map(([, px]) => String(px)), STEPS.length - 1, grows.map((at, k) => [at, k] as [number, number]), g.lines.stp ?? 0, close, 0.4),
      ...rollerTracks("stn", STEPS.map(([, px]) => String(count(px))), STEPS.length - 1, grows.map((at, k) => [at, k] as [number, number]), g.lines.stn ?? 0, close, 0.4),
      ...rollerTracks("sts", STEPS.map(([name]) => name), STEPS.length - 1, grows.map((at, k) => [at, k] as [number, number]), g.lines.sts ?? 0, close, 0.4),
    ];
    // Explode: the parts step apart (field gap in the middle), each space fills row by row, the card snaps shut on them, the rows squeeze out.
    const parts: Array<[BandId, number]> = [["hg", -2 * E], ["pt", -E], ["fg", -E], ["pb", E]];
    const fillAt: Record<BandId, number> = { fg: AT.count, hg: AT.fill, pt: AT.fill + 0.5, pb: AT.fill + 1 };
    const pace = (band: BandId) => (band === "fg" ? 0.5 : 0.08);
    const explode: Track[] = [
      move('[data-t="ex"] [data-slot="form-section-header"]', -4 * E), move(select("ex-f1"), -E), move(select("ex-f2"), E),
      ...parts.map(([band, y]) => move(select(`ex-${band}`), y)),
      ...parts.flatMap(([band]) => Array.from({ length: rows(band) }, (_, j): Track => {
        const sep = (j - (rows(band) - 1) / 2) * ROW_GAP;
        const at = fillAt[band] + j * pace(band);
        return {
          select: select(`ex-${band}-${j}`),
          keys: looped([
            { at: 0, o: 0, y: 0, sx: 1 }, { at: AT.open, y: 0 }, { at: AT.open + 1.2, y: sep, ease: "emphasized" }, { at: at - 0.01, o: 0 }, { at, o: 1 },
            { at: AT.shut, y: sep }, { at: AT.shut + 1.2, y: 0, ease: "standard" }, { at: AT.squeeze, sx: 1, o: 1 }, { at: AT.squeeze + 0.9, sx: 0, o: 0, ease: "accelerate" },
          ], close),
        };
      })),
      ...parts.flatMap(([band]) => reveal(`ex-${band}-tag`, fillAt[band] + rows(band) * pace(band), String(bandTag(band)), close)),
      shown("ex-read", AT.count - 0.4),
      ...rollerTracks("exp", Array.from({ length: rows("fg") }, (_, j) => String((j + 1) * 4)), rows("fg") - 1, Array.from({ length: rows("fg") }, (_, j) => [AT.count + j * 0.5, j] as [number, number]), g.lines.exp ?? 0, close, 0.3),
      ...rollerTracks("exn", Array.from({ length: rows("fg") }, (_, j) => String(j + 1)), rows("fg") - 1, Array.from({ length: rows("fg") }, (_, j) => [AT.count + j * 0.5, j] as [number, number]), g.lines.exn ?? 0, close, 0.3),
    ];
    // Rhythm: the three brackets show, then pulse small, medium, large, twice.
    const rhythm: Track[] = RHYTHM.map((_, k): Track => {
      const at = AT.rhythm + TRANSITION + 0.2 + k * 0.6;
      const beats = [AT.pulse + k * 0.6, AT.pulse + 2 + k * 0.6];
      return {
        select: select(`rh-${k}`),
        keys: looped([
          { at: 0, o: 0, s: 1 }, { at, o: 0 }, { at: at + 0.5, o: 1, ease: "decelerate" },
          ...beats.flatMap((b): Key[] => [{ at: b, s: 1 }, { at: b + 0.25, s: 1.14, ease: "decelerate" }, { at: b + 0.7, s: 1, ease: "standard" }]),
        ], close),
      };
    });
    // Density: both copies' spaces fill; the compact inset's two extra rows drop out; its readout rolls 24 → 16.
    const show = AT.density + TRANSITION + 0.2;
    const density: Track[] = (["dc", "dk"] as const).flatMap((copyName) => (["hg", "pt", "fg", "pb"] as BandId[]).flatMap((band, b) => Array.from({ length: rows(band) }, (_, j): Track => {
      const at = show + b * 0.3 + j * 0.05;
      const extra = copyName === "dk" && ((band === "pt" && j < 2) || (band === "pb" && j >= rows(band) - 2));
      const drop = AT.drop + (band === "pt" ? j : 2 + j - (rows(band) - 2)) * 0.4;
      return {
        select: select(`${copyName}-${band}-${j}`),
        keys: looped([{ at: 0, o: 0, y: 0 }, { at: at - 0.01, o: 0 }, { at, o: 1 }, ...(extra ? [{ at: drop, o: 1, y: 0 }, { at: drop + 0.8, o: 0, y: band === "pt" ? -14 : 14, ease: "accelerate" as const }] : [])], close),
      };
    })));
    const tracks: Track[] = [
      ...introTracks(copy.title, copy.lead, close), ...title, ...stairs, ...explode, ...rhythm, ...density,
      ...rollerTracks("dnp", ["24", "16"], 1, [[0, 0], [AT.drop + 1.8, 1]], g.lines.dnp ?? 0, close, 0.6),
    ];
    return { tracks, camera };
  };
}

export const SPACING_END = AT.end;
