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
  { id: "c1-light", label: "Cherry canopy, 1-line draft", theme: "Light", values: { primary: 14.38, placeholder: 4.87, secondary: 4.77, icons: 5.02 } },
  { id: "c1-dark", label: "Cherry canopy, 1-line draft", theme: "Dark", values: { primary: 15.53, placeholder: 6.2, secondary: 5.42, icons: 6.77 } },
  { id: "c3-light", label: "Cherry canopy, 3-line draft", theme: "Light", values: { primary: 11.39, placeholder: 4.87, secondary: 4.81, icons: 5.07 } },
  { id: "c3-dark", label: "Cherry canopy, 3-line draft", theme: "Dark", values: { primary: 7.0, placeholder: 6.2, secondary: 5.42, icons: 6.88 } },
  { id: "c6-light", label: "Cherry canopy, 6-line draft (scrolls)", theme: "Light", values: { primary: 10.83, placeholder: 4.87, secondary: 4.73, icons: 5.06 } },
  { id: "c6-dark", label: "Cherry canopy, 6-line draft (scrolls)", theme: "Dark", values: { primary: 7.0, placeholder: 6.2, secondary: 5.42, icons: 6.88 } },
  { id: "c-light", label: "No decoration: plain glass", theme: "Light", values: { primary: 14.4, placeholder: 4.87, secondary: 4.76, icons: 5.02 } },
  { id: "c-dark", label: "No decoration: plain glass", theme: "Dark", values: { primary: 15.5, placeholder: 6.21, secondary: 5.42, icons: 6.88 } },
];
