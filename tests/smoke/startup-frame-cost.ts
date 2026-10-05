/** Local-file first-frame proxy, paired complete production poster vs a one-pixel control. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { smokeBrowserArgs } from "../support/smoke-browser";

const dist = resolve("packages/butler-app/client/ui/lifecycle-assets");
const stills = resolve("packages/butler-app/client/ui/src/components/lifecycle/stills");
const copy = JSON.parse(readFileSync(join(dist, "copy.json"), "utf8"));
const keys = JSON.parse(readFileSync(join(stills, "keys.json"), "utf8")).stills as Record<string, { file: string }>;
const output = resolve(".tmp/startup-evidence");
mkdirSync(output, { recursive: true });
const samples: Record<string, number[]> = {};
const control = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQV1D+DwACJgFiaSS5mgAAAABJRU5ErkJggg==";
{
  for (let round = 0; round < 5; round++) {
    for (const poster of ["control", ...Object.values(keys).map((entry) => entry.file)]) {
      const browser = await chromium.launch({ channel: "chromium", headless: true, args: smokeBrowserArgs() });
      try {
      const context = await browser.newContext({ viewport: { width: 360, height: 264 } });
      const page = await context.newPage();
      const requests: string[] = [];
      page.on("request", (request) => requests.push(request.url()));
      await page.addInitScript((copy) => {
        (window as any).butlerLifecycle = { state: async () => ({ kind: "startup", stage: "prepare", theme: "light", locale: "ko", copy }), onState: () => undefined,
          painted: () => { (window as any).firstFrameMs = performance.now(); } };
      }, copy);
      const url = pathToFileURL(join(dist, "lifecycle.html"));
      url.searchParams.set("still", poster === "control" ? control : pathToFileURL(join(stills, poster)).href);
      await page.goto(url.href);
      await page.waitForFunction(() => (window as any).firstFrameMs > 0);
      const result = await page.evaluate(() => ({ ms: (window as any).firstFrameMs as number,
        image: (document.querySelector("img") as HTMLImageElement).naturalWidth,
        src: (document.querySelector("img") as HTMLImageElement).src,
        mark: (document.querySelector('[data-slot="mark"]') as HTMLCanvasElement).width,
        status: document.querySelector('[data-slot="line"]')?.textContent,
        overflow: document.documentElement.scrollWidth > innerWidth }));
      assert.ok(result.image > 0 && result.mark > 0 && result.status === "준비하는 중…" && !result.overflow);
      assert.ok(poster === "control" ? result.src === control : result.src.endsWith(poster), "requested poster really decoded; no silent fallback");
      assert.ok(requests.every((url) => url.startsWith("data:") || url.startsWith("file:") && ["lifecycle.html", "mark.js", "state.js", poster].includes(new URL(url).pathname.split("/").pop()!)), "only the lifecycle page, two scripts, inline font and selected still load");
      (samples[poster] ??= []).push(result.ms);
      if (round === 0 && poster === "butler.shoreline.light.0.webp") await page.screenshot({ path: join(output, "static-shoreline.png") });
      await context.close();
      } finally { await browser.close(); }
    }
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const controlMs = median(samples.control!);
  const rows = Object.entries(samples).map(([poster, values]) => ({ poster, n: values.length,
    medianMs: Number(median(values).toFixed(2)), maxMs: Number(Math.max(...values).toFixed(2)),
    deltaMedianMs: Number((median(values) - controlMs).toFixed(2)) }));
  console.table(rows);
  writeFileSync(join(output, "background-cost.json"), JSON.stringify({ method: "fresh Chromium contexts, local files, decoded poster+mark+status then two rAF; not OS presentation or Electron launch", rows }, null, 2));
}
