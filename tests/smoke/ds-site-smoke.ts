import { smokeBrowserArgs } from "../support/smoke-browser";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { chromium, type Page } from "playwright";
import { MOBILE_VIEWPORTS, assertMobileViewer, launchMobileBrowser, mobileContext } from "../support/ds-viewer-mobile-checks.ts";

// Static DS site smoke. Serves a ds-site build the way GitHub Pages does (real files, directory
// index + trailing-slash redirect, 404.html with a 404 status) and checks, under the build's base:
// Overview renders, query deep links (?page=components/Button, theme=dark) open item pages, sidebar
// navigation stays under the base, path-style links (<base>components/Button) are redirected onto the
// query form by the 404 helper, and the page never requests anything outside its own origin.
//
//   DS_SITE_BASE=/     (default) dist-ds-site/: a standalone site; its own 404.html + CNAME.
//   DS_SITE_BASE=/ds/  dist-ds-site-ds/: mounted at /ds/ of a combined-site fixture whose single
//                      404.html includes /ds/ds-404-redirect.js (the build emits no CNAME/404.html).
// An explicit dist dir may be passed as the first argument.
// On a phone (375x812, WebKit when installed) the site has the app's drawer navigation, compact
// titlebar, View options and search sheet, and no page scrolls sideways.

const uiRoot = resolve(process.cwd(), "packages", "butler-app", "client", "ui");
const segments = (process.env.DS_SITE_BASE ?? "").split("/").filter(Boolean);
const base = segments.length ? `/${segments.join("/")}/` : "/";
const standalone = base === "/";
const distDir = resolve(process.argv[2] ?? join(uiRoot, standalone ? "dist-ds-site" : `dist-ds-site-${segments.join("-")}`));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(existsSync(join(distDir, "index.html")), `missing ${distDir}/index.html; run build:ds-site (DS_SITE_BASE=${base}) first`);
for (const file of ["LICENSE.txt", "third-party-licenses.txt", "ds-404-redirect.js"]) {
  assert(existsSync(join(distDir, file)), `${distDir} is missing ${file}`);
}
for (const file of ["CNAME", "404.html"]) {
  assert(existsSync(join(distDir, file)) === standalone,
    standalone ? `${distDir} is missing ${file}` : `a sub-path build must not emit the host-owned ${file}`);
}

// The combined site's own pages when the DS site is mounted under a sub-path.
const combinedIndex = "<!doctype html><title>Combined site</title><p data-combined-home>home</p>";
const combined404 = `<!doctype html><title>Not found</title><script src="${base}ds-404-redirect.js"></script><p data-combined-404>not found</p>`;

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function fileUnder(root: string, relativePath: string): string | null {
  const full = normalize(join(root, relativePath));
  if (full !== root && !full.startsWith(root + sep)) return null;
  return existsSync(full) ? full : null;
}

/** GitHub Pages-like static hosting of distDir at `base`. */
function serve(pathname: string): Response {
  if (!standalone && pathname === "/") return html(combinedIndex);
  if (pathname === base.slice(0, -1) && base !== "/") return Response.redirect(base, 301);
  if (pathname.startsWith(base)) {
    const relativePath = decodeURIComponent(pathname.slice(base.length));
    const found = fileUnder(distDir, relativePath);
    if (found && statSync(found).isDirectory()) {
      if (!pathname.endsWith("/")) return Response.redirect(`${pathname}/`, 301);
      const index = fileUnder(found, "index.html");
      if (index) return new Response(Bun.file(index));
    } else if (found) {
      return new Response(Bun.file(found));
    }
  }
  return standalone ? html(readFileSync(join(distDir, "404.html"), "utf8"), 404) : html(combined404, 404);
}

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => serve(new URL(request.url).pathname) });
const origin = `http://127.0.0.1:${server.port}`;
const siteUrl = `${origin}${base}`;

function param(page: Page, name: string): string | null {
  return new URL(page.url()).searchParams.get(name);
}

async function visit(page: Page, url: string, selector: string, label: string): Promise<void> {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.locator(selector).first().waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => { throw new Error(`${label}: ${selector} did not render at ${url} (now ${page.url()})`); });
}

function assertUnderBase(page: Page, label: string): void {
  const { pathname } = new URL(page.url());
  assert(pathname === base || pathname === `${base}index.html`, `${label}: expected to stay at ${base}, got ${pathname}`);
}

const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const foreign: string[] = [];
  const errors: string[] = [];
  // Anything outside the served origin is blocked and recorded: the static site must be self-contained.
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(`${origin}/`) || url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
    foreign.push(url);
    return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  // A path-style link's document 404s by design (the helper then redirects); any failed subresource
  // (asset, font, helper script) is a real error. Load failures are tracked here, not via the console.
  page.on("response", (response) => {
    if (response.status() >= 400 && response.request().resourceType() !== "document") {
      errors.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(message.text());
  });

  await visit(page, siteUrl, "[data-ds-overview]", "overview");
  assert((await page.title()).includes("Butler Design System"), "site title is missing");
  assertUnderBase(page, "overview");

  await visit(page, `${siteUrl}?page=components/Button`, '[data-ds-detail="Button"]', "item deep link");
  const stories = await page.locator('[data-ds-detail="Button"] [data-ds-story]').count();
  assert(stories >= 2, `item deep link rendered ${stories} stories`);
  assertUnderBase(page, "item deep link");

  await visit(page, `${siteUrl}?page=foundations/color&theme=dark`, '[data-ds-foundations="color"]', "foundations deep link");
  assert(await page.evaluate(() => document.body.classList.contains("theme-dark")), "theme=dark deep link did not apply");

  await visit(page, `${siteUrl}?page=patterns`, "[data-ds-patterns]", "patterns deep link");

  // In-app navigation rewrites only the query, so it stays under the base.
  await visit(page, siteUrl, "[data-ds-overview]", "overview (nav)");
  const blocksRow = page.locator('[data-ds-nav-item="blocks"]');
  if (!(await blocksRow.isVisible())) await page.getByRole("button", { name: "Open navigation" }).click();
  await blocksRow.click();
  await page.locator('[data-ds-gallery="blocks"]').waitFor({ state: "visible" });
  assert(param(page, "page") === "blocks", "sidebar navigation did not write the page param");
  assertUnderBase(page, "sidebar navigation");

  // Path-style links 404 on a static host; the helper maps them onto the query form.
  await visit(page, `${siteUrl}components/Button?theme=dark`, '[data-ds-detail="Button"]', "path redirect");
  assertUnderBase(page, "path redirect");
  assert(param(page, "page") === "components/Button", `path redirect landed on ${page.url()}`);
  assert(await page.evaluate(() => document.body.classList.contains("theme-dark")), "path redirect dropped the query");

  if (!standalone) {
    // The helper only acts on its own base: other paths of the combined site keep their 404 page.
    await visit(page, `${origin}/help/missing`, "[data-combined-404]", "foreign 404");
    assert(new URL(page.url()).pathname === "/help/missing", `foreign 404 was redirected to ${page.url()}`);
    // A bare /ds (no trailing slash) still reaches the viewer.
    await visit(page, `${origin}${base.slice(0, -1)}`, "[data-ds-overview]", "base without trailing slash");
  }

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

  const mobile = await launchMobileBrowser();
  try {
    const phone = await mobileContext(mobile.browser, MOBILE_VIEWPORTS[0]);
    const phonePage = await phone.newPage();
    const phoneErrors: string[] = [];
    phonePage.on("pageerror", (error) => phoneErrors.push(error.message));
    await assertMobileViewer(phonePage, (params) => `${siteUrl}?${new URLSearchParams({ motion: "full", ...params })}`,
      `ds-site ${mobile.engine} ${MOBILE_VIEWPORTS[0].label}`, ["overview", "components/Button", "foundations/color", "guide"]);
    assert(phoneErrors.length === 0, `static site logged errors on a phone:\n${phoneErrors.join("\n")}`);
  } finally {
    await mobile.browser.close();
  }
  console.log(`ds-site smoke passed (base ${base}): overview, 3 deep links, sidebar nav, path redirect, phone navigation, 0 foreign requests`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.stop(true);
}
process.exit();
