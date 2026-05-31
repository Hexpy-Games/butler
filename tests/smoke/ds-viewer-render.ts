import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { chromium, type Locator, type Page } from "playwright";
import { createAppServer } from "../../packages/butler-agent/src/gateways/app/server.ts";

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

interface RenderOptions {
  componentNames: string[];
  viewports: ViewportName[];
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

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === "--") continue;
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
    names.push(...arg.split(","));
  }

  const componentNames = names.map((arg) => arg.trim()).filter(Boolean);

  return {
    componentNames:
      componentNames.length === 1 && componentNames[0]?.toLowerCase() === "all"
        ? []
        : componentNames,
    viewports: [...new Set(viewports)],
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

async function componentNames(pageLocator: Locator): Promise<string[]> {
  return pageLocator.evaluateAll((elements) =>
    elements
      .map((element) => element.getAttribute("data-ds-component"))
      .filter((value): value is string => Boolean(value)),
  );
}

async function openViewerTab(page: Page, tab: "primitives" | "blocks") {
  await page.locator(`[data-ds-view-tab="${tab}"]`).click();
}

async function renderViewport(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  serverUrl: string,
  viewportName: ViewportName,
  requestedNames: string[],
  useViewportSubdir: boolean,
): Promise<string[]> {
  const page = await browser.newPage({
    viewport: viewportPresets[viewportName],
    deviceScaleFactor: 1,
  });
  const outputDir = useViewportSubdir
    ? join(outputRoot, viewportName)
    : outputRoot;
  mkdirSync(outputDir, { recursive: true });

  try {
    await page.goto(`${serverUrl}?visual=design-system`, {
      waitUntil: "networkidle",
    });
    await page.locator("text=Butler DS Viewer").waitFor({ state: "visible" });

    const namesByTab = new Map<string, "primitives" | "blocks">();
    for (const tab of ["primitives", "blocks"] as const) {
      await openViewerTab(page, tab);
      for (const name of await componentNames(page.locator("[data-ds-component]"))) {
        namesByTab.set(name, tab);
      }
    }

    const availableNames = [...namesByTab.keys()];
    const selectedNames =
      requestedNames.length > 0 ? requestedNames : availableNames;
    const availableByLower = new Map(
      availableNames.map((name) => [name.toLowerCase(), name]),
    );
    const unknownNames = selectedNames.filter(
      (name) => !availableByLower.has(name.toLowerCase()),
    );

    if (unknownNames.length > 0) {
      throw new Error(
        `Unknown DS Viewer component(s): ${unknownNames.join(", ")}. Available: ${availableNames.join(", ")}`,
      );
    }

    const writtenPaths: string[] = [];
    for (const requestedName of selectedNames) {
      const componentName = availableByLower.get(requestedName.toLowerCase());
      if (!componentName) continue;

      await openViewerTab(page, namesByTab.get(componentName) ?? "primitives");
      const component = page.locator(
        `[data-ds-component="${componentName.replace(/"/gu, '\\"')}"]`,
      );
      await component.scrollIntoViewIfNeeded();
      const outputPath = join(outputDir, `${safeFileName(componentName)}.png`);
      await component.screenshot({
        path: outputPath,
        animations: "disabled",
      });
      writtenPaths.push(outputPath);
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

const { componentNames: requestedNames, viewports } = parseRenderOptions(
  Bun.argv.slice(2),
);
const server = createAppServer({
  dbPath: join(tempDir, "ds-viewer-render.sqlite"),
  butlerData: tempDir,
  uiRoot,
  port: 0,
  bridgeMode: "external",
});
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
        viewports.length > 1 || viewportName !== "desktop",
      )),
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        outputDir: outputRoot,
        viewports,
        files: writtenPaths.map((path) => relative(outputRoot, path)),
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  server.stop();
  rmSync(tempDir, { recursive: true, force: true });
}
