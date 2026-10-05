import type { CSSProperties } from "react";
import type { ShoreOption } from "./decorationScenes";

/**
 * The shoreline's look, one model for every option (CSS and the live contrast readout both
 * read it). Nothing here is local to the text: each term covers the whole scene.
 * - wl: the waterline, px above the card's bottom edge (null: the card's vertical middle);
 * - exp: exposure (light mode): a brightness grade of the scene;
 * - hl: sand highlight tone-down (light mode): the sand above the waterline multiplied by 1 - hl;
 * - gs/g0/g1: a soft vertical tone gradient toward the theme's glass tint, strength gs, from g0%
 *   to g1% of the card height.
 */
export interface ShoreParams { wl: number | null; exp: number; hl: number; gs: number; g0: number; g1: number }

export const SHORE_PRESETS: Record<Exclude<ShoreOption, "c">, ShoreParams> = {
  a: { wl: null, exp: 1.22, hl: 0.06, gs: 0, g0: 50, g1: 100 },
  // (b), raised: 10px of water instead of round 3's 6px; any higher puts surf behind the toolbar labels
  b: { wl: 10, exp: 1.22, hl: 0.06, gs: 0, g0: 50, g1: 100 },
  d: { wl: 12, exp: 1.25, hl: 0.04, gs: 0.3, g0: 75, g1: 100 },
};

export const SHORE_SLIDERS: Array<{ key: Exclude<keyof ShoreParams, "wl"> | "wl"; label: string; min: number; max: number; step: number }> = [
  { key: "wl", label: "Waterline (px above the bottom edge)", min: 0, max: 60, step: 1 },
  { key: "exp", label: "Exposure (light)", min: 0.7, max: 1.4, step: 0.01 },
  { key: "hl", label: "Sand highlight tone-down (light)", min: 0, max: 0.4, step: 0.01 },
  { key: "gs", label: "Gradient strength", min: 0, max: 0.9, step: 0.01 },
  { key: "g0", label: "Gradient start (% of card height)", min: 0, max: 100, step: 1 },
  { key: "g1", label: "Gradient end (% of card height)", min: 0, max: 100, step: 1 },
];

/** (d) reads `d_wl`, `d_exp`, `d_hl`, `d_gs`, `d_g0`, `d_g1` from the URL; the others are fixed. */
export function readShoreParams(option: ShoreOption, search: string): ShoreParams {
  if (option !== "d") return SHORE_PRESETS[option === "c" ? "b" : option];
  const params = new URLSearchParams(search);
  const base = SHORE_PRESETS.d;
  const num = (key: string, fallback: number) => {
    const value = Number(params.get(`d_${key}`));
    return params.has(`d_${key}`) && Number.isFinite(value) ? value : fallback;
  };
  return { wl: num("wl", base.wl ?? 12), exp: num("exp", base.exp), hl: num("hl", base.hl), gs: num("gs", base.gs), g0: num("g0", base.g0), g1: num("g1", base.g1) };
}

export function shoreSearch(params: ShoreParams): Array<[string, string]> {
  return [["d_wl", String(params.wl ?? 12)], ["d_exp", String(params.exp)], ["d_hl", String(params.hl)],
    ["d_gs", String(params.gs)], ["d_g0", String(params.g0)], ["d_g1", String(params.g1)]];
}

/** Waterline as a CSS `top` for the scene canvas (its own middle sits on the waterline). */
export function waterlineTop(params: ShoreParams): string {
  return params.wl === null ? "50%" : `calc(100% - ${params.wl}px)`;
}

export function shoreStyle(params: ShoreParams): CSSProperties {
  return {
    "--shore-top": waterlineTop(params),
    "--shore-exp": String(params.exp),
    "--shore-hl": `${Math.round(params.hl * 100)}%`,
    "--shore-gs": `${Math.round(params.gs * 100)}%`,
    "--shore-g0": `${params.g0}%`,
    "--shore-g1": `${params.g1}%`,
  } as CSSProperties;
}
