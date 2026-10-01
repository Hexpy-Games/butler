import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { chromium } from "playwright";
import { getAppCopy } from "../../packages/butler-app/client/ui/src/app/copy.ts";

// Existing App visual harness: real Settings navigation, no Agent or model calls.
const catalog = JSON.parse(readFileSync("deploy/licenses/catalog.json", "utf8"));
const root = resolve("packages/butler-app/client/ui/dist");
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const path = resolve(root, `.${decodeURIComponent(new URL(request.url).pathname)}`);
    if (path !== root && !path.startsWith(`${root}${sep}`)) return new Response(null, { status: 403 });
    const file = Bun.file(path === root ? `${root}/index.html` : path);
    if (await file.exists()) return new Response(file);
    return Response.json({ error: "Offline smoke: no API" }, { status: 503 });
  },
});
const browser = await chromium.launch({ headless: true });
try {
  for (const locale of ["en", "ko"]) {
    const copy = getAppCopy(locale === "ko" ? "ko-KR" : "en-US");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === server.url.origin) return route.continue();
      return route.abort();
    });
    let reads = 0;
    page.on("request", (request) => { if (request.url().includes("THIRD_PARTY_NOTICES")) reads++; });
    const cdp = await page.context().newCDPSession(page);
    await page.goto(`${server.url}?visual=components&surface=ss03&locale=${locale}`);
    await page.locator('[data-test-class~="composer-card"]').waitFor();
    // The ss03 fixture opens its session observer; dismiss it before navigation.
    await page.getByRole("dialog").getByRole("button", { name: locale === "ko" ? "닫기" : "Close", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    const settings = page.getByRole("button", { name: copy.sidebar.settings, exact: true });
    await settings.click();
    await page.getByRole("button", { name: copy.settings.sections.about, exact: true }).click();
    await page.waitForTimeout(1000);
    if (reads !== 0) throw new Error("Notices read before opening");
    await cdp.send("HeapProfiler.collectGarbage");
    const before = (await cdp.send("Runtime.getHeapUsage")).usedSize;
    const started = performance.now();
    await page.getByRole("button", { name: locale === "ko" ? "오픈소스 라이선스" : "Open source licenses", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const rows = dialog.locator("[data-test-class~=open-source-licenses] [data-slot=disclosure-row-title]");
    await page.waitForFunction((count) => document.querySelectorAll("[data-test-class~=open-source-licenses] [data-slot=disclosure-row-title]").length === count, catalog.components.length);
    const elapsed = performance.now() - started;
    const titles = await rows.allTextContents();
    for (const component of catalog.components) {
      if (!titles.some((title) => title.includes(`${component.name} ${component.version}`))) throw new Error(`Missing ${component.id}`);
    }
    await cdp.send("HeapProfiler.collectGarbage");
    const after = (await cdp.send("Runtime.getHeapUsage")).usedSize;
    console.log(`${locale}: ${titles.length} components; open ${elapsed.toFixed(1)} ms; retained heap delta ${after - before} bytes; idle reads 0`);
    await dialog.getByRole("textbox", { name: locale === "ko" ? "구성요소 검색" : "Search components" }).fill("tokio ");
    const tokio = dialog.getByRole("button", { name: /^tokio [0-9]/ });
    await tokio.click();
    await dialog.getByText("License: https://", { exact: false }).first().waitFor();
    await dialog.getByText("Copyright", { exact: false }).first().waitFor();
    if (Number(reads) !== 1) throw new Error(`Expected one notice read, got ${reads}`);
    for (const width of [1440, 375, 320, 390, 430]) {
      await page.setViewportSize({ width, height: 900 });
      const box = await dialog.boundingBox();
      if (!box || box.x < 0 || box.x + box.width > width + 1) throw new Error(`Dialog overflows ${width}px`);
    }
    await page.close();
  }
  console.log("Offline Settings → Open source licenses → tokio smoke passed (320–1440px)");
} finally {
  await browser.close();
  await server.stop();
}
