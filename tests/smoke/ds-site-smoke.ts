import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";

// Static DS site (dist-ds-site/, the GitHub Pages artifact) served by `vite preview`: Overview renders
// at "/", query deep links (?page=components/Button, #anchors) open item pages, and the page never
// requests anything outside its own origin (no gateway, no 127.0.0.1 API, no telemetry).

const uiRoot = resolve(process.cwd(), "packages", "butler-app", "client", "ui");
const distDir = join(uiRoot, "dist-ds-site");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolvePort(address.port) : reject(new Error("no port"))));
    });
  });
}

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`vite preview did not start at ${url}`);
}

async function visit(page: Page, url: string, selector: string, label: string): Promise<void> {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.locator(selector).first().waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => { throw new Error(`${label}: ${selector} did not render at ${url}`); });
}

assert(existsSync(join(distDir, "index.html")), `missing ${distDir}/index.html; run build:ds-site first`);
for (const file of ["CNAME", "404.html", "LICENSE.txt", "third-party-licenses.txt"]) {
  assert(existsSync(join(distDir, file)), `dist-ds-site is missing ${file}`);
}

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
// Spawn vite's own entry (not npx) so killing this child stops the server and nothing outlives the test.
const viteBin = join(uiRoot, "node_modules", "vite", "bin", "vite.js");
const preview = spawn(
  "node",
  [viteBin, "preview", "--config", "vite.ds-site.config.ts", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { cwd: uiRoot, stdio: ["ignore", "pipe", "pipe"] },
);
let previewLog = "";
preview.stdout?.on("data", (chunk) => { previewLog += chunk; });
preview.stderr?.on("data", (chunk) => { previewLog += chunk; });

const browser = await chromium.launch({ headless: true });
try {
  await waitForServer(`${origin}/`);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const foreign: string[] = [];
  const errors: string[] = [];
  // Anything outside the preview origin is blocked and recorded: the static site must be self-contained.
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(`${origin}/`) || url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
    foreign.push(url);
    return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

  await visit(page, `${origin}/`, "[data-ds-overview]", "root");
  assert((await page.title()).includes("Butler Design System"), "site title is missing");

  await visit(page, `${origin}/?page=components/Button`, '[data-ds-detail="Button"]', "item deep link");
  const stories = await page.locator('[data-ds-detail="Button"] [data-ds-story]').count();
  assert(stories >= 2, `item deep link rendered ${stories} stories`);

  await visit(page, `${origin}/?page=foundations/color&theme=dark`, '[data-ds-foundations="color"]', "foundations deep link");
  assert(await page.evaluate(() => document.body.classList.contains("theme-dark")), "theme=dark deep link did not apply");

  await visit(page, `${origin}/?page=patterns`, "[data-ds-patterns]", "patterns deep link");

  // Bundled typefaces load from the site itself (Typeface Contract).
  const fonts = await page.evaluate(async () => {
    await document.fonts.load('14px "Pretendard Variable"', "Butler 버틀러");
    await document.fonts.load('13px "IBM Plex Mono"', "const");
    const woff2 = performance.getEntriesByType("resource").map((entry) => entry.name).filter((name) => name.endsWith(".woff2"));
    return {
      pretendard: document.fonts.check('14px "Pretendard Variable"', "Butler 버틀러"),
      plex: document.fonts.check('13px "IBM Plex Mono"', "const"),
      sameOrigin: woff2.length > 0 && woff2.every((name) => name.startsWith(location.origin)),
    };
  });
  assert(fonts.pretendard && fonts.plex && fonts.sameOrigin, `bundled fonts did not load same-origin: ${JSON.stringify(fonts)}`);

  assert(foreign.length === 0, `static site requested foreign URLs:\n${foreign.join("\n")}`);
  assert(errors.length === 0, `static site logged errors:\n${errors.join("\n")}`);
  console.log(`ds-site smoke passed: overview + 3 deep links, 0 foreign requests (${origin})`);
} catch (error) {
  if (previewLog) console.error(previewLog);
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  preview.kill();
}
process.exit();
