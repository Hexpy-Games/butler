import { gotoViewer } from "../support/viewer-layout.ts";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";

const root = process.cwd();
const uiRoot = resolve(root, "packages", "butler-app", "client", "ui", "dist");
const outputRoot = resolve(root, ".tmp", "ds-viewer");
const tempDir = mkdtempSync(join(tmpdir(), "butler-ds-viewer-render-"));

const viewportPresets = {
  desktop: { width: 1440, height: 1000 },
  "mobile-320": { width: 320, height: 720 },
  "iphone-375": { width: 375, height: 812 },
  "iphone-390": { width: 390, height: 844 },
  "mobile-430": { width: 430, height: 932 },
} as const;

type ViewportName = keyof typeof viewportPresets;
const mobileViewportNames = [
  "mobile-320",
  "iphone-375",
  "iphone-390",
  "mobile-430",
] satisfies ViewportName[];
const allViewportNames = [
  "desktop",
  ...mobileViewportNames,
] satisfies ViewportName[];

const themeNames = ["light", "dark", "side-by-side"] as const;
type ThemeName = (typeof themeNames)[number];

interface RenderOptions {
  componentNames: string[];
  viewports: ViewportName[];
  themes: ThemeName[];
  locale: "en" | "ko";
  /** Viewer pages only: capture the whole scrolled page, not the viewport. */
  fullPage: boolean;
}

function parseThemes(value: string): ThemeName[] {
  if (value === "all") return [...themeNames];
  const themes = value.split(",").map((theme) => theme.trim());
  for (const theme of themes) {
    if (!themeNames.includes(theme as ThemeName)) {
      throw new Error(`Unknown theme: ${theme}. Use light, dark, side-by-side, or all.`);
    }
  }
  return themes as ThemeName[];
}

function parseViewport(value: string): ViewportName[] {
  if (value === "all") return allViewportNames;
  if (value === "mobile") return mobileViewportNames;
  if (value === "iphone") return ["iphone-390"];
  if (value in viewportPresets) return [value as ViewportName];
  throw new Error(
    `Unknown viewport: ${value}. Use desktop, iphone, mobile, mobile-320, iphone-375, iphone-390, mobile-430, or all.`,
  );
}

function parseRenderOptions(args: string[]): RenderOptions {
  const names: string[] = [];
  let viewports: ViewportName[] = ["desktop"];
  let themes: ThemeName[] = ["light"];
  let locale: RenderOptions["locale"] = "en";
  let fullPage = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === "--") continue;
    if (arg === "--full-page") {
      fullPage = true;
      continue;
    }
    if (arg.startsWith("--locale=")) {
      const value = arg.slice("--locale=".length);
      if (value !== "en" && value !== "ko") throw new Error(`Unknown locale: ${value}. Use en or ko.`);
      locale = value;
      continue;
    }
    if (arg === "--iphone") {
      viewports = ["iphone-390"];
      continue;
    }
    if (arg === "--mobile") {
      viewports = mobileViewportNames;
      continue;
    }
    if (arg === "--all-viewports") {
      viewports = allViewportNames;
      continue;
    }
    if (arg === "--viewport") {
      const value = args[index + 1];
      if (!value) throw new Error("--viewport requires a value");
      viewports = parseViewport(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--viewport=")) {
      viewports = parseViewport(arg.slice("--viewport=".length));
      continue;
    }
    if (arg === "--theme") {
      const value = args[index + 1];
      if (!value) throw new Error("--theme requires a value");
      themes = parseThemes(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--theme=")) {
      themes = parseThemes(arg.slice("--theme=".length));
      continue;
    }
    names.push(...arg.split(","));
  }

  const componentNames = names.map((arg) => arg.trim()).filter(Boolean);

  return {
    // `all` expands to every component and block; viewer pages may be listed beside it.
    componentNames: componentNames.flatMap((name) => (name.toLowerCase() === "all" ? ["*"] : [name])),
    viewports: [...new Set(viewports)],
    themes: [...new Set(themes)],
    locale,
    fullPage,
  };
}

function safeFileName(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-z0-9]+/giu, "-")
    .replace(/^-|-$/gu, "")
    .toLowerCase();
}

function viewerUrl(serverUrl: string, params: Record<string, string>): string {
  return `${serverUrl}?${new URLSearchParams({ visual: "design-system", ...params }).toString()}`;
}

// Viewer pages render as viewport screenshots: `page:overview`, `page:foundations/color`, or any id with a slash
// (`patterns/tinted-glass`). Bare names are components and blocks.
function isViewerPageName(name: string): boolean {
  return name.startsWith("page:") || name.includes("/");
}

function viewerPageId(name: string): string {
  return name.startsWith("page:") ? name.slice("page:".length) : name;
}

/** Item ids by component name, read from the Components and Blocks galleries. */
async function viewerItems(page: Page, serverUrl: string): Promise<Map<string, string>> {
  const items = new Map<string, string>();
  for (const gallery of ["components", "blocks"]) {
    await gotoViewer(page, viewerUrl(serverUrl, { page: gallery }), { waitUntil: "domcontentloaded" });
    await page.locator(`[data-ds-gallery="${gallery}"]`).waitFor({ state: "attached" });
    const cards = await page.locator("[data-ds-component]").evaluateAll((elements) =>
      elements.map((element) => [element.getAttribute("data-ds-component"), element.getAttribute("data-ds-item")]),
    );
    for (const [name, id] of cards) {
      if (name && id) items.set(name, id);
    }
  }
  return items;
}

const STEP_TIMEOUT_MS = 15_000;

async function captureComponent(page: Page, url: string, componentName: string, outputPath: string): Promise<void> {
  await gotoViewer(page, url, { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT_MS });
  const component = page.locator(
    `[data-ds-detail="${componentName.replace(/"/gu, '\\"')}"] [data-ds-examples]`,
  );
  await component.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await component.scrollIntoViewIfNeeded({ timeout: STEP_TIMEOUT_MS });
  await component.screenshot({ path: outputPath, animations: "disabled", timeout: STEP_TIMEOUT_MS });
}

async function renderViewport(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  serverUrl: string,
  viewportName: ViewportName,
  requestedNames: string[],
  themes: ThemeName[],
  useViewportSubdir: boolean,
  { locale, fullPage }: Pick<RenderOptions, "locale" | "fullPage">,
): Promise<string[]> {
  const newPage = async () => {
    const created = await browser.newPage({
      viewport: viewportPresets[viewportName],
      deviceScaleFactor: 1,
    });
    await server.signIn(created);
    return created;
  };
  let page = await newPage();
  const outputDir = useViewportSubdir
    ? join(outputRoot, viewportName)
    : outputRoot;
  mkdirSync(outputDir, { recursive: true });

  try {
    const items = await viewerItems(page, serverUrl);
    const availableNames = [...items.keys()];
    const selectedNames = requestedNames.length > 0
      ? [...new Set(requestedNames.flatMap((name) => (name === "*" ? availableNames : [name])))]
      : availableNames;
    const availableByLower = new Map(
      availableNames.map((name) => [name.toLowerCase(), name]),
    );
    const pageIds = selectedNames.filter(isViewerPageName).map(viewerPageId);
    const unknownNames = selectedNames.filter(
      (name) => !isViewerPageName(name) && !availableByLower.has(name.toLowerCase()),
    );

    if (unknownNames.length > 0) {
      throw new Error(
        `Unknown DS Viewer component(s): ${unknownNames.join(", ")}. Available: ${availableNames.join(", ")}`,
      );
    }

    const writtenPaths: string[] = [];
    for (const pageId of pageIds) {
      for (const theme of themes) {
        await gotoViewer(page, viewerUrl(serverUrl, { page: pageId, theme, locale, motion: "reduced" }), { waitUntil: "domcontentloaded" });
        await page.locator(`[data-ds-page="${pageId}"] main > *`).first().waitFor({ state: "visible" });
        if (await page.locator("[data-ds-not-found]").count()) throw new Error(`Unknown DS Viewer page: ${pageId}`);
        const suffix = `${themes.length > 1 ? `-${theme}` : ""}${locale === "ko" ? "-ko" : ""}${fullPage ? "-full" : ""}`;
        const outputPath = join(outputDir, `page-${safeFileName(pageId)}${suffix}.png`);
        // The viewer scrolls inside <main>; a full-page capture grows the viewport to its content.
        const viewport = viewportPresets[viewportName];
        if (fullPage) {
          const height = await page.evaluate(() => document.querySelector("main")?.scrollHeight ?? 0);
          await page.setViewportSize({ width: viewport.width, height: Math.min(Math.max(height, viewport.height), 32000) });
        }
        await page.screenshot({ path: outputPath, animations: "disabled" });
        if (fullPage) await page.setViewportSize(viewport);
        writtenPaths.push(outputPath);
      }
    }
    for (const requestedName of selectedNames) {
      if (isViewerPageName(requestedName)) continue;
      const componentName = availableByLower.get(requestedName.toLowerCase());
      const id = componentName ? items.get(componentName) : undefined;
      if (!componentName || !id) continue;

      for (const theme of themes) {
        const suffix = themes.length > 1 ? `-${theme}` : "";
        const outputPath = join(outputDir, `${safeFileName(componentName)}${suffix}.png`);
        // One deep link and one screenshot per item and theme. The whole catalog
        // reuses one tab; a rare stall there (seen ~1 in 6 full runs, on a
        // different item each time) is retried once in a fresh tab. An item that
        // stalls twice is a real failure.
        for (let attempt = 1; ; attempt += 1) {
          try {
            await captureComponent(page, viewerUrl(serverUrl, { page: id, theme }), componentName, outputPath);
            break;
          } catch (error) {
            if (attempt > 1 || !(error instanceof Error && error.name === "TimeoutError")) throw error;
            console.error(`ds-viewer-render: ${componentName} (${theme}) timed out; retrying in a fresh tab`);
            await page.close();
            page = await newPage();
          }
        }
        writtenPaths.push(outputPath);
      }
    }

    return writtenPaths;
  } finally {
    await page.close();
  }
}

if (!existsSync(join(uiRoot, "index.html"))) {
  throw new Error(
    "UI dist is missing. Run `npm --prefix packages/butler-app/client/ui run build` first.",
  );
}

mkdirSync(outputRoot, { recursive: true });

const { componentNames: requestedNames, viewports, themes, locale, fullPage } = parseRenderOptions(
  Bun.argv.slice(2),
);
const server = await createNativeAppServer({ uiRoot });
const browser = await chromium.launch({ headless: true });

try {
  const writtenPaths: string[] = [];
  for (const viewportName of viewports) {
    writtenPaths.push(
      ...(await renderViewport(
        browser,
        server.url,
        viewportName,
        requestedNames,
        themes,
        viewports.length > 1 || viewportName !== "desktop",
        { locale, fullPage },
      )),
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        outputDir: outputRoot,
        viewports,
        themes,
        files: writtenPaths.map((path) => relative(outputRoot, path)),
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await server.stop();
  rmSync(tempDir, { recursive: true, force: true });
}
