import { fit, focus, type Box, type Key, type Pose, type Track } from "../../heroTimeline";
import { SETTLE, TRANSITION } from "../shared/beats";
import { gatherFlights } from "../shared/gather";
import { select } from "../shared/Reveal";
import { REST, scenePath, viewCell } from "../shared/scene";
import type { SceneContext, SceneGeometry, SceneSpec } from "./types";

const center = (box: Box) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });

const union = (boxes: Box[]): Box => {
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  return { x, y, w: Math.max(...boxes.map((box) => box.x + box.w)) - x, h: Math.max(...boxes.map((box) => box.y + box.h)) - y };
};

/**
 * The finale's pose: the poster at rest on the wide canvas; on the tall
 * canvas the whole poster fitted into the portrait frame (nothing cropped).
 */
export function posterPose(g: SceneGeometry): Pose {
  const tiles = Object.values(g.tiles);
  if (g.layout === "wide" || !tiles.length) return REST;
  const all = union(tiles);
  const frame = { x: 0, y: 0, w: g.canvas.w, h: Math.max(g.canvas.h, all.y + all.h + 20) };
  return focus(g.canvas, frame, Math.min(1, fit(g.canvas, frame, 1, 1)));
}

/**
 * Every track of one scene hero's cycle: the chapter's scenes (its regions
 * in cells along a one-axis path that steps on into the poster), then the
 * finale, where the camera moves on to the poster as its tiles fly in from
 * the frame's nearest edges (inner tiles first, no crossing), a hold, and a
 * loop that fades the poster and cuts back to the opening.
 */
export function sceneTracks(spec: SceneSpec, g0: SceneGeometry): { beats: number; tracks: Track[]; still: Pose; marks: number[] } {
  const { canvas } = g0;
  const finale = spec.end(g0);
  const loop = finale + TRANSITION + SETTLE;
  const beats = loop + TRANSITION + 1.5;
  const close = beats - 0.05;
  const rest = posterPose(g0);
  // The poster's middle is the path's end: the last scene stands one step before it.
  const poster = { x: canvas.w / 2 - (rest.x ?? 0) / (rest.s ?? 1), y: canvas.h / 2 - (rest.y ?? 0) / (rest.s ?? 1) };
  const path = scenePath(spec.scenes.length + 1, poster, canvas);
  const cells = Object.fromEntries(spec.scenes.map((name, k) => [name, path[k]!])) as Record<string, { x: number; y: number }>;
  const offset = (cell: string) => {
    const to = cells[cell];
    return to ? { x: to.x - canvas.w / 2, y: to.y - canvas.h / 2 } : { x: 0, y: 0 };
  };
  const g: SceneGeometry = {
    ...g0,
    boxes: Object.fromEntries(Object.entries(g0.boxes).map(([name, box]) => {
      const move = g0.boxCell[name] ? offset(g0.boxCell[name]!) : { x: 0, y: 0 };
      return [name, { ...box, x: box.x + move.x, y: box.y + move.y }];
    })),
  };
  const view = (cell: string, content: Box, fill?: number, cap?: number): Pose => viewCell(canvas, cells[cell] ?? center(content), content, fill, cap);
  const ctx: SceneContext = { g, cells, view, offset, close, finale, loop, beats };
  const own = spec.tracks(ctx);
  const start = own.camera[0] ?? { at: 0, ...REST };
  const last = own.camera.at(-1) ?? start;
  const world: Key[] = [
    ...own.camera, { ...last, at: finale }, { at: finale + TRANSITION, ...rest, ease: "standard" },
    // The loop cuts back to the opening once the poster has faded (the camera never turns back).
    { at: loop + TRANSITION - 0.01, ...rest }, { ...start, at: loop + TRANSITION },
  ];
  const regions: Track[] = spec.scenes.map((name) => {
    const [from = 0, to = finale] = spec.spans?.[name] ?? [];
    const shown = from > 0 ? 0 : 1;
    if (spec.deep?.includes(name)) {
      // Shown and hidden by a cut in scale: an opacity animation would flatten its 3D.
      const on = { ...offset(name), s: 1 };
      const off = { ...offset(name), s: 0.001 };
      return {
        select: `[data-cell="${name}"]`,
        keys: [{ at: 0, ...(shown ? on : off) }, ...(from > 0 ? [{ at: from - 0.01, ...off }, { at: from, ...on }] : []), { at: to + 1.39, ...on }, { at: to + 1.4, ...off }, { at: loop + TRANSITION }, { at: loop + TRANSITION + 0.01, ...(shown ? on : off) }, { at: close }],
      };
    }
    return {
      select: `[data-cell="${name}"]`,
      keys: [
        { at: 0, ...offset(name), o: shown }, ...(from > 0 ? [{ at: from - 0.01, o: 0 }, { at: from, o: 1 }] : []), { at: to + 0.4, o: 1 }, { at: to + 1.4, o: 0, ease: "accelerate" },
        { at: loop + TRANSITION }, { at: loop + TRANSITION + 0.01, o: shown }, { at: close },
      ],
    };
  });
  // Tiles fly in from the frame's nearest edges; each shows as it sets off.
  const flights = gatherFlights(g0.tiles, null, finale);
  const zoom = spec.posterZoom?.[g0.layout] ?? (g0.layout === "wide" ? 1 : 1.2);
  const tiles: Track[] = Object.entries(flights).map(([id, flight]) => {
    const from = { x: flight.from.x / zoom, y: flight.from.y / zoom };
    return {
      select: select(`tile-${id}`),
      keys: [
        { at: 0, ...from, o: 0 }, { at: flight.start, ...from, o: 0 }, { at: flight.start + 0.5, o: 1 }, { at: flight.end, x: 0, y: 0, ease: "decelerate" },
        { at: loop + 0.2 }, { at: loop + TRANSITION / 2 + 0.2, o: 0, ease: "accelerate" }, { at: close - 0.01 }, { at: close, ...from, o: 0 },
      ],
    };
  });
  return { beats, still: rest, marks: [finale, finale + TRANSITION + 2], tracks: [{ select: select("world"), keys: world }, ...regions, ...own.tracks, ...tiles] };
}
