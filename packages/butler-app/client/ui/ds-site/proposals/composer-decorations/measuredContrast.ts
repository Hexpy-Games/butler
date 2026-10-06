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
  { id: "cd-light", label: "Cherry canopy, deep corner (default)", theme: "Light", values: { primary: 10.41, placeholder: 4.87, secondary: 4.77, icons: 5.02 } },
  { id: "cd-dark", label: "Cherry canopy, deep corner (default)", theme: "Dark", values: { primary: 5.33, placeholder: 6.2, secondary: 5.42, icons: 5.91 } },
  { id: "cf-light", label: "Cherry canopy, padding only", theme: "Light", values: { primary: 10.41, placeholder: 4.87, secondary: 4.77, icons: 5.03 } },
  { id: "cf-dark", label: "Cherry canopy, padding only", theme: "Dark", values: { primary: 5.33, placeholder: 6.2, secondary: 5.42, icons: 6.88 } },
  { id: "c-light", label: "No decoration: plain glass", theme: "Light", values: { primary: 14.4, placeholder: 4.87, secondary: 4.76, icons: 5.02 } },
  { id: "c-dark", label: "No decoration: plain glass", theme: "Dark", values: { primary: 15.5, placeholder: 6.21, secondary: 5.42, icons: 6.88 } },
];
