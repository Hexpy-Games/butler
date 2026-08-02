import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";
import type {
  ProjectDeliverableValidation,
  ProjectViewportObservation,
} from "./contracts.ts";

const VIEWPORTS = {
  desktop: { width: 1_440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

export async function validateProjectDeliverable(input: {
  browserExecutablePath: string;
  runRoot: string;
  workspaceRoot: string;
}): Promise<ProjectDeliverableValidation> {
  const browserExecutablePath = resolveBenchmarkBrowserExecutable(
    input.browserExecutablePath,
  );
  const outputRoot = join(input.runRoot, "deliverable-validation");
  const entryPath = join(input.workspaceRoot, "index.html");
  mkdirSync(outputRoot, { recursive: true });
  const build = await runProjectBuild(input.workspaceRoot);
  const failedViewport = (name: keyof typeof VIEWPORTS, error: string) =>
    emptyViewport(VIEWPORTS[name].width, VIEWPORTS[name].height, error);
  if (build.exitCode === null && !build.timedOut) {
    throw new Error(
      `Benchmark infrastructure could not run the project build: ${build.outputTail}`,
    );
  }
  if (build.exitCode !== 0 || build.timedOut) {
    const error = build.timedOut
      ? "Project build exceeded the 120000 ms product deadline"
      : `Project build failed with exit code ${build.exitCode}`;
    return {
      browserExecutablePath,
      entryPath,
      build,
      desktop: failedViewport("desktop", error),
      mobile: failedViewport("mobile", error),
    };
  }
  if (!existsSync(entryPath)) {
    const error = "Project entry file is missing: index.html";
    return {
      browserExecutablePath,
      entryPath,
      build,
      desktop: failedViewport("desktop", error),
      mobile: failedViewport("mobile", error),
    };
  }
  const browser = await chromium.launch({
    executablePath: browserExecutablePath,
    headless: true,
    args: ["--allow-file-access-from-files"],
  });
  try {
    return {
      browserExecutablePath,
      entryPath,
      build,
      desktop: await observeViewport({
        browser,
        entryPath,
        outputRoot,
        name: "desktop",
        ...VIEWPORTS.desktop,
      }),
      mobile: await observeViewport({
        browser,
        entryPath,
        outputRoot,
        name: "mobile",
        ...VIEWPORTS.mobile,
      }),
    };
  } finally {
    await browser.close();
  }
}

export function resolveBenchmarkBrowserExecutable(explicit?: string): string {
  const candidates = [
    explicit,
    process.env.BUTLER_BENCHMARK_BROWSER,
    process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined,
    process.platform === "darwin"
      ? "/Applications/Chromium.app/Contents/MacOS/Chromium"
      : undefined,
    process.platform === "win32"
      ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      : undefined,
    process.platform === "linux" ? "/usr/bin/google-chrome" : undefined,
    process.platform === "linux" ? "/usr/bin/chromium" : undefined,
  ].filter((value): value is string => Boolean(value?.trim()));
  const found = candidates.map((value) => resolve(value)).find(existsSync);
  if (!found) {
    throw new Error(
      "Benchmark browser is missing. Set browserExecutablePath or BUTLER_BENCHMARK_BROWSER.",
    );
  }
  return found;
}

async function observeViewport(input: {
  browser: Awaited<ReturnType<typeof chromium.launch>>;
  entryPath: string;
  height: number;
  name: "desktop" | "mobile";
  outputRoot: string;
  width: number;
}): Promise<ProjectViewportObservation> {
  const context = await input.browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const screenshotPath = join(input.outputRoot, `${input.name}.png`);
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: input.width,
      height: input.height,
      deviceScaleFactor: 1,
      mobile: input.name === "mobile",
      screenWidth: input.width,
      screenHeight: input.height,
    });
    let facts: {
      bodyTextLength: number;
      clientWidth: number;
      innerWidth: number;
      loaded: boolean;
      scrollWidth: number;
    };
    try {
      await page.goto(pathToFileURL(input.entryPath).href, {
        timeout: 30_000,
        waitUntil: "load",
      });
      await page.evaluate(async () => {
        await document.fonts?.ready;
        await Promise.race([
          Promise.all(Array.from(document.images).map((image) =>
            image.complete
              ? Promise.resolve()
              : new Promise<void>((resolveImage) => {
                image.addEventListener("load", () => resolveImage(), { once: true });
                image.addEventListener("error", () => resolveImage(), { once: true });
              }),
          )),
          new Promise<void>((resolveWait) => setTimeout(resolveWait, 10_000)),
        ]);
      });
      await revealLazyPageContent(page);
      facts = await page.evaluate(() => ({
        bodyTextLength: document.body?.innerText.trim().length ?? 0,
        clientWidth: document.documentElement.clientWidth,
        innerWidth: window.innerWidth,
        loaded: document.readyState === "complete",
        scrollWidth: document.documentElement.scrollWidth,
      }));
    } catch (error) {
      if (!input.browser.isConnected()) throw error;
      return emptyViewport(
        input.width,
        input.height,
        error instanceof Error ? error.message : String(error),
      );
    }
    const capture = await cdp.send("Page.captureScreenshot", {
      captureBeyondViewport: true,
      format: "png",
      fromSurface: true,
    }) as { data?: string };
    if (!capture.data) throw new Error("Chrome did not return screenshot bytes");
    writeFileSync(screenshotPath, Buffer.from(capture.data, "base64"));
    return {
      requestedWidth: input.width,
      requestedHeight: input.height,
      innerWidth: facts.innerWidth,
      clientWidth: facts.clientWidth,
      scrollWidth: facts.scrollWidth,
      bodyTextLength: facts.bodyTextLength,
      loaded: facts.loaded && facts.bodyTextLength > 0,
      screenshotPath,
      error: null,
    };
  } finally {
    await context.close();
  }
}

async function revealLazyPageContent(
  page: Page,
): Promise<void> {
  await page.evaluate(async () => {
    const root = document.documentElement;
    const previousScrollBehavior = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";
    const pause = () => new Promise<void>((resolvePause) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolvePause()));
    });
    const maxY = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    const step = Math.max(240, Math.floor(innerHeight * 0.7));
    for (let y = 0, count = 0; y <= maxY && count < 50; y += step, count += 1) {
      scrollTo(0, y);
      await pause();
    }
    scrollTo(0, maxY);
    await pause();
    scrollTo(0, 0);
    await new Promise<void>((resolveSettle) => {
      setTimeout(resolveSettle, 850);
    });
    root.style.scrollBehavior = previousScrollBehavior;
  });
}

async function runProjectBuild(
  workspaceRoot: string,
): Promise<ProjectDeliverableValidation["build"]> {
  const command = "npm run build";
  const output: string[] = [];
  const child = spawn("npm", ["run", "build"], {
    cwd: workspaceRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => output.push(String(chunk)));
  child.stderr?.on("data", (chunk) => output.push(String(chunk)));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 120_000);
  const exitCode = await new Promise<number | null>((resolveExit) => {
    child.once("error", () => resolveExit(null));
    child.once("close", (code) => resolveExit(code));
  });
  clearTimeout(timer);
  return {
    command,
    exitCode,
    timedOut,
    outputTail: output.join("").slice(-8_000),
  };
}

function emptyViewport(
  requestedWidth: number,
  requestedHeight: number,
  error: string,
): ProjectViewportObservation {
  return {
    requestedWidth,
    requestedHeight,
    innerWidth: null,
    clientWidth: null,
    scrollWidth: null,
    bodyTextLength: null,
    loaded: false,
    screenshotPath: null,
    error: error.slice(0, 500),
  };
}
