import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";

// Every DS Viewer item page: no example or states-matrix cell lets its content
// (hover fill, focus ring, text) paint past the cell, and every theme scope
// (side-by-side frames, states matrices) resolves its own text color. Runs
// side-by-side (light and dark panels) at 1440 under a dark system chrome and
// at 900 under a light one, so each panel is nested in the opposite theme once.
// Portaled overlays render outside the cell and are not checked here. A Grid
// (`[data-columns]`) must never be wider than itself: its tracks shrink with
// the container whatever the content. A keyboard-focused NativeSelect rings
// its control box only, never the chevron. Foundations chapters are audited
// the same way (specimens, theme panes) plus page-level sideways scroll, at
// the run width and at 375.
// `bun tests/smoke/ds-viewer-overflow-smoke.ts [ItemName|foundations/<chapter>...]` narrows the run.

const uiRoot = resolve(process.cwd(), "packages", "butler-app", "client", "ui", "dist");
const tempDir = mkdtempSync(join(tmpdir(), "butler-ds-viewer-overflow-"));
const TOLERANCE = 1;
const runs = [
  { width: 1440, colorScheme: "dark" },
  { width: 900, colorScheme: "light" },
] as const;

const FOUNDATION_PAGES = [
  "foundations/color", "foundations/typography", "foundations/spacing", "foundations/sizing", "foundations/radius",
  "foundations/iconography", "foundations/focus", "motion", "foundations/z-index", "foundations/layout",
];

type Offender = { item: string; run: string; cell: string; element: string; overflow: string };

function viewerUrl(baseUrl: string, params: Record<string, string>): string {
  return `${baseUrl}?${new URLSearchParams({ visual: "design-system", ...params }).toString()}`;
}

async function itemIds(page: Page, baseUrl: string): Promise<Map<string, string>> {
  const items = new Map<string, string>();
  for (const gallery of ["components", "blocks"]) {
    await page.goto(viewerUrl(baseUrl, { page: gallery }), { waitUntil: "networkidle" });
    await page.locator(`[data-ds-gallery="${gallery}"]`).waitFor({ state: "attached" });
    const cards = await page.locator("[data-ds-component][data-ds-item]").evaluateAll((elements) =>
      elements.map((element) => [element.getAttribute("data-ds-component")!, element.getAttribute("data-ds-item")!]));
    for (const [name, id] of cards) items.set(name, id);
  }
  return items;
}

/** Runs in the page: cells whose content paints past the cell, and theme scopes with a foreign text color. */
function auditPage({ tolerance, pageScroll }: { tolerance: number; pageScroll: boolean }) {
  type Box = { left: number; top: number; right: number; bottom: number };
  const px = (value: string) => Number.parseFloat(value) || 0;
  const clips = (style: CSSStyleDeclaration) =>
    [style.overflowX, style.overflowY].some((value) => value !== "visible") || style.clipPath !== "none" || style.contain.includes("paint");
  /** Border box plus what a ring paints outside it: outline and zero-offset, zero-blur box-shadows. */
  function paintBox(element: Element, style: CSSStyleDeclaration): Box {
    const rect = element.getBoundingClientRect();
    let extra = 0;
    if (style.outlineStyle !== "none") extra = Math.max(extra, px(style.outlineWidth) + px(style.outlineOffset));
    for (const shadow of style.boxShadow === "none" ? [] : style.boxShadow.split(/,(?![^(]*\))/u)) {
      if (shadow.includes("inset")) continue;
      const lengths = shadow.replace(/rgba?\([^)]*\)|#[\da-f]+|[a-z-]+\([^)]*\)/giu, "").trim().split(/\s+/u).map(px);
      const [x = 0, y = 0, blur = 0, spread = 0] = lengths;
      if (x === 0 && y === 0 && blur === 0) extra = Math.max(extra, spread);
    }
    return { left: rect.left - extra, top: rect.top - extra, right: rect.right + extra, bottom: rect.bottom + extra };
  }
  const describe = (element: Element) => {
    const slot = element.getAttribute("data-slot");
    const text = (element.textContent ?? "").trim().slice(0, 32);
    return `${element.tagName.toLowerCase()}${slot ? `[${slot}]` : ""}${text ? ` "${text}"` : ""}`;
  };

  const cells: Array<[Element, string]> = [
    ...[...document.querySelectorAll("[data-ds-state-cell]")].map((cell): [Element, string] => {
      const theme = cell.closest("[data-ds-states-matrix]")?.className.match(/theme-(\w+)/u)?.[1] ?? "?";
      return [cell, `states ${cell.getAttribute("data-ds-state-cell")} (${theme})`];
    }),
    ...[...document.querySelectorAll("[data-ds-examples] [data-ds-fixture-canvas]")].map((canvas): [Element, string] => {
      const story = canvas.closest("[data-ds-story]")?.getAttribute("data-ds-story") ?? "?";
      const theme = canvas.closest("[data-ds-theme]")?.getAttribute("data-ds-theme") ?? "?";
      return [canvas.parentElement!, `example "${story}" (${theme})`];
    }),
    // Foundations guidebook specimens: type ladder samples, swatches, role panes, ramps.
    ...[...document.querySelectorAll("[data-ds-specimen]")].map((specimen): [Element, string] =>
      [specimen, `specimen "${specimen.getAttribute("data-ds-specimen") || specimen.tagName.toLowerCase()}"`]),
  ];
  // The page itself never scrolls sideways.
  const main = document.querySelector("main");
  const sideways = main ? main.scrollWidth - main.clientWidth : 0;
  const offenders: Array<{ cell: string; element: string; overflow: string }> = [];
  for (const [cell, label] of cells) {
    const bounds = cell.getBoundingClientRect();
    let worst: { element: string; overflow: string; amount: number } | null = null;
    for (const element of cell.querySelectorAll("*")) {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.position === "fixed") continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      let box = paintBox(element, style);
      // Clip by ancestors inside the cell: content scrolled or clipped there never paints past the cell.
      for (let parent = element.parentElement; parent && parent !== cell; parent = parent.parentElement) {
        const parentStyle = getComputedStyle(parent);
        if (!clips(parentStyle)) continue;
        const clip = parent.getBoundingClientRect();
        box = { left: Math.max(box.left, clip.left), top: Math.max(box.top, clip.top), right: Math.min(box.right, clip.right), bottom: Math.min(box.bottom, clip.bottom) };
      }
      if (box.right <= box.left || box.bottom <= box.top) continue;
      const sides = {
        left: bounds.left - box.left, right: box.right - bounds.right, top: bounds.top - box.top, bottom: box.bottom - bounds.bottom,
      };
      const [side, amount] = Object.entries(sides).sort((a, b) => b[1] - a[1])[0]!;
      if (amount > tolerance && (!worst || amount > worst.amount)) {
        worst = { element: describe(element), overflow: `${side} +${Math.round(amount)}px`, amount };
      }
    }
    if (worst) offenders.push({ cell: label, element: worst.element, overflow: worst.overflow });
    for (const grid of cell.querySelectorAll("[data-columns]")) {
      // A grid that scrolls itself (KanbanBoard scroll lanes) is meant to be wider inside.
      if (getComputedStyle(grid).overflowX !== "visible") continue;
      const excess = grid.scrollWidth - grid.clientWidth;
      if (excess > tolerance) {
        offenders.push({ cell: label, element: `grid[${grid.getAttribute("data-columns")}]`, overflow: `tracks +${excess}px` });
      }
    }
  }

  // A theme scope must paint its own text color, not the chrome's inherited one.
  const scopes = [...document.querySelectorAll("[data-ds-theme], [data-ds-states-matrix]")];
  const foreignScopes = scopes.flatMap((scope) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--text-primary)";
    scope.append(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    const actual = getComputedStyle(scope).color;
    return actual === expected ? [] : [{ cell: `theme scope ${scope.className}`, element: "color", overflow: `${actual} != ${expected}` }];
  });
  const page = pageScroll && sideways > tolerance ? [{ cell: "page", element: "main", overflow: `scrolls sideways by ${sideways}px` }] : [];
  return [...offenders, ...foreignScopes, ...page];
}

/** Keyboard-focuses each NativeSelect: the ring belongs on the trigger box, never on the chevron. */
async function auditNativeSelectFocus(page: Page): Promise<Array<{ cell: string; element: string; overflow: string }>> {
  const found: Array<{ cell: string; element: string; overflow: string }> = [];
  const selects = page.locator('[data-ds-examples] select[data-slot="native-select"]:not(:disabled)');
  const count = await selects.count();
  if (count === 0) found.push({ cell: "focus", element: "native-select", overflow: "no enabled select to focus" });
  for (let index = 0; index < count; index += 1) {
    await selects.nth(index).focus();
    const state = await selects.nth(index).evaluate((select) => {
      const wrapper = select.closest('[data-slot="native-select-wrapper"]')!;
      const shadow = (slot: string) => getComputedStyle(wrapper.querySelector(`[data-slot="${slot}"]`)!).boxShadow;
      return { focusVisible: select.matches(":focus-visible"), trigger: shadow("native-select-trigger"), icon: shadow("native-select-icon") };
    });
    const label = `focus #${index}`;
    if (!state.focusVisible) found.push({ cell: label, element: "select", overflow: "not :focus-visible" });
    if (state.icon !== "none") found.push({ cell: label, element: "icon", overflow: `ring on chevron: ${state.icon}` });
    if (state.trigger === "none") found.push({ cell: label, element: "trigger", overflow: "no ring on control box" });
  }
  return found;
}

async function waitForLayout(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
}

if (!existsSync(join(uiRoot, "index.html"))) throw new Error("UI dist is missing. Run `bun run app:ui:build` first.");

const only = new Set(Bun.argv.slice(2).filter((arg) => arg && arg !== "--"));
const server = await createNativeAppServer({ uiRoot });
const browser = await chromium.launch({ headless: true });
const offenders: Offender[] = [];
let checkedPages = 0;
try {
  for (const run of runs) {
    const runLabel = `${run.width} ${run.colorScheme} chrome`;
    const page = await browser.newPage({ viewport: { width: run.width, height: 1000 }, colorScheme: run.colorScheme, deviceScaleFactor: 1 });
    const items = await itemIds(page, server.url);
    for (const [name, id] of items) {
      if (only.size && !only.has(name)) continue;
      await page.goto(viewerUrl(server.url, { page: id, theme: "side-by-side", motion: "reduced" }), { waitUntil: "networkidle" });
      await page.locator(`[data-ds-detail="${name}"] [data-ds-examples]`).waitFor({ state: "visible" });
      await waitForLayout(page);
      for (const found of await page.evaluate(auditPage, { tolerance: TOLERANCE, pageScroll: false })) offenders.push({ item: name, run: runLabel, ...found });
      if (name === "NativeSelect") {
        for (const found of await auditNativeSelectFocus(page)) offenders.push({ item: name, run: runLabel, ...found });
      }
      checkedPages += 1;
    }
    // Foundations chapters (guidebook specimens and their light/dark panes), at this width and at 375.
    for (const width of [run.width, 375]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const chapter of FOUNDATION_PAGES) {
        if (only.size && !only.has(chapter)) continue;
        await page.goto(viewerUrl(server.url, { page: chapter, motion: "reduced", locale: width === 375 ? "ko" : "en" }), { waitUntil: "networkidle" });
        await page.locator("[data-ds-chapter-head]").first().waitFor({ state: "visible" });
        await waitForLayout(page);
        for (const found of await page.evaluate(auditPage, { tolerance: TOLERANCE, pageScroll: true })) offenders.push({ item: chapter, run: `${runLabel} @${width}`, ...found });
        checkedPages += 1;
      }
    }
    await page.close();
  }
} finally {
  await browser.close();
  await server.stop();
  rmSync(tempDir, { recursive: true, force: true });
}

if (offenders.length) {
  for (const offender of offenders) {
    console.error(`${offender.item} [${offender.run}] ${offender.cell}: ${offender.element} ${offender.overflow}`);
  }
  throw new Error(`DS Viewer overflow: ${offenders.length} cell(s) paint past their bounds or theme.`);
}
console.log(JSON.stringify({ ok: true, checkedPages }, null, 2));
