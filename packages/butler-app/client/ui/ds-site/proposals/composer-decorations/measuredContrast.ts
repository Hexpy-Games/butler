export interface ContrastRow { primary: number; placeholder: number; secondary: number; icons: number }

export const MEASURED_ON = "2026-10-06";

/**
 * From .tmp/decor/contrast2.ts on this build: worst case across 1280/375, at rest and open with
 * a long draft, four animation frames each. "Primary" covers the draft and control labels,
 * "secondary" the model detail, "icons" the toolbar icons.
 */
export const MEASURED: Array<{ id: string; label: string; theme: string; values: ContrastRow }> = [
  { id: "a-light", label: "Shoreline (a) accept", theme: "Light", values: { primary: 2.72, placeholder: 2.57, secondary: 1.0, icons: 1.05 } },
  { id: "a-dark", label: "Shoreline (a) accept", theme: "Dark", values: { primary: 5.73, placeholder: 2.93, secondary: 2.18, icons: 3.71 } },
  { id: "b-light", label: "Shoreline (b) waterline low", theme: "Light", values: { primary: 11.66, placeholder: 3.76, secondary: 3.48, icons: 3.51 } },
  { id: "b-dark", label: "Shoreline (b) waterline low", theme: "Dark", values: { primary: 10.35, placeholder: 4.08, secondary: 4.29, icons: 4.64 } },
  { id: "c-light", label: "(c) no shoreline: plain glass", theme: "Light", values: { primary: 14.4, placeholder: 4.87, secondary: 4.76, icons: 5.02 } },
  { id: "c-dark", label: "(c) no shoreline: plain glass", theme: "Dark", values: { primary: 15.5, placeholder: 6.21, secondary: 5.42, icons: 6.88 } },
  { id: "d-light", label: "Shoreline (d) tone gradient", theme: "Light", values: { primary: 5.92, placeholder: 3.13, secondary: 2.02, icons: 2.12 } },
  { id: "d-dark", label: "Shoreline (d) tone gradient", theme: "Dark", values: { primary: 6.2, placeholder: 3.32, secondary: 2.08, icons: 3.7 } },
  { id: "cl-light", label: "Cherry blossom, lush corner", theme: "Light", values: { primary: 9.81, placeholder: 4.87, secondary: 4.77, icons: 5.02 } },
  { id: "cl-dark", label: "Cherry blossom, lush corner", theme: "Dark", values: { primary: 12.8, placeholder: 6.21, secondary: 4.1, icons: 6.88 } },
  { id: "cf-light", label: "Cherry blossom, padding only", theme: "Light", values: { primary: 13.06, placeholder: 4.87, secondary: 4.75, icons: 5.02 } },
  { id: "cf-dark", label: "Cherry blossom, padding only", theme: "Dark", values: { primary: 14.11, placeholder: 6.21, secondary: 4.18, icons: 6.88 } },
];
