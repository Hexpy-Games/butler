/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { NavRow } from "../NavRow";
import { SessionRow } from "../SessionRow";
import { SidebarBrand, SidebarNav, SidebarShell } from "./SidebarShell";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const flat = (css: string) => css.replace(/\s+/gu, " ");
const tokens = flat(read("../../tokens.css"));
const shellCss = flat(read("./SidebarShell.module.css"));
const navRowCss = flat(read("../NavRow/NavRow.module.css"));

const densities = ["compact", "comfortable", "touch"] as const;
const DENSITY_TOKENS = [
  "--sidebar-row-height",
  "--sidebar-row-padding-inline",
  "--sidebar-icon-size",
  "--sidebar-row-gap",
  "--sidebar-row-spacing",
  "--sidebar-action-size",
] as const;

function densityBlock(density: string): string {
  const match = new RegExp(`\\[data-sidebar-density="${density}"\\] \\{([^}]*)\\}`, "u").exec(tokens);
  return match?.[1] ?? "";
}

function px(block: string, name: string): number {
  const value = new RegExp(`${name}: ([^;]+);`, "u").exec(block)?.[1] ?? "";
  const known: Record<string, number> = {
    "var(--control-height-sm)": 28, "var(--control-height-md)": 30, "var(--touch-target)": 44,
    "var(--icon-size-sm)": 14, "var(--icon-size-md)": 16, "var(--icon-size-lg)": 20,
  };
  return known[value] ?? Number.parseFloat(value);
}

test("each sidebar density defines row height, padding, icon size, gap and action size tokens", () => {
  for (const density of densities) {
    const block = densityBlock(density);
    for (const name of DENSITY_TOKENS) expect(block, `${density} ${name}`).toContain(`${name}:`);
  }
  // compact < comfortable < touch for row height and icon size.
  const heights = densities.map((density) => px(densityBlock(density), "--sidebar-row-height"));
  const icons = densities.map((density) => px(densityBlock(density), "--sidebar-icon-size"));
  expect(heights).toEqual([...heights].sort((a, b) => a - b));
  expect(new Set(heights).size).toBe(3);
  expect(icons).toEqual([...icons].sort((a, b) => a - b));
  expect(new Set(icons).size).toBe(3);
  expect(tokens).toContain("--touch-target: 44px;");
  // The touch density meets the 44px target; comfortable becomes touch on phones and coarse pointers.
  expect(px(densityBlock("touch"), "--sidebar-row-height")).toBeGreaterThanOrEqual(44);
  expect(tokens).toMatch(/@media \(width <= 640px\), \(pointer: coarse\) \{ \[data-sidebar-density="comfortable"\] \{/u);
});

test("SidebarShell, NavRow and SessionRow expose density as a prop, comfortable by default", () => {
  const markup = renderToStaticMarkup(
    <>
      <SidebarShell ariaLabel="Nav"><NavRow label="Row" /></SidebarShell>
      <SidebarShell density="compact" ariaLabel="Nav"><NavRow label="Row" /></SidebarShell>
      <NavRow label="Touch row" density="touch" />
      <SessionRow title="Session" density="compact" />
    </>,
  );
  const document = new JSDOM(markup).window.document;
  const shells = document.querySelectorAll('[data-test-class="app-sidebar"]');
  expect(shells[0]?.getAttribute("data-sidebar-density")).toBe("comfortable");
  expect(shells[1]?.getAttribute("data-sidebar-density")).toBe("compact");
  // Rows inside a shell inherit its density; an explicit row density overrides it.
  expect(shells[0]?.querySelector("[data-sidebar-density]")).toBeNull();
  const rows = [...document.querySelectorAll("body > [data-sidebar-density]:not([data-test-class=\"app-sidebar\"])")];
  expect(rows.map((row) => row.getAttribute("data-sidebar-density"))).toEqual(["touch", "compact"]);
});

test("NavRow reads the density tokens for row height, inline padding, icon size and gap", () => {
  expect(navRowCss).toContain("min-height: var(--sidebar-row-height");
  expect(navRowCss).toContain("padding: 0 var(--sidebar-row-padding-inline");
  expect(navRowCss).toContain("width: var(--sidebar-icon-size");
  expect(navRowCss).toContain("gap: var(--sidebar-row-gap");
});

test("the shell owns the sidebar surface: icon actions, sticky material, headings and brand", () => {
  for (const declaration of [
    "--clickable-action-size: var(--sidebar-action-size)",
    "--clickable-action-icon-size: var(--sidebar-icon-size)",
    "--icon-button-radius: var(--radius-control)",
    "--nav-sticky-surface: transparent",
    "--nav-section-heading-min-height: var(--sidebar-action-size)",
    "--nav-tree-indent: var(--space-sm)",
  ]) {
    expect(shellCss).toContain(declaration);
  }
  const markup = renderToStaticMarkup(
    <SidebarShell ariaLabel="Nav" titlebar={<SidebarBrand>Butler</SidebarBrand>}>
      <SidebarNav ariaLabel="Primary"><NavRow label="New" /></SidebarNav>
    </SidebarShell>,
  );
  const document = new JSDOM(markup).window.document;
  expect(document.querySelector('[data-slot="sidebar-brand"]')?.textContent).toBe("Butler");
  expect(document.querySelector("nav")?.getAttribute("aria-label")).toBe("Primary");
});

test("NavRow reserveIcon keeps the icon column empty without inline styles", () => {
  const markup = renderToStaticMarkup(<NavRow label="More (3)" reserveIcon />);
  const document = new JSDOM(markup).window.document;
  const slot = document.querySelector('[data-slot="nav-row-icon"]');
  expect(slot).not.toBeNull();
  expect(slot?.children).toHaveLength(0);
  expect(markup).not.toContain("style=");
});
