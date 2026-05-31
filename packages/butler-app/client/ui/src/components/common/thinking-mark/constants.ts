export const DESIGN_SIZE = 1200;
export const CENTER = DESIGN_SIZE / 2;

export const CONFIG = {
  radius: 435,
  circleWidth: 74,
  ribbonWidth: 68,
  graphRadius: 300,
  activeRadius: 480,
  samples: 180,
} as const;

export const PEAK_POSITIONS = [0.66, 0.31, 0.57, 0.42, 0.73, 0.27, 0.49, 0.62, 0.36, 0.7, 0.53, 0.29];
export const PEAK_HEIGHTS = [0.92, 0.34, 1.16, 0.58, 0.78, 0.22, 1.05, 0.48, 0.86, 0.31, 1.22, 0.64];
export const PEAK_DURATIONS = [190, 330, 240, 420, 210, 300, 170, 380, 260, 450, 220, 350];
export const PEAK_CYCLE_MS = PEAK_DURATIONS.reduce((total, duration) => total + duration, 0);

export const WAVE_LAYERS = [
  { alpha: 0.42, xShift: -0.06, yScale: 0.76, timeShift: 860, peakShift: 7 },
  { alpha: 0.56, xShift: 0.055, yScale: 0.88, timeShift: 430, peakShift: 3 },
  { alpha: 0.62, xShift: 0, yScale: 0.64, timeShift: 0, peakShift: 0 },
] as const;

export interface WaveLayer {
  alpha: number;
  xShift: number;
  yScale: number;
  timeShift: number;
  peakShift: number;
}

export type Side = "top" | "bottom";
export type Point = [number, number];