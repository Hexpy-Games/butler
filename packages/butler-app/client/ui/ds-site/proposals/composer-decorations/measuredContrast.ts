export interface ContrastRow { primary: number; placeholder: number; secondary: number; icons: number }

export const MEASURED_ON = "2026-10-06";

/**
 * From .tmp/decor/contrast2.ts on this build: worst case across 1280/375, at rest and open with
 * a long draft, four animation frames each. "Primary" covers the draft and control labels,
 * "secondary" the model detail, "icons" the toolbar icons. (d) is its default setting.
 */
export const MEASURED: Array<{ id: string; label: string; theme: string; values: ContrastRow }> = [
  { id: "b-light", label: "Shoreline (b) waterline 10px up", theme: "Light", values: { primary: 8.42, placeholder: 3.25, secondary: 2.86, icons: 2.65 } },
  { id: "b-dark", label: "Shoreline (b) waterline 10px up", theme: "Dark", values: { primary: 10.35, placeholder: 4.13, secondary: 4.0, icons: 4.59 } },
  { id: "d-light", label: "Shoreline (d) default", theme: "Light", values: { primary: 10.11, placeholder: 2.72, secondary: 2.9, icons: 3.3 } },
  { id: "d-dark", label: "Shoreline (d) default", theme: "Dark", values: { primary: 9.2, placeholder: 4.12, secondary: 2.9, icons: 4.93 } },
  { id: "c-light", label: "(c) no shoreline: plain glass", theme: "Light", values: { primary: 14.4, placeholder: 4.87, secondary: 4.76, icons: 5.02 } },
  { id: "c-dark", label: "(c) no shoreline: plain glass", theme: "Dark", values: { primary: 15.5, placeholder: 6.21, secondary: 5.42, icons: 6.88 } },
  { id: "cl-light", label: "Cherry blossom, lush corner", theme: "Light", values: { primary: 14.4, placeholder: 4.87, secondary: 4.76, icons: 5.02 } },
  { id: "cl-dark", label: "Cherry blossom, lush corner", theme: "Dark", values: { primary: 6.93, placeholder: 6.21, secondary: 4.66, icons: 6.88 } },
  { id: "cf-light", label: "Cherry blossom, padding only", theme: "Light", values: { primary: 14.4, placeholder: 4.83, secondary: 4.81, icons: 5.06 } },
  { id: "cf-dark", label: "Cherry blossom, padding only", theme: "Dark", values: { primary: 6.93, placeholder: 6.21, secondary: 5.42, icons: 6.88 } },
];
