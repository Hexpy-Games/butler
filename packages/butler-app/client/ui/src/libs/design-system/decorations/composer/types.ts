export type DecorationTheme = "none" | "coastal" | "cherry-blossom" | "flower-field" | "characters";
export interface DecorationOptions {
  theme: Exclude<DecorationTheme, "none">;
  mode: "static" | "interactive";
  intensity: number;
  tone: "light" | "dark";
  inside: boolean;
}

export interface DecorationMetrics {
  fps: number;
  frames: number;
  drawP95: number;
  inputP99: number;
  inputs: number;
  state: "live" | "still" | "hidden" | "unavailable";
}

export const EMPTY_METRICS: DecorationMetrics = {
  fps: 0, frames: 0, drawP95: 0, inputP99: 0, inputs: 0, state: "still",
};
