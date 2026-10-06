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
  { id: "sp-light", label: "Cherry (B) over the card (recommended)", theme: "Light", values: { primary: 14.4, placeholder: 4.87, secondary: 4.69, icons: 4.99 } },
  { id: "sp-dark", label: "Cherry (B) over the card (recommended)", theme: "Dark", values: { primary: 6.32, placeholder: 6.22, secondary: 4.93, icons: 5.85 } },
  { id: "in-light", label: "Cherry (A) into the empty side (long draft)", theme: "Light", values: { primary: 9.65, placeholder: 4.87, secondary: 4.77, icons: 5.02 } },
  { id: "in-dark", label: "Cherry (A) into the empty side (long draft)", theme: "Dark", values: { primary: 1.05, placeholder: 6.2, secondary: 5.43, icons: 6.66 } },
  { id: "co-light", label: "Cherry deep corner (baseline)", theme: "Light", values: { primary: 10.19, placeholder: 4.87, secondary: 4.81, icons: 5.02 } },
  { id: "co-dark", label: "Cherry deep corner (baseline)", theme: "Dark", values: { primary: 4.12, placeholder: 6.2, secondary: 5.42, icons: 6.88 } },
  { id: "c-light", label: "No decoration: plain glass", theme: "Light", values: { primary: 14.4, placeholder: 4.87, secondary: 4.76, icons: 5.02 } },
  { id: "c-dark", label: "No decoration: plain glass", theme: "Dark", values: { primary: 15.5, placeholder: 6.21, secondary: 5.42, icons: 6.88 } },
];
