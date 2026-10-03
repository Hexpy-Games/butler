import { smokeBrowserArgs } from "./smoke-browser-args";
import { chromium, webkit, type Browser, type BrowserContext, type Page } from "playwright";

// DS Viewer on phones (shared by the viewer smoke and the static ds-site smoke): the app's
// AdaptiveShell drawer (opaque surface over a scrim, modal focus, Escape/scrim/toggle/navigate
// close it), a compact titlebar (menu, title, Search, View options), View options without the
// width presets, the Cmd+K palette as a full-width top sheet, 44px targets, no sideways scroll.

export const MOBILE_VIEWPORTS = [
  { label: "375x812", width: 375, height: 812 },
  { label: "430x932", width: 430, height: 932 },
] as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** WebKit (iOS Safari fidelity) when Playwright has it installed, else Chromium. */
export async function launchMobileBrowser(): Promise<{ browser: Browser; engine: string }> {
  if (process.env.BUTLER_SMOKE_BROWSER === "chromium") {
    return { browser: await chromium.launch({ headless: true, args: smokeBrowserArgs() }), engine: "chromium" };
  }
  try {
    return { browser: await webkit.launch({ headless: true }), engine: "webkit" };
  } catch {
    return { browser: await chromium.launch({ headless: true, args: smokeBrowserArgs() }), engine: "chromium" };
  }
}

export async function mobileContext(browser: Browser, viewport: { width: number; height: number }, options: {
  colorScheme?: "light" | "dark"; reducedMotion?: "reduce" | "no-preference";
} = {}): Promise<BrowserContext> {
  return browser.newContext({
    viewport, hasTouch: true, deviceScaleFactor: 2,
    // Firefox has no isMobile; WebKit and Chromium do.
    isMobile: browser.browserType().name() !== "firefox",
    colorScheme: options.colorScheme ?? "light",
    reducedMotion: options.reducedMotion ?? "no-preference",
  });
}

const DRAWER = '[data-slot="adaptive-shell-sidebar"]';
const SCRIM = '[data-slot="adaptive-shell-scrim"]';
const TOGGLE = "[data-ds-nav-toggle]";

async function settle(page: Page, ms = 450): Promise<void> {
  await page.waitForTimeout(ms);
}

async function sideways(page: Page): Promise<number> {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>("[data-ds-scroll]");
    return Math.max(
      document.documentElement.scrollWidth - window.innerWidth,
      scroller ? scroller.scrollWidth - scroller.clientWidth : 0,
    );
  });
}

async function drawerState(page: Page) {
  return page.evaluate(({ drawer, scrim }) => {
    const nav = document.querySelector<HTMLElement>(drawer)!;
    const shade = document.querySelector<HTMLElement>(scrim)!;
    const rect = nav.getBoundingClientRect();
    const style = getComputedStyle(nav);
    const alpha = (color: string) => {
      const match = color.match(/rgba?\(([^)]+)\)/u);
      if (!match) return color === "transparent" ? 0 : 1;
      const parts = match[1]!.split(/[ ,/]+/u).filter(Boolean);
      return parts.length > 3 ? Number(parts[3]) : 1;
    };
    return {
      visible: style.visibility === "visible" && rect.right > 1 && rect.left < 1,
      rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      backgroundAlpha: alpha(style.backgroundColor),
      opacity: Number(style.opacity),
      transform: style.transform,
      transitionProperty: style.transitionProperty,
      scrimOpen: shade.dataset.open === "true" && getComputedStyle(shade).display !== "none",
      scrimOpacity: Number(getComputedStyle(shade).opacity),
      workspaceInert: document.querySelector<HTMLElement>('[data-slot="adaptive-shell-workspace"]')?.inert ?? false,
      scrollLocked: getComputedStyle(document.documentElement).overflow === "hidden",
    };
  }, { drawer: DRAWER, scrim: SCRIM });
}

/** Every point sampled over the drawer hits the drawer (or its toggle); every point beside it hits the scrim. */
async function assertDrawerCovers(page: Page, label: string): Promise<void> {
  const leaks = await page.evaluate(({ drawer, scrim, toggle }) => {
    const nav = document.querySelector<HTMLElement>(drawer)!;
    const rect = nav.getBoundingClientRect();
    const found: string[] = [];
    const describe = (element: Element | null) => element
      ? `${element.tagName.toLowerCase()}${element.getAttribute("data-slot") ? `[${element.getAttribute("data-slot")}]` : ""} "${(element.textContent ?? "").trim().slice(0, 30)}"`
      : "nothing";
    for (let y = 8; y < window.innerHeight - 8; y += 37) {
      for (let x = 6; x < rect.right - 4; x += 29) {
        const hit = document.elementFromPoint(x, y);
        if (!hit || !(nav.contains(hit) || hit.closest(toggle) || hit.closest('[data-test-class="chrome-floating-toggle-layer"]'))) {
          found.push(`drawer (${x},${y}) -> ${describe(hit)}`);
        }
      }
      for (let x = Math.ceil(rect.right) + 6; x < window.innerWidth - 2; x += 23) {
        const hit = document.elementFromPoint(x, y);
        if (!hit || !hit.closest(scrim)) found.push(`page (${x},${y}) -> ${describe(hit)}`);
      }
    }
    return found;
  }, { drawer: DRAWER, scrim: SCRIM, toggle: TOGGLE });
  assert(leaks.length === 0, `${label}: page chrome shows through or beside the open drawer:\n${leaks.slice(0, 8).join("\n")}`);
}

async function assertTitlebar(page: Page, label: string): Promise<void> {
  const bar = await page.evaluate((toggle) => {
    const header = document.querySelector<HTMLElement>('[data-test-class~="custom-titlebar"]');
    const controls = [
      document.querySelector<HTMLElement>(toggle),
      ...header ? [...header.querySelectorAll<HTMLElement>("button")] : [],
    ].filter((element): element is HTMLElement => Boolean(element) && element!.getClientRects().length > 0);
    const title = header?.querySelector<HTMLElement>('[data-slot="titlebar-title"]');
    const boxes = controls.map((element) => ({ name: element.getAttribute("aria-label") ?? element.textContent ?? "", rect: element.getBoundingClientRect() }));
    const titleRect = title?.getBoundingClientRect();
    const overlaps: string[] = [];
    const cross = (a: DOMRect, b: DOMRect) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
    boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => { if (cross(a.rect, b.rect)) overlaps.push(`${a.name} x ${b.name}`); }));
    if (titleRect) boxes.forEach((box) => { if (cross(box.rect, titleRect)) overlaps.push(`title x ${box.name}`); });
    return {
      names: boxes.map((box) => box.name),
      small: boxes.filter((box) => box.rect.width < 44 || box.rect.height < 44).map((box) => `${box.name} ${Math.round(box.rect.width)}x${Math.round(box.rect.height)}`),
      overlaps,
      title: title?.textContent ?? "",
      offscreen: boxes.filter((box) => box.rect.right > window.innerWidth + 0.5 || box.rect.left < -0.5).map((box) => box.name),
    };
  }, TOGGLE);
  for (const name of ["Open navigation", "Search", "View options"]) {
    assert(bar.names.includes(name), `${label}: titlebar is missing ${name} (has ${bar.names.join(", ")})`);
  }
  assert(bar.title.trim().length > 0, `${label}: titlebar shows no page title`);
  assert(bar.small.length === 0, `${label}: titlebar targets below 44px: ${bar.small.join(", ")}`);
  assert(bar.overlaps.length === 0, `${label}: titlebar elements overlap: ${bar.overlaps.join(", ")}`);
  assert(bar.offscreen.length === 0, `${label}: titlebar controls off screen: ${bar.offscreen.join(", ")}`);
}

async function openDrawer(page: Page, label: string) {
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.waitForFunction((drawer) => getComputedStyle(document.querySelector(drawer)!).visibility === "visible", DRAWER);
  await settle(page);
  const state = await drawerState(page);
  assert(state.visible, `${label}: drawer did not open`);
  return state;
}

async function assertClosed(page: Page, label: string): Promise<void> {
  await page.waitForFunction((drawer) => getComputedStyle(document.querySelector(drawer)!).visibility === "hidden", DRAWER, { timeout: 5_000 })
    .catch(() => { throw new Error(`${label}: drawer did not close`); });
  const state = await drawerState(page);
  assert(!state.scrimOpen, `${label}: scrim stayed open after close`);
  assert(!state.workspaceInert, `${label}: page stayed inert after close`);
  assert(!state.scrollLocked, `${label}: page scroll stayed locked after close`);
}

export const REFLOW_PAGES = [
  "overview", "guide", "recipes", "components", "blocks", "components/Button", "foundations", "foundations/color",
  "foundations/typography", "foundations/spacing", "motion", "patterns", "icons",
] as const;

/** Pages reflow: none scrolls sideways at this width. */
export async function assertReflow(page: Page, url: (params: Record<string, string>) => string, label: string,
  pages: readonly string[] = REFLOW_PAGES): Promise<void> {
  for (const pageId of pages) {
    await page.goto(url({ page: pageId }), { waitUntil: "networkidle" });
    await page.locator(`[data-ds-page="${pageId}"]`).waitFor({ state: "attached" });
    await settle(page, 300);
    const overflow = await sideways(page);
    assert(overflow <= 1, `${label} ${pageId}: page scrolls sideways by ${overflow}px`);
  }
}

/** The whole phone contract on one viewer URL builder (`url({ page })`). */
export async function assertMobileViewer(page: Page, url: (params: Record<string, string>) => string, label: string,
  pages: readonly string[] = REFLOW_PAGES): Promise<void> {
  await assertReflow(page, url, label, pages);

  await page.goto(url({ page: "overview" }), { waitUntil: "networkidle" });
  await page.locator("[data-ds-overview]").waitFor({ state: "visible" });
  await settle(page, 300);
  const closed = await drawerState(page);
  assert(!closed.visible && !closed.scrimOpen, `${label}: phones must start with the drawer closed`);
  await assertTitlebar(page, label);

  // Open: opaque drawer over a dimming scrim; the page behind is inert and does not scroll.
  const open = await openDrawer(page, label);
  assert(open.backgroundAlpha >= 0.95, `${label}: drawer surface is see-through (alpha ${open.backgroundAlpha})`);
  assert(open.scrimOpen && open.scrimOpacity > 0.9, `${label}: no scrim behind the open drawer`);
  assert(open.workspaceInert, `${label}: page behind the drawer is not inert`);
  assert(open.scrollLocked, `${label}: page behind the drawer still scrolls`);
  assert(open.rect.right < page.viewportSize()!.width - 40, `${label}: drawer leaves no scrim to tap (right ${open.rect.right})`);
  await assertDrawerCovers(page, label);
  await page.getByRole("button", { name: "Close navigation" }).first().waitFor({ state: "visible" });

  // Focus trap: Tab and Shift+Tab never leave the drawer and its toggle.
  for (const key of [...Array(24).fill("Tab"), ...Array(6).fill("Shift+Tab")] as string[]) {
    await page.keyboard.press(key);
    const inside = await page.evaluate(({ drawer, toggle }) => {
      const active = document.activeElement;
      return Boolean(active && (document.querySelector(drawer)!.contains(active) || active.closest(toggle)));
    }, { drawer: DRAWER, toggle: TOGGLE });
    assert(inside, `${label}: ${key} moved focus out of the open drawer`);
  }

  // Escape closes.
  await page.keyboard.press("Escape");
  await assertClosed(page, `${label} Escape`);

  // Scrim tap closes.
  await openDrawer(page, label);
  const width = page.viewportSize()!.width;
  await page.mouse.click(width - 16, 400);
  await assertClosed(page, `${label} scrim`);

  // The toggle (now Close navigation) closes.
  await openDrawer(page, label);
  await page.locator(TOGGLE).click();
  await assertClosed(page, `${label} toggle`);

  // Navigating closes the drawer and opens the page.
  await openDrawer(page, label);
  await page.locator('[data-ds-nav-item="guide"]').click();
  await assertClosed(page, `${label} navigate`);
  await page.locator("[data-ds-decision-guide]").waitFor({ state: "visible" });
  assert(new URL(page.url()).searchParams.get("page") === "guide", `${label}: drawer navigation did not write the page param`);

  // Drawer rows are touch rows.
  await openDrawer(page, label);
  const rows = await page.locator(`${DRAWER} [data-ds-nav-item] button, ${DRAWER} [data-ds-nav-item] [role="button"]`).evaluateAll((elements) =>
    elements.filter((element) => element.getClientRects().length > 0).map((element) => element.getBoundingClientRect().height));
  assert(rows.length > 5 && rows.every((height) => height >= 44), `${label}: drawer rows below 44px: ${rows.filter((height) => height < 44).join(", ")}`);
  await page.keyboard.press("Escape");
  await assertClosed(page, `${label} Escape again`);

  // View options: theme, locale and motion; no width presets on phones.
  await page.getByRole("button", { name: "View options" }).click();
  const panel = page.locator("[data-ds-view-options-panel]");
  await panel.waitFor({ state: "visible" });
  await settle(page, 250);
  const options = await panel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      groups: [...element.querySelectorAll('[role="radiogroup"]')].map((group) => group.getAttribute("aria-label")),
      inside: rect.left >= -0.5 && rect.right <= window.innerWidth + 0.5 && rect.bottom <= window.innerHeight + 0.5,
      small: [...element.querySelectorAll<HTMLElement>('[role="radio"]')].filter((radio) => radio.getBoundingClientRect().height < 44).length,
    };
  });
  assert(["Theme", "Locale", "Motion"].every((name) => options.groups.includes(name)), `${label}: View options lacks ${options.groups.join(",")}`);
  assert(!options.groups.includes("Width"), `${label}: phones must not offer width presets`);
  assert(options.inside, `${label}: View options runs off screen`);
  assert(options.small === 0, `${label}: View options has segments below 44px`);
  await panel.getByRole("radio", { name: "Dark" }).click();
  await page.waitForFunction(() => document.body.classList.contains("theme-dark") && new URLSearchParams(location.search).get("theme") === "dark");
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "detached" });

  // Search: the Cmd+K palette as a full-width top sheet.
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const combobox = page.getByRole("combobox");
  await combobox.waitFor({ state: "visible" });
  await settle(page, 400);
  const sheet = await page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const rect = dialog.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, width: window.innerWidth };
  });
  assert(Math.abs(sheet.left) <= 1 && Math.abs(sheet.right - sheet.width) <= 1 && Math.abs(sheet.top) <= 1,
    `${label}: search is not a full-width top sheet (${JSON.stringify(sheet)})`);
  await combobox.fill("button");
  await page.locator('[role="option"]').first().waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await combobox.waitFor({ state: "detached" });
  assert((await sideways(page)) <= 1, `${label}: page scrolls sideways after the sheets closed`);
}

/** Reduced motion: the drawer fades in place (no slide, no push). */
export async function assertReducedMotionDrawer(page: Page, url: (params: Record<string, string>) => string, label: string): Promise<void> {
  await page.goto(url({ page: "overview" }), { waitUntil: "networkidle" });
  await page.locator("[data-ds-overview]").waitFor({ state: "visible" });
  const state = await openDrawer(page, `${label} reduced`);
  const still = (transform: string) => transform === "none" || transform === "matrix(1, 0, 0, 1, 0, 0)";
  assert(still(state.transform), `${label}: reduced motion still slides the drawer (${state.transform})`);
  assert(state.transitionProperty.includes("opacity") && state.opacity === 1, `${label}: reduced motion drawer does not fade (${state.transitionProperty})`);
  const workspace = await page.evaluate(() => getComputedStyle(document.querySelector('[data-slot="adaptive-shell-workspace"]')!).transform);
  assert(still(workspace), `${label}: reduced motion still pushes the page (${workspace})`);
}
