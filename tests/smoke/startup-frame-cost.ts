/** Complete static card first frames and Chromium parse/style/script trace. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { smokeBrowserArgs } from "../support/smoke-browser-args";

const output = resolve(".tmp/startup-evidence");
mkdirSync(output, { recursive: true });
const samples: Record<string, number[]> = {};
for (let round = 0; round < 5; round++) {
  for (const theme of ["light", "dark"]) for (const kind of ["startup", "quit"]) {
  const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });
  try {
      const page = await browser.newPage({ viewport: { width: 296, height: 264 } });
      const session = await page.context().newCDPSession(page);
      const events: Array<{ name: string; dur?: number }> = [];
      session.on("Tracing.dataCollected", ({ value }) => events.push(...value as unknown as Array<{ name: string; dur?: number }>));
      await session.send("Tracing.start", { categories: "devtools.timeline,blink.user_timing,v8", transferMode: "ReportEvents" });
      const requests: string[] = [];
      page.on("request", (request) => requests.push(request.url()));
      const url = pathToFileURL(resolve("packages/butler-app/client/ui/lifecycle-assets/lifecycle.html"));
      url.search = new URLSearchParams({ kind, theme, locale: "ko", motion: "reduced" }).toString();
      await page.goto(url.href);
      await page.locator("html[data-painted=true]").waitFor();
      const result = await page.evaluate(() => ({
        marks: Object.fromEntries(performance.getEntriesByType("mark").map(({ name, startTime }) => [name, startTime])),
        images: document.images.length, font: document.fonts.check('14px "Pretendard Variable"'),
        mark: document.querySelector<HTMLCanvasElement>('[data-slot="mark"]')!.width,
        title: document.querySelector('[data-slot="title"]')!.textContent,
        line: document.querySelector('[data-slot="line"]')!.textContent,
        overflow: document.documentElement.scrollWidth > innerWidth,
      }));
      assert.equal(result.images, 0);
      assert.ok(result.font && result.mark > 0 && !result.overflow);
      assert.equal(result.title, kind === "startup" ? "Butler 시작 중…" : "Butler 종료 중…");
      assert.equal(result.line, kind === "startup" ? "준비하는 중…" : "작업을 저장하는 중…");
      assert.ok(requests.every((url) => url.startsWith("data:") || url.startsWith("file:") && ["lifecycle.html", "mark.js", "state.js"].includes(new URL(url).pathname.split("/").pop()!)));
      (samples[`${kind}/${theme}`] ??= []).push(result.marks.first_frame!);
      const ended = new Promise<void>((done) => session.once("Tracing.tracingComplete", () => done()));
      await session.send("Tracing.end"); await ended;
      if (round === 0) {
        const breakdown = Object.fromEntries(["ParseHTML", "UpdateLayoutTree", "EvaluateScript", "Paint", "Layout"].map((name) => [name, events.filter((event) => event.name === name).reduce((total, event) => total + (event.dur ?? 0) / 1000, 0)]));
        writeFileSync(join(output, `renderer-${kind}-${theme}.json`), JSON.stringify({ marks: result.marks, breakdown }, null, 2));
      }
  } finally { await browser.close(); }
  }
}
const rows = Object.entries(samples).map(([surface, values]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { surface, n: values.length, medianMs: sorted[2], p95Ms: sorted[4] };
});
console.table(rows);
writeFileSync(join(output, "card-frame-cost.json"), JSON.stringify({ method: "fresh Chromium pages; complete font, mark and localized text; not native window presentation", rows }, null, 2));
