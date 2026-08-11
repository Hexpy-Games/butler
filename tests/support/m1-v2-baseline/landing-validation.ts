import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { validateProjectDeliverable } from
  "../btcc-revision-benchmark/project-deliverable-validation.ts";
import type { M1V2LandingValidation } from "./contracts.ts";

const ORIGINAL_INDEX = "<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Starter</title><link rel=\"stylesheet\" href=\"styles.css\"></head><body><main><h1>Starter</h1><p>Replace this page.</p></main></body></html>\n";
const ORIGINAL_STYLES = "body { margin: 0; font-family: system-ui, sans-serif; }\nmain { padding: 4rem; }\n";

export async function validateM1V2Landing(input: {
  browserExecutablePath?: string;
  runRoot: string;
  workspaceRoot: string;
}): Promise<M1V2LandingValidation> {
  const indexPath = join(input.workspaceRoot, "index.html");
  const stylesPath = join(input.workspaceRoot, "styles.css");
  const html = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
  const css = existsSync(stylesPath) ? readFileSync(stylesPath, "utf8") : "";
  const rendered = await validateProjectDeliverable({
    browserExecutablePath: input.browserExecutablePath ?? "",
    runRoot: input.runRoot,
    workspaceRoot: input.workspaceRoot,
  });
  const document = new JSDOM(html).window.document;
  const text = document.body?.textContent ?? "";
  const featureBlockCount = countFeatureBlocks(document);
  return {
    buildPassed: rendered.build.exitCode === 0 && !rendered.build.timedOut,
    desktopPassed: viewportPassed(rendered.desktop),
    mobilePassed: viewportPassed(rendered.mobile),
    desktopScreenshotPresent: Boolean(rendered.desktop.screenshotPath &&
      existsSync(rendered.desktop.screenshotPath)),
    mobileScreenshotPresent: Boolean(rendered.mobile.screenshotPath &&
      existsSync(rendered.mobile.screenshotPath)),
    indexChanged: html !== ORIGINAL_INDEX,
    stylesChanged: css !== ORIGINAL_STYLES,
    butlerGrounded: /butler/iu.test(`${document.title} ${text}`),
    featureBlockCount,
    usageScenePresent: /(사용|활용|장면|상황|workflow|use\s*case)/iu.test(text),
    ctaPresent: document.querySelectorAll("a[href], button").length > 0,
    responsiveCssPresent: /@media\s*\(/iu.test(css),
  };
}

function countFeatureBlocks(document: Document): number {
  const explicit = document.querySelectorAll(
    "[class*='feature' i] article, [class*='feature' i] li, [class*='feature' i] > div",
  ).length;
  if (explicit >= 3) return explicit;
  const articles = document.querySelectorAll("main article").length;
  if (articles >= 3) return articles;
  return Math.max(explicit, articles);
}

function viewportPassed(viewport: {
  loaded: boolean;
  requestedWidth: number;
  innerWidth: number | null;
  clientWidth: number | null;
  scrollWidth: number | null;
}): boolean {
  return viewport.loaded && viewport.innerWidth === viewport.requestedWidth &&
    viewport.clientWidth === viewport.requestedWidth &&
    viewport.scrollWidth !== null && viewport.clientWidth !== null &&
    viewport.scrollWidth <= viewport.clientWidth;
}
