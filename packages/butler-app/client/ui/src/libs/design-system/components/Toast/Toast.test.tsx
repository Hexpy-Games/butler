/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\s+/gu, " ");
const css = read("./Toast.module.css");
const toaster = read("./Toaster.tsx");

test("every toast takes DS surface, text, border, radius and shadow tokens in both themes", () => {
  const surface = css.match(/\.toast\[data-sonner-toast\]\[data-styled="true"\] \{([^}]*)\}/u)?.[1] ?? "";
  for (const declaration of [
    "--normal-bg: var(--popover)", "--normal-border: var(--line)", "--normal-text: var(--text-primary)",
    "--border-radius: var(--radius-panel)", "box-shadow: var(--shadow-card)",
  ]) expect(surface).toContain(declaration);
  expect(css).toMatch(/\[data-description\] \{[^}]*color: var\(--text-secondary\)/u);
  for (const tone of ["success", "warning", "error"]) {
    expect(css).toMatch(new RegExp(`\\.${tone}\\[data-sonner-toast\\]\\[data-styled="true"\\] \\{[^}]*--normal-bg: var\\(--color-${tone === "error" ? "danger" : tone}-bg\\)`, "u"));
  }
});

test("toasts move with transform and opacity on DS motion tokens; reduced motion fades", () => {
  expect(css).toMatch(/\.toast\[data-sonner-toast\] \{[^}]*transition: transform var\(--motion-enter-overlay\) var\(--motion-ease-enter\), opacity var\(--motion-enter-overlay\) var\(--motion-ease-enter\)/u);
  expect(css).toMatch(/\[data-removed="true"\] \{[^}]*transition-duration: var\(--motion-exit-base\);[^}]*transition-timing-function: var\(--motion-ease-exit\);/u);
  expect(css).toMatch(/\[data-mounted="false"\] \{[^}]*--y: translateY\(calc\(-1 \* var\(--motion-distance-lg\)\)\)/u);
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.toast\[data-sonner-toast\] \{ transition: opacity var\(--motion-fast\) var\(--motion-ease-standard\) !important;/u);
  expect(css).not.toMatch(/transition:[^;]*height/u);
});

test("the DS Toaster owns the shared sonner configuration", () => {
  expect(toaster).toContain('position="top-center"');
  expect(toaster).toContain("gap={8}");
  expect(toaster).toContain("closeButton");
  expect(toaster).toContain("richColors={false}");
  expect(toaster).toContain("classNames: toastClassNames");
});

test("the DS Viewer mounts one Toaster at its root so every toast demo (Motion page included) shows", () => {
  const viewer = read("../../viewer/DesignSystemViewer.tsx");
  const showcase = read("./Toast.showcase.tsx");
  expect(viewer).toMatch(/import \{ Toaster \} from "\.\.\/components\/Toast"/u);
  expect(viewer.match(/<Toaster\b/gu)?.length).toBe(1);
  // Stories only raise toasts; a story-owned Toaster is absent on the Motion page and doubles toasts in two-theme frames.
  expect(showcase).not.toMatch(/<Toaster\b/u);
});
