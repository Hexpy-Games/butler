import type { Box } from "../../heroTimeline";
import { landSelect } from "./typeAssembly";
import { FLIGHTS, METRIC_ROLL, PANELS, select, type Flight, type TypeGeometry } from "./typeChoreography";

/** The two canvases the hero is authored on: a wide stage and a tall (phone) one. */
export const CANVAS = { wide: { w: 1040, h: 585 }, tall: { w: 380, h: 640 } } as const;
export type TypeLayout = keyof typeof CANVAS;

/** Width (css px) below which the tall canvas is used. */
export const TALL_BELOW = 720;

export interface TypeMeasure {
  geometry: TypeGeometry;
  /** size/leading · weight of each rung's sample, read from the rendered text. */
  specs: Record<Flight, string>;
}

/**
 * Reads the poster layout (no animation applied) in canvas px: boxes are
 * taken relative to the world and divided by the stage's fit scale, so they
 * hold at any stage size. Returns null until everything is laid out.
 */
export function measureType(root: HTMLElement, layout: TypeLayout, words: number): TypeMeasure | null {
  const world = root.querySelector<HTMLElement>(select("world"));
  if (!world || world.offsetWidth === 0) return null;
  const canvas = CANVAS[layout];
  const origin = world.getBoundingClientRect();
  const ratio = origin.width / canvas.w;
  const find = (selector: string) => root.querySelector<HTMLElement>(selector);
  let missing = false;
  const box = (selector: string): Box => {
    const node = find(selector);
    if (!node) {
      missing = true;
      return { x: 0, y: 0, w: 1, h: 1 };
    }
    const rect = node.getBoundingClientRect();
    return { x: (rect.left - origin.left) / ratio, y: (rect.top - origin.top) / ratio, w: Math.max(1, rect.width / ratio), h: Math.max(1, rect.height / ratio) };
  };
  const per = <K extends string>(keys: readonly K[], selector: (key: K) => string) =>
    Object.fromEntries(keys.map((key) => [key, box(selector(key))])) as Record<K, Box>;
  const specs = Object.fromEntries(FLIGHTS.map((flight) => {
    const text = find(select(`fly-${flight}`))?.firstElementChild;
    if (!text) return [flight, ""];
    const style = getComputedStyle(text);
    const px = (value: string) => Math.round(Number.parseFloat(value) || 0);
    return [flight, `${px(style.fontSize)}/${px(style.lineHeight)} · ${style.fontWeight}`];
  })) as Record<Flight, string>;
  const metric = find(select("fly-metric"))?.firstElementChild;
  const glyph = find(select("glyph"));
  const geometry: TypeGeometry = {
    canvas,
    glyph: box(select("glyph")),
    glyphScale: glyph && glyph.offsetWidth ? glyph.getBoundingClientRect().width / ratio / glyph.offsetWidth : 1,
    halves: { latin: box(select("latin")), hangul: box(select("hangul")) },
    ladder: box(select("ladder")),
    rungs: per(FLIGHTS, (flight) => select(`rung-${flight}`)),
    fly: per(FLIGHTS, (flight) => select(`fly-${flight}`)),
    land: per(FLIGHTS, landSelect),
    panels: per(PANELS, (panel) => select(`panel-${panel}`)),
    overlays: per(["axis", "cap-latin", "cap-hangul", "cap-stack", "cap-tnum"] as const, select),
    axisWidth: (find(select("track"))?.offsetWidth ?? 0) || 1,
    digitLine: metric ? Number.parseFloat(getComputedStyle(metric).lineHeight) || 0 : 0,
    digits: [...METRIC_ROLL].filter((char) => /\d/u.test(char)).map(Number),
    words,
  };
  return missing ? null : { geometry, specs };
}
