/// <reference types="bun" />

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const flat = (css: string) => css.replace(/\s+/gu, " ").replace(/\( /gu, "(").replace(/ \)/gu, ")");
const tokens = flat(read("../../tokens.css"));
const adaptiveShell = flat(read("../AdaptiveShell/AdaptiveShell.module.css"));
const sidebarShell = flat(read("./SidebarShell.module.css"));
const titlebarShell = flat(read("../TitlebarShell/TitlebarShell.module.css"));
const spaceSidebar = flat(read("../../../../components/space/SpaceSidebar.module.css"));
const baseRoot = /:root \{([^}]*)\}/u.exec(tokens)?.[1] ?? "";
const compactRoot = /@media \(width <= 640px\) \{ :root \{([^}]*)\}/u.exec(tokens)?.[1] ?? "";

test("the sidebar toggle is a standard-size IconButton centered in the titlebar row", () => {
  expect(baseRoot).toContain("--chrome-floating-toggle-size: var(--control-height-md);");
  expect(baseRoot).toContain("--chrome-floating-toggle-icon-size: var(--icon-size-md);");
  expect(baseRoot).toContain(
    "--chrome-floating-toggle-top: calc(var(--safe-area-top) + ((var(--titlebar-height) - var(--chrome-floating-toggle-size)) / 2));",
 );
  expect(tokens).not.toContain("--chrome-floating-toggle-top: 10px");
});

test("the toggle lines up with the sidebar content inset after the traffic-light reserve", () => {
  expect(baseRoot).toContain("--sidebar-padding-inline: 14px;");
  expect(baseRoot).toContain("--chrome-toggle-inset: var(--sidebar-padding-inline);");
  // Touch targets (52px) carry their own inset, so the compact toggle starts at the edge.
  expect(compactRoot).toContain("--chrome-toggle-inset: 0px;");
  // macOS traffic lights: x 20 + three 12px buttons with 8px gaps = 72px.
  expect(baseRoot).toContain("--traffic-controls-width: 72px;");
  const derived = [
    "--chrome-floating-toggle-left: calc(var(--traffic-controls-width) + var(--chrome-toggle-inset));",
    "--sidebar-titlebar-leading: calc(var(--chrome-floating-toggle-left) - var(--sidebar-padding-inline) + var(--chrome-floating-toggle-size) + var(--space-sm));",
    "--titlebar-collapsed-left-padding: calc(var(--chrome-floating-toggle-left) + var(--chrome-floating-toggle-size) + var(--space-md));",
  ];
  for (const declaration of derived) {
    expect(baseRoot).toContain(declaration);
    // Re-declared on the shell root so platform overrides of the reserve flow into it.
    expect(adaptiveShell).toContain(declaration);
  }
  // Platforms only choose the reserve; no ad-hoc toggle offsets.
  expect(adaptiveShell).toContain('.root[data-chrome-environment="browser"] { --traffic-controls-width: 0px; }');
  expect(adaptiveShell).not.toMatch(/--chrome-floating-toggle-left: (?:0|10)px/u);
  expect(adaptiveShell).not.toContain("44px");
});

test("sidebar and workspace titlebars reserve the toggle through tokens", () => {
  expect(sidebarShell).toMatch(/\.shell \{[^}]*padding: 0 var\(--sidebar-padding-inline\) var\(--space-lg\);/u);
  expect(sidebarShell).toMatch(/\.titlebar \{[^}]*padding-inline-start: var\(--sidebar-titlebar-leading\);/u);
  expect(sidebarShell).toMatch(/\.titlebar \{[^}]*height: var\(--titlebar-height\);[^}]*align-items: center;/u);
  expect(titlebarShell).toMatch(/\.collapsed \{[^}]*padding-left: var\(--titlebar-collapsed-left-padding\);/u);
  expect(spaceSidebar).not.toMatch(/\.brand \{[^}]*padding-inline-start/u);
});

test("the sticky header's fade cover only paints while the header is stuck", () => {
  const component = read("./SidebarShell.tsx");
  // The cover is a child so it can query the sticky header's scroll state.
  expect(component).toContain('<div className={styles.stickyCover} aria-hidden="true" />');
  expect(sidebarShell).toContain(".stickyHeader { container-type: scroll-state;");
  expect(sidebarShell).not.toContain(".stickyHeader::before");
  expect(sidebarShell).toMatch(/\.stickyCover \{[^}]*bottom: 100%;[^}]*visibility: hidden;/u);
  expect(sidebarShell).toMatch(/@container scroll-state\(stuck: top\) \{ \.stickyCover \{ visibility: visible; \} \}/u);
});
