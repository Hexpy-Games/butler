// Run with Node --experimental-strip-types against an already-open dashboard.
// Reads real rendered data; never sends messages or mutates project records.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const browser = await chromium.connectOverCDP(process.env.DASHBOARD_CDP ?? "http://127.0.0.1:9224");
const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes(":5173"));
assert(page, "Open the Butler dashboard in the Electron renderer first");
const output = process.env.DASHBOARD_EVIDENCE ?? "/tmp/dashboard-layout-r3";
await mkdir(output, { recursive: true });
const dashboard = page.locator('[data-test-class="project-dashboard-view"]');
const main = dashboard.locator("main");
const tabs = main.getByRole("tablist").first().getByRole("tab");
const oldViewport = page.viewportSize();
const report: unknown[] = [];
try {
  for (const width of [1280, 960, 430, 390, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(350); // AdaptiveShell pane transition after viewport changes.
    const positions: Array<{ x: number; width: number; gap: number }> = [];
    for (let tab = 0; tab < 5; tab++) {
      await tabs.nth(tab).click();
      const panel = main.getByRole("tabpanel").first();
      await panel.waitFor({ state: "visible" });
      await page.waitForTimeout(180); // Existing tab enter animation is 120 ms.
      const geometry = await dashboard.evaluate(root => {
        const main = root.querySelector("main")!;
        const panel = main.querySelector('[role="tabpanel"][data-state="active"]')!;
        const tabs = main.querySelector('[role="tablist"]')!;
        const box = main.getBoundingClientRect();
        const scroller = main.parentElement!.parentElement!;
        const composer = root.querySelector('[data-test-class="composer-wrap"]')!;
        return {
          x: box.x, width: box.width,
          gap: panel.getBoundingClientRect().top - tabs.getBoundingClientRect().bottom,
          scrollBottom: scroller.getBoundingClientRect().bottom,
          pageBottom: root.getBoundingClientRect().bottom,
          composerTop: composer.getBoundingClientRect().top,
          composerPosition: getComputedStyle(composer).position,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      assert(!geometry.overflow, `${width}/${tab}: document overflow`);
      assert.equal(geometry.composerPosition, "absolute");
      assert(Math.abs(geometry.scrollBottom - geometry.pageBottom) < 1, "scroll must extend behind composer");
      assert(geometry.composerTop < geometry.scrollBottom, "composer overlays scroll viewport");
      positions.push(geometry);
    }
    for (const geometry of positions) {
      assert(Math.abs(geometry.x - positions[0]!.x) < 1, `${width}: tab left edge changed`);
      assert(Math.abs(geometry.width - positions[0]!.width) < 1, `${width}: tab width changed`);
      assert(Math.abs(geometry.gap - positions[0]!.gap) < 1, `${width}: tab top gap changed`);
    }
    await tabs.nth(0).click();
    // Description is the second child: title header, description, then tabs.
    const aligned = await main.evaluate(root => {
      const row = root.children[1]!.firstElementChild!;
      const text = row.querySelector("p")!;
      const icon = row.querySelector("button svg")!;
      const style = getComputedStyle(text);
      const textCenter = text.getBoundingClientRect().top + parseFloat(style.paddingTop) + parseFloat(style.lineHeight) / 2;
      const box = icon.getBoundingClientRect();
      return Math.abs(box.y + box.height / 2 - textCenter);
    });
    assert(aligned < 1.5, `${width}: description icon first-line center differs by ${aligned}px`);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${output}/${width}-overview.png`, animations: "disabled" });
    report.push({ width, positions, descriptionCenterDelta: aligned });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await tabs.nth(4).click();
  const chart = main.locator('[data-slot="chart"]').first();
  const svg = chart.locator(".recharts-surface");
  await svg.waitFor();
  await svg.scrollIntoViewIfNeeded();
  await svg.click({ position: { x: 100, y: 45 } });
  assert.equal(await svg.evaluate(el => getComputedStyle(el).outlineStyle), "none");
  assert.equal(await chart.evaluate(el => getComputedStyle(el).outlineStyle), "none");
  await svg.focus();
  await page.keyboard.press("ArrowLeft");
  assert.equal(await chart.getAttribute("data-pointer-focus"), "false");
  assert.equal(await chart.evaluate(el => getComputedStyle(el).outlineStyle), "solid");
  await page.mouse.click(0, 0);
  await page.screenshot({ path: `${output}/statistics-overlay.png`, animations: "disabled" });
  await tabs.nth(0).click();
  const editor = dashboard.getByRole("textbox", { name: "메시지 입력", exact: true });
  const previousDraft = await editor.innerText();
  assert.equal(previousDraft.trim(), "", "Use an empty dashboard draft; never overwrite user content");
  const reserve = () => dashboard.evaluate(el => parseFloat(getComputedStyle(el).getPropertyValue("--footer-reserve")));
  const initialReserve = await reserve();
  try {
    await editor.fill(Array.from({ length: 8 }, () => "Layout verification draft — not sent").join("\n"));
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-test-class="project-dashboard-view"]')!;
      const height = root.querySelector('[data-test-class="composer-wrap"]')!.getBoundingClientRect().height;
      return Math.abs(height - parseFloat(getComputedStyle(root).getPropertyValue("--footer-reserve"))) < 1;
    });
    assert(await reserve() > initialReserve, "reserve must track expanded composer");
    const reachable = await main.evaluate(el => {
      const scroller = el.parentElement!.parentElement!;
      scroller.scrollTop = scroller.scrollHeight;
      const composer = el.closest('[data-test-class="project-dashboard-view"]')!.querySelector('[data-test-class="composer-wrap"]')!;
      return el.getBoundingClientRect().bottom <= composer.getBoundingClientRect().top;
    });
    assert(reachable, "last content must be reachable above expanded composer");
  } finally {
    await editor.fill(previousDraft);
  }
  await writeFile(`${output}/checks.json`, JSON.stringify({ pass: true, report }, null, 2));
  console.log(`PASS: 30 tab geometries, 6 description alignments, pointer/keyboard chart focus, expanded composer reserve. ${output}`);
} finally {
  if (oldViewport) await page.setViewportSize(oldViewport);
}
process.exit(0);
