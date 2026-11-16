import generated from "./tokens.generated.json";

export type Scheme = "light" | "dark";
type Light = (typeof generated)["light"];
type Dark = (typeof generated)["dark"];
type Key<K extends keyof Light & keyof Dark> = keyof Light[K] & keyof Dark[K] & string;

export type EasingToken = { bezier: number[] } | { linear: number[][] };
export type ShadowToken = {
  offsetX: number;
  offsetY: number;
  blurRadius: number;
  spreadDistance: number;
  color: string;
  inset: boolean;
};

export interface Tokens {
  scheme: Scheme;
  color(name: Key<"Color">): string;
  length(name: Key<"Length">): number;
  number(name: Key<"Number">): number;
  duration(name: Key<"Duration">): number; // ms
  easing(name: Key<"Easing">): EasingToken;
  shadow(name: Key<"Shadow">): ShadowToken[]; // valid as RN `boxShadow`
}

const cache: Partial<Record<Scheme, Tokens>> = {};

export function tokens(scheme: Scheme): Tokens {
  const cached = cache[scheme];
  if (cached) return cached;
  const set = generated[scheme] as unknown as Record<string, Record<string, unknown>>;
  const read = <T>(group: string, name: string): T => set[group][name] as T;
  const created: Tokens = {
    scheme,
    color: (name) => read<string>("Color", name),
    length: (name) => read<number>("Length", name),
    number: (name) => read<number>("Number", name),
    duration: (name) => read<number>("Duration", name),
    easing: (name) => read<EasingToken>("Easing", name),
    shadow: (name) => read<ShadowToken[]>("Shadow", name),
  };
  cache[scheme] = created;
  return created;
}

type Rgba = [number, number, number, number];

function parse(color: string): Rgba {
  const match = /^rgba\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\s*\)$/.exec(color);
  if (!match) throw new Error(`not an rgba() colour: ${color}`);
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
}

function format([r, g, b, a]: Rgba): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Number(a.toFixed(4))})`;
}

/** `color-mix(in srgb, <color> <factor*100>%, transparent)`: multiplies the alpha. */
export function alpha(color: string, factor: number): string {
  const [r, g, b, a] = parse(color);
  return format([r, g, b, a * factor]);
}

/** `color-mix(in srgb, a <weight*100>%, b)`, premultiplied like CSS. */
export function mix(a: string, weight: number, b: string): string {
  const [ar, ag, ab, aa] = parse(a);
  const [br, bg, bb, ba] = parse(b);
  const wa = weight * aa;
  const wb = (1 - weight) * ba;
  const out = wa + wb;
  if (out === 0) return format([0, 0, 0, 0]);
  return format([
    (ar * wa + br * wb) / out,
    (ag * wa + bg * wb) / out,
    (ab * wa + bb * wb) / out,
    out,
  ]);
}

/** A CSS `linear()` easing from the token's `[value, progress]` points. */
export function linearEasing(points: number[][]): (t: number) => number {
  const sorted = [...points].sort((p, q) => p[1] - q[1]);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return (t) => {
    if (t <= first[1]) return first[0];
    if (t >= last[1]) return last[0];
    const upper = sorted.findIndex((point) => point[1] >= t);
    const [v0, p0] = sorted[upper - 1];
    const [v1, p1] = sorted[upper];
    return p1 === p0 ? v1 : v0 + ((v1 - v0) * (t - p0)) / (p1 - p0);
  };
}
