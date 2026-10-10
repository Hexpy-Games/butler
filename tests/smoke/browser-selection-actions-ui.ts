/** Actual overlay bundle, before/after across mobile widths and both locales/themes. */
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchSmokeBrowser } from "../support/smoke-browser";
const evidence = process.env.BUTLER_BROWSER_EVIDENCE!; assert.ok(evidence);
mkdirSync(evidence, { recursive: true });
const browser = await launchSmokeBrowser();
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    (window as any).butlerBrowserOverlay = {
      subscribe: (handler: (frame: unknown) => void) => { (window as any).showPickFrame = handler; return () => {}; },
      chrome: () => {}, command: () => {},
    };
  });
  for (const stage of ["before", "after"]) {
    const root = stage === "before" ? resolve(evidence, "before-dist") : resolve("packages/butler-app/client/ui/dist");
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
      const path = new URL(request.url).pathname;
      return new Response(Bun.file(join(root, path === "/" ? "browser-overlay.html" : path)));
    } });
    try {
      for (const width of [320, 375, 390, 430]) for (const theme of ["light", "dark"]) for (const locale of ["ko", "en"]) {
        await page.setViewportSize({ width, height: 500 }); await page.goto(server.url.href);
        await page.waitForFunction(() => typeof (window as any).showPickFrame === "function");
        await page.evaluate(({ theme, locale, width }) => {
          document.documentElement.className = `theme-${theme}`;
          (window as any).showPickFrame({ locale: locale === "ko" ? "ko-KR" : "en-US", width, height: 500, pointerVisible: false, picking: true,
            selectionCount: 2, tab: "fixture", picks: [], reducedMotion: true, mode: "parked", at: { x: 20, y: 20 }, steps: [] });
        }, { theme, locale, width });
        await page.getByRole("toolbar").waitFor();
        if (stage === "after") for (const label of locale === "ko" ? ["이미지 저장", "텍스트 복사"] : ["Save image", "Copy text"]) {
          const button = page.getByRole("button", { name: label, exact: true }).filter({ visible: true });
          assert.equal(await button.count(), 1); assert.ok(await button.isEnabled());
        }
        assert.ok(await page.getByRole("toolbar").evaluate(element => { const r = element.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }), "bar fits narrow page");
        await page.screenshot({ path: join(evidence, `${stage}-overlay-${locale}-${theme}-${width}.png`) });
      }
    } finally { await server.stop(true); }
  }
  console.log("overlay before/after: 32 screenshots, narrow actions visible");
} finally { await browser.close(); }
