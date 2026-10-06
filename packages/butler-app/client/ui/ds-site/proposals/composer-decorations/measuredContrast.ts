export interface ContrastRow { primary: number; placeholder: number; secondary: number; icons: number }

export const MEASURED_ON = "2026-10-06";

/**
 * From .tmp/decor/contrast2.ts on this build: worst case across 1280/375, at rest and open with
 * a long draft, four animation frames each. "Primary" covers the draft and control labels,
 * "secondary" the model detail, "icons" the toolbar icons.
 */
export const MEASURED: Array<{ id: string; label: string; theme: string; values: ContrastRow }> = [
  { id: "d-light", label: "Shoreline, owner setting (default)", theme: "Light", values: { primary: 9.87, placeholder: 2.96, secondary: 2.99, icons: 2.32 } },
  { id: "d-dark", label: "Shoreline, owner setting (default)", theme: "Dark", values: { primary: 5.86, placeholder: 2.87, secondary: 1.95, icons: 4.46 } },
  { id: "ci-light", label: "Cherry blossom, illustrated", theme: "Light", values: { primary: 14.4, placeholder: 4.86, secondary: 4.81, icons: 5.02 } },
  { id: "ci-dark", label: "Cherry blossom, illustrated", theme: "Dark", values: { primary: 5.17, placeholder: 6.14, secondary: 3.57, icons: 6.88 } },
  { id: "cp-light", label: "Cherry blossom, pixel art", theme: "Light", values: { primary: 14.29, placeholder: 4.81, secondary: 4.06, icons: 4.75 } },
  { id: "cp-dark", label: "Cherry blossom, pixel art", theme: "Dark", values: { primary: 15.53, placeholder: 6.15, secondary: 5.42, icons: 6.88 } },
  { id: "c-light", label: "No decoration: plain glass", theme: "Light", values: { primary: 14.4, placeholder: 4.87, secondary: 4.76, icons: 5.02 } },
  { id: "c-dark", label: "No decoration: plain glass", theme: "Dark", values: { primary: 15.5, placeholder: 6.21, secondary: 5.42, icons: 6.88 } },
];
