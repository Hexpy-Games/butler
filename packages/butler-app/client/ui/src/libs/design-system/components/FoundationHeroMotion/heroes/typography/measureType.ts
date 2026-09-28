import type { Box } from "../../heroTimeline";
import { measureLines, measureParts } from "./typeLines";
import { FLIGHTS, METRIC_ROLL, PANELS, select, type Flight, type TypeGeometry } from "./typeChoreography";
import { CANVAS, type TypeLayout } from "./typeGrid";

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
export function measureType(root: HTMLElement, layout: TypeLayout): TypeMeasure | null {
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
    return [flight, `${px(style.fontSize)}/${px(style.lineHeight)}${layout === "tall" ? " " : " · "}${style.fontWeight}`];
  })) as Record<Flight, string>;
  const metric = find(select("fly-metric"))?.firstElementChild;
  const specimen = find(select("specimen"));
  const readout = find(select("read-10"));
  const geometry: TypeGeometry = {
    layout,
    canvas,
    specimen: box(select("specimen")),
    specimenScale: specimen && specimen.offsetWidth ? specimen.getBoundingClientRect().width / ratio / specimen.offsetWidth : 1,
    ladder: box(select("ladder")),
    rungs: per(FLIGHTS, (flight) => select(`rung-${flight}`)),
    fly: per(FLIGHTS, (flight) => select(`fly-${flight}`)),
    lines: measureLines(root, ratio) ?? [],
    parts: measureParts(root, ratio),
    panels: per(PANELS, (panel) => select(`panel-${panel}`)),
    control: box(select("control")),
    tnum: box(select("cap-tnum")),
    controlTrack: (find(select("control-track"))?.offsetWidth ?? 0) || 1,
    readoutLine: readout ? Number.parseFloat(getComputedStyle(readout).lineHeight) || 0 : 0,
    digitLine: metric ? Number.parseFloat(getComputedStyle(metric).lineHeight) || 0 : 0,
    digits: [...METRIC_ROLL].filter((char) => /\d/u.test(char)).map(Number),
  };
  return missing || geometry.lines.length === 0 ? null : { geometry, specs };
}
