import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { createAppServer } from "../../packages/butler-agent/src/gateways/app/interface/server/create-app-server.ts";

// DS Viewer deep links (page/theme/locale/width), toolbar URL writes, and search.

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
    const canvases = [...document.querySelectorAll<HTMLElement>('[data-ds-detail="Button"] [data-ds-fixture-canvas]')];
    const pressed = [...document.querySelectorAll('[aria-pressed="true"]')].map((button) => button.textContent?.trim());
    return {
      bodyDark: document.body.classList.contains("theme-dark"),
      stories: document.querySelectorAll('[data-ds-detail="Button"] [data-ds-story]').length,
      canvasesKorean: canvases.length > 0 && canvases.every((canvas) => canvas.lang === "ko"),
      maxCanvasWidth: Math.max(...canvases.map((canvas) => canvas.getBoundingClientRect().width)),
      importLine: document.querySelector("[data-ds-import]")?.textContent ?? "",
      pressed,
    };
  });
  assert(item.bodyDark, `${label}: theme=dark deep link did not apply the dark theme`);
  assert(item.stories >= 2, `${label}: Button item page should render every story`);
  assert(item.canvasesKorean, `${label}: locale=ko deep link did not reach example canvases`);
  assert(item.maxCanvasWidth <= 375, `${label}: width=375 deep link rendered ${item.maxCanvasWidth}px canvases`);
  assert(item.importLine.includes('import { Button } from "@/butler-ds"'), `${label}: import line is missing`);
  assert(["Dark", "KO", "375"].every((value) => item.pressed.includes(value)), `${label}: toolbar does not reflect the deep link`);

  await page.goto(viewerUrl(baseUrl, { page: "navrow", theme: "side-by-side" }), { waitUntil: "networkidle" });
  await page.locator('[data-ds-detail="NavRow"]').waitFor({ state: "visible" });
  const frames = await page.evaluate(() => [...document.querySelectorAll("[data-ds-story]")].map((story) =>
    [...story.querySelectorAll("[data-ds-theme]")].map((frame) => frame.getAttribute("data-ds-theme")).join(",")));
  assert(frames.length > 0 && frames.every((value) => value === "light,dark"), `${label}: side-by-side should render light and dark frames`);

  await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Light" }).click();
  await page.getByRole("group", { name: "Width" }).getByRole("button", { name: "Wide" }).click();
  await page.waitForFunction(() => new URLSearchParams(window.location.search).get("width") === "wide");
  assert(param(page, "theme") === "light", `${label}: toolbar theme was not written to the URL`);
  assert(param(page, "page") === "navrow", `${label}: toolbar changes must keep the page param`);

  for (const [pageId, selector] of [
    ["patterns", '[data-ds-placeholder="patterns"]'],
    ["icons", '[data-ds-placeholder="icons"]'],
    ["overview", "[data-ds-overview]"],
    ["components/DoesNotExist", '[data-ds-not-found="components/DoesNotExist"]'],
  ] as const) {
    await page.goto(viewerUrl(baseUrl, { page: pageId }), { waitUntil: "networkidle" });
    await page.locator(selector).waitFor({ state: "visible" });
  }
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

  await page.keyboard.press("ControlOrMeta+k");
  await page.waitForFunction(() => document.activeElement?.id === "ds-viewer-search");
  await page.keyboard.press("Escape");
  await results.waitFor({ state: "detached" });

  const blocksRow = page.locator('[data-ds-nav-item="blocks"]');
  if (!(await blocksRow.isVisible())) await page.getByRole("button", { name: "Toggle navigation" }).click();
  await blocksRow.click();
  await page.locator('[data-ds-gallery="blocks"]').waitFor({ state: "visible" });
  assert(param(page, "page") === "blocks", `${label}: sidebar navigation did not write the page param`);
}

assert(existsSync(join(uiRoot, "index.html")), "UI dist is missing; run npm --prefix packages/butler-app/client/ui run build first.");

const server = createAppServer({
  dbPath: join(tempDir, "ds-viewer-navigation.sqlite"),
  butlerData: tempDir,
  uiRoot,
  port: 0,
  bridgeMode: "external",
});
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
  server.stop();
  rmSync(tempDir, { recursive: true, force: true });
}
