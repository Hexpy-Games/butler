import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  MOBILE_VIEWPORTS,
  assertMobileViewer,
  assertReducedMotionDrawer,
  assertReflow,
  launchMobileBrowser,
  mobileContext,
} from "../support/ds-viewer-mobile-checks.ts";

// DS Viewer on phones (375x812, 430x932; WebKit when installed), light and dark, plus reflow at 320: the app's
// drawer, compact titlebar, View options and the search sheet (tests/support/ds-viewer-mobile-checks.ts).
// Serves the built UI (dist/) itself on a private loopback port; no app server, no model.

const uiRoot = resolve(process.cwd(), "packages", "butler-app", "client", "ui", "dist");
if (!existsSync(join(uiRoot, "index.html"))) throw new Error("UI dist is missing. Run `bun run app:ui:build` first.");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const file = Bun.file(join(uiRoot, path === "/" ? "index.html" : path));
    return (await file.exists()) ? new Response(file) : new Response(Bun.file(join(uiRoot, "index.html")));
  },
});
const base = `http://127.0.0.1:${server.port}/`;
const url = (params: Record<string, string>) => `${base}?${new URLSearchParams({ visual: "design-system", motion: "full", ...params })}`;

const { browser, engine } = await launchMobileBrowser();
const context = await mobileContext(browser, MOBILE_VIEWPORTS[0]);
let runs = 0;
try {
  for (const viewport of MOBILE_VIEWPORTS) {
    for (const colorScheme of ["light", "dark"] as const) {
      const page = await context.newPage();
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await assertMobileViewer(page, url, `${engine} ${viewport.label} ${colorScheme}`);
      if (errors.length) throw new Error(`${viewport.label} ${colorScheme}: page errors:\n${errors.join("\n")}`);
      await page.close();
      runs += 1;
    }
    const reduced = await context.newPage();
    await reduced.setViewportSize(viewport);
    await reduced.emulateMedia({ reducedMotion: "reduce" });
    await assertReducedMotionDrawer(reduced, url, `${engine} ${viewport.label}`);
    await reduced.close();
  }
  // The smallest phone: every page still reflows.
  const small = await context.newPage();
  await small.setViewportSize({ width: 320, height: 640 });
  await assertReflow(small, url, `${engine} 320x640`);
  await small.close();
  console.log(`ds-viewer-mobile-smoke: ok (${engine}, ${runs} runs + reduced motion)`);
} finally {
  await browser.close();
  server.stop(true);
}
