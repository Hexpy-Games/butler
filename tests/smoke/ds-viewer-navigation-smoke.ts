import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";

// DS Viewer deep links (page/theme/locale/width/motion, #anchors), toolbar URL writes, "/" filter and Cmd+K palette.

const uiRoot = resolve(process.cwd(), "packages", "butler-app", "client", "ui", "dist");
const tempDir = mkdtempSync(join(tmpdir(), "butler-ds-viewer-navigation-"));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function viewerUrl(baseUrl: string, params: Record<string, string>): string {
  return `${baseUrl}?${new URLSearchParams({ visual: "design-system", ...params }).toString()}`;
}

function param(page: Page, name: string): string | null {
  return new URL(page.url()).searchParams.get(name);
}

async function assertDeepLinks(page: Page, baseUrl: string, label: string): Promise<void> {
  await page.goto(viewerUrl(baseUrl, { page: "components/Button", theme: "dark", locale: "ko", width: "375" }), {
    waitUntil: "networkidle",
  });
  await page.locator('[data-ds-detail="Button"]').waitFor({ state: "visible" });
  const item = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll<HTMLElement>('[data-ds-detail="Button"] [data-ds-examples] [data-ds-fixture-canvas]')];
    const pressed = [...document.querySelectorAll('[data-ds-toolbar] [role="radio"][aria-checked="true"]')]
      .map((radio) => radio.textContent?.trim());
    return {
      bodyDark: document.body.classList.contains("theme-dark"),
      stories: document.querySelectorAll('[data-ds-detail="Button"] [data-ds-story]').length,
      canvasesKorean: canvases.length > 0 && canvases.every((canvas) => canvas.lang === "ko"),
      maxCanvasWidth: Math.max(...canvases.map((canvas) => canvas.getBoundingClientRect().width)),
      importLine: document.querySelector("[data-ds-import]")?.textContent ?? "",
      examplesBeforeReadme: (() => {
        const examples = document.querySelector('[data-ds-detail="Button"] [data-ds-examples]');
        const guidance = [...document.querySelectorAll('[data-ds-detail="Button"] h2')]
          .find((heading) => heading.textContent?.trim() === "Guidance");
        return Boolean(examples && guidance) &&
          Boolean(examples!.compareDocumentPosition(guidance!) & Node.DOCUMENT_POSITION_FOLLOWING);
      })(),
      pressed,
    };
  });
  assert(item.bodyDark, `${label}: theme=dark deep link did not apply the dark theme`);
  assert(item.stories >= 2, `${label}: Button item page should render every story`);
  assert(item.canvasesKorean, `${label}: locale=ko deep link did not reach example canvases`);
  assert(item.maxCanvasWidth <= 375, `${label}: width=375 deep link rendered ${item.maxCanvasWidth}px canvases`);
  assert(item.importLine.includes('import { Button } from "@/butler-ds"'), `${label}: import line is missing`);
  assert(item.examplesBeforeReadme, `${label}: item page must show examples before the README`);
  assert(["Dark", "KO", "375"].every((value) => item.pressed.includes(value)), `${label}: toolbar does not reflect the deep link`);

  await page.goto(viewerUrl(baseUrl, { page: "navrow", theme: "side-by-side" }), { waitUntil: "networkidle" });
  await page.locator('[data-ds-detail="NavRow"]').waitFor({ state: "visible" });
  const frames = await page.evaluate(() => [...document.querySelectorAll("[data-ds-story]")].map((story) =>
    [...story.querySelectorAll("[data-ds-theme]")].map((frame) => frame.getAttribute("data-ds-theme")).join(",")));
  assert(frames.length > 0 && frames.every((value) => value === "light,dark"), `${label}: side-by-side should render light and dark frames`);

  await page.locator("[data-ds-toolbar]").getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Light" }).click();
  await page.locator("[data-ds-toolbar]").getByRole("radiogroup", { name: "Width" }).getByRole("radio", { name: "Wide" }).click();
  await page.waitForFunction(() => new URLSearchParams(window.location.search).get("width") === "wide");
  assert(param(page, "theme") === "light", `${label}: toolbar theme was not written to the URL`);
  assert(param(page, "page") === "navrow", `${label}: toolbar changes must keep the page param`);

  for (const [pageId, selector] of [
    ["patterns", "[data-ds-patterns]"],
    ["patterns/tinted-glass", '[data-ds-pattern="tinted-glass"]'],
    ["icons", "[data-ds-icon-gallery]"],
    ["overview", "[data-ds-overview]"],
    ["guide", "[data-ds-decision-guide]"],
    ["recipes", "[data-ds-recipes]"],
    ["foundations", '[data-ds-foundations="index"]'],
    ["foundations/color", '[data-ds-foundations="color"] [data-ds-token-name]'],
    ["motion", "[data-ds-motion-page]"],
    ["components/DoesNotExist", '[data-ds-not-found="components/DoesNotExist"]'],
  ] as const) {
    await page.goto(viewerUrl(baseUrl, { page: pageId }), { waitUntil: "networkidle" });
    await page.locator(selector).first().waitFor({ state: "visible" });
  }

  await page.goto(viewerUrl(baseUrl, { page: "motion", motion: "reduced" }), { waitUntil: "networkidle" });
  await page.locator("[data-ds-motion-page]").waitFor({ state: "visible" });
  const motion = await page.evaluate(() => ({
    body: document.body.dataset.motion,
    viewer: document.querySelector("[data-ds-viewer]")?.getAttribute("data-motion"),
  }));
  assert(motion.body === "reduced" && motion.viewer === "reduced", `${label}: motion=reduced deep link was not applied`);
  await page.locator("[data-ds-toolbar]").getByRole("radiogroup", { name: "Motion" }).getByRole("radio", { name: "Full" }).click();
  // Defaults are dropped from the URL, so Full clears the motion param.
  await page.waitForFunction(() => document.body.dataset.motion === "full" &&
    new URLSearchParams(window.location.search).get("motion") === null);

  await page.goto(viewerUrl(baseUrl, { page: "components/Button#states" }), { waitUntil: "networkidle" });
  await page.locator('[data-ds-detail="Button"] [data-ds-states-matrix]').first().waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    // The anchor lands just below the sticky toolbar, not under it.
    const top = document.getElementById("states")?.getBoundingClientRect().top ?? -1;
    const toolbar = document.querySelector("main")?.firstElementChild?.getBoundingClientRect().bottom ?? 0;
    return top >= toolbar - 2 && top < window.innerHeight / 2;
  });
}

async function assertSearch(page: Page, baseUrl: string, label: string): Promise<void> {
  await page.goto(viewerUrl(baseUrl, { page: "overview" }), { waitUntil: "networkidle" });
  await page.locator("[data-ds-overview]").waitFor({ state: "visible" });
  await page.keyboard.press("/");
  await page.waitForFunction(() => document.activeElement?.id === "ds-viewer-search");
  await page.keyboard.type("sidebar");
  const results = page.locator("[data-ds-search-results]");
  await results.waitFor({ state: "visible" });
  const found = await results.locator("[data-ds-nav-item]").evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-ds-nav-item")));
  assert(found.includes("blocks/SidebarShell") && found.includes("blocks/NavRow"), `${label}: search by tag missed sidebar items`);
  assert(!found.includes("components/Button"), `${label}: search should filter out unrelated items`);

  await page.keyboard.press("Enter");
  await page.locator("[data-ds-detail]").waitFor({ state: "visible" });
  assert(param(page, "page") === found[0], `${label}: Enter should open the first search result`);

  // "/" reopens the drawer on narrow widths and focuses the filter; Escape clears it.
  if (!(await page.evaluate(() => document.activeElement?.id === "ds-viewer-search"))) await page.keyboard.press("/");
  await page.waitForFunction(() => document.activeElement?.id === "ds-viewer-search");
  await page.keyboard.press("Escape");
  await results.waitFor({ state: "detached" });

  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("combobox");
  await palette.waitFor({ state: "visible" });
  assert(await palette.evaluate((input) => input === document.activeElement), `${label}: Cmd+K should focus the palette input`);
  await palette.fill("--space-xs");
  await page.locator('[role="option"]', { hasText: "--space-xs" }).first().click();
  await page.locator('[data-ds-token-name="--space-xs"]').waitFor({ state: "visible" });
  assert(param(page, "page")?.startsWith("foundations/"), `${label}: a token result should open its foundations page`);
  await palette.waitFor({ state: "detached" });

  const blocksRow = page.locator('[data-ds-nav-item="blocks"]');
  if (!(await blocksRow.isVisible())) await page.getByRole("button", { name: "Toggle navigation" }).click();
  await blocksRow.click();
  await page.locator('[data-ds-gallery="blocks"]').waitFor({ state: "visible" });
  assert(param(page, "page") === "blocks", `${label}: sidebar navigation did not write the page param`);
}

assert(existsSync(join(uiRoot, "index.html")), "UI dist is missing; run npm --prefix packages/butler-app/client/ui run build first.");

const server = await createNativeAppServer({ uiRoot });
const browser = await chromium.launch({ headless: true });

try {
  for (const viewport of [
    { label: "desktop", width: 1440, height: 900 },
    { label: "mobile-375", width: 375, height: 812 },
  ]) {
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
    await assertDeepLinks(page, server.url, viewport.label);
    await assertSearch(page, server.url, viewport.label);
    await page.close();
  }
  console.log("ds-viewer-navigation-smoke: ok");
} finally {
  await browser.close();
  await server.stop();
  rmSync(tempDir, { recursive: true, force: true });
}
