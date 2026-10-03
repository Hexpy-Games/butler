/** Local-file first-frame proxy, paired complete production poster vs a one-pixel control. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { smokeBrowserArgs } from "../support/smoke-browser";

const dist = resolve("packages/butler-app/client/ui/dist");
const keys = JSON.parse(readFileSync(join(dist, "startup/posters/keys.json"), "utf8")) as Record<string, string>;
const output = resolve(".tmp/startup-evidence");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ channel: "chromium", headless: true, args: smokeBrowserArgs() });
const samples: Record<string, number[]> = {};
const control = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQV1D+DwACJgFiaSS5mgAAAABJRU5ErkJggg==";
try {
  for (let round = 0; round < 5; round++) {
    for (const poster of ["control", ...Object.values(keys)]) {
      const context = await browser.newContext({ viewport: { width: 340, height: 280 } });
      const page = await context.newPage();
      const requests: string[] = [];
      page.on("request", (request) => requests.push(request.url()));
      await page.addInitScript(() => {
        (window as any).butlerStartup = { state: async () => ({ language: "ko" }), subscribe: () => undefined,
          painted: () => { (window as any).firstFrameMs = performance.now(); } };
      });
      const url = pathToFileURL(join(dist, "startup.html"));
      url.searchParams.set("poster", poster === "control" ? control : `startup/posters/${poster}`);
      await page.goto(url.href);
      await page.waitForFunction(() => (window as any).firstFrameMs > 0);
      const result = await page.evaluate(() => ({ ms: (window as any).firstFrameMs as number,
        image: (document.getElementById("wallpaper") as HTMLImageElement).naturalWidth,
        src: (document.getElementById("wallpaper") as HTMLImageElement).src,
        mark: (document.getElementById("mark") as HTMLImageElement).naturalWidth,
        status: document.getElementById("status")?.textContent,
        overflow: document.documentElement.scrollWidth > innerWidth }));
      assert.ok(result.image > 0 && result.mark > 0 && result.status === "버틀러를 준비합니다…" && !result.overflow);
      assert.ok(poster === "control" ? result.src === control : result.src.endsWith(poster), "requested poster really decoded; no silent fallback");
      assert.ok(requests.every((url) => url.startsWith("file:") && !/assets\/|\.woff|\.tsx/.test(url)), "no app/DS/font/network loads");
      (samples[poster] ??= []).push(result.ms);
      if (round === 0 && poster === "butler.shoreline.light.png") await page.screenshot({ path: join(output, "static-shoreline.png") });
      await context.close();
    }
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const controlMs = median(samples.control!);
  const rows = Object.entries(samples).map(([poster, values]) => ({ poster, n: values.length,
    medianMs: Number(median(values).toFixed(2)), maxMs: Number(Math.max(...values).toFixed(2)),
    deltaMedianMs: Number((median(values) - controlMs).toFixed(2)) }));
  console.table(rows);
  writeFileSync(join(output, "background-cost.json"), JSON.stringify({ method: "fresh Chromium contexts, local files, decoded poster+mark+status then two rAF; not OS presentation or Electron launch", rows }, null, 2));
} finally { await browser.close(); }
