export interface ContrastRow { primary: number; placeholder: number; secondary: number; icons: number }

export const MEASURED_ON = "2026-10-06";

/**
 * From .tmp/decor/contrast2.ts on this build: worst case across 1280/375, at rest and open with
 * a long draft, four animation frames each. Scrolled drafts are measured twice: every visible line, and
 * only the lines below the top padding (scrolled lines pass under the top band of the canopy). "Primary" covers the draft and control labels,
 * "secondary" the model detail, "icons" the toolbar icons.
 */
export const MEASURED: Array<{ id: string; label: string; theme: string; values: ContrastRow }> = [
  { id: "d-light", label: "Shoreline, owner setting (default)", theme: "Light", values: { primary: 9.87, placeholder: 2.96, secondary: 2.99, icons: 2.32 } },
  { id: "d-dark", label: "Shoreline, owner setting (default)", theme: "Dark", values: { primary: 5.86, placeholder: 2.87, secondary: 1.95, icons: 4.46 } },
  { id: "c1-light", label: "Cherry canopy, 1-line draft", theme: "Light", values: { primary: 14.38, placeholder: 4.87, secondary: 4.77, icons: 5.06 } },
  { id: "c1-dark", label: "Cherry canopy, 1-line draft", theme: "Dark", values: { primary: 15.53, placeholder: 6.2, secondary: 5.42, icons: 6.71 } },
  { id: "c3-light", label: "Cherry canopy, 3-line draft", theme: "Light", values: { primary: 6.75, placeholder: 4.87, secondary: 4.81, icons: 5.08 } },
  { id: "c3-dark", label: "Cherry canopy, 3-line draft (scrolls at 375)", theme: "Dark", values: { primary: 2.31, placeholder: 6.2, secondary: 5.47, icons: 6.86 } },
  { id: "c6-light", label: "Cherry canopy, 6-line draft (scrolls)", theme: "Light", values: { primary: 5.14, placeholder: 4.87, secondary: 4.69, icons: 5.06 } },
  { id: "c6-dark", label: "Cherry canopy, 6-line draft (scrolls)", theme: "Dark", values: { primary: 1.05, placeholder: 6.2, secondary: 5.42, icons: 6.41 } },
  { id: "cb-light", label: "Cherry canopy, 3- and 6-line drafts, lines below the top padding", theme: "Light", values: { primary: 6.84, placeholder: 4.87, secondary: 4.76, icons: 5.08 } },
  { id: "cb-dark", label: "Cherry canopy, 3- and 6-line drafts, lines below the top padding", theme: "Dark", values: { primary: 7.0, placeholder: 6.2, secondary: 5.42, icons: 6.86 } },
  { id: "c-light", label: "No decoration: plain glass", theme: "Light", values: { primary: 14.4, placeholder: 4.87, secondary: 4.76, icons: 5.02 } },
  { id: "c-dark", label: "No decoration: plain glass", theme: "Dark", values: { primary: 15.5, placeholder: 6.21, secondary: 5.42, icons: 6.88 } },
];
