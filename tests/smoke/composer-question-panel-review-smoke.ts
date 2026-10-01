import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Locator, type Page } from "playwright";

// Viewer harness: static DS build, no gateway, owner data or model calls.
// Run after `bun run --cwd packages/butler-app/client/ui build:ds-site`.
const root = resolve("packages/butler-app/client/ui/dist-ds-site");
const output = resolve(".tmp/question-panel-review");
mkdirSync(output, { recursive: true });
const server = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  fetch(request) {
    const path = new URL(request.url).pathname;
    return new Response(Bun.file(root + (path === "/" ? "/index.html" : path)));
  },
});
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const story = (name: string) => page.locator(`[data-ds-story="${name}"]`).first();

/** Each mask agrees with actual scroll geometry, including both endpoints. */
async function auditEdges(scope: Locator) {
  const edges = scope.locator("[data-scroll-fade]");
  for (const edge of await edges.all()) {
    await edge.evaluate((node) => {
      const e = node as HTMLElement;
      if (e.dataset.scrollFade === "x") e.scrollLeft = 0;
      else e.scrollTop = 0;
    });
    await assertEdge(edge);
    await edge.evaluate((node) => {
      const e = node as HTMLElement;
      if (e.dataset.scrollFade === "x") e.scrollLeft = (e.scrollWidth - e.clientWidth) / 2;
      else e.scrollTop = (e.scrollHeight - e.clientHeight) / 2;
    });
    await assertEdge(edge);
    await edge.evaluate((node) => {
      const e = node as HTMLElement;
      if (e.dataset.scrollFade === "x") e.scrollLeft = e.scrollWidth;
      else e.scrollTop = e.scrollHeight;
    });
    await assertEdge(edge);
    await edge.evaluate((node) => {
      const e = node as HTMLElement;
      e.scrollLeft = 0; e.scrollTop = 0;
    });
    await assertEdge(edge);
  }
}
async function assertEdge(edge: Locator) {
  await edge.evaluate(async (node) => {
    const e = node as HTMLElement;
    const matches = () => {
      const x = e.dataset.scrollFade === "x";
      const size = x ? e.clientWidth : e.clientHeight;
      const total = x ? e.scrollWidth : e.scrollHeight;
      const position = Math.abs(x ? e.scrollLeft : e.scrollTop);
      const overflow = total - size > 1;
      const start = !overflow || position <= 1;
      const end = !overflow || position + size >= total - 1;
      const css = getComputedStyle(e);
      const fadeStart = parseFloat(css.getPropertyValue("--scroll-fade-start"));
      const fadeEnd = parseFloat(css.getPropertyValue("--scroll-fade-end"));
      return e.dataset.overflowing === String(overflow) && e.dataset.atStart === String(start)
        && e.dataset.atEnd === String(end) && (start ? fadeStart < 0.01 : fadeStart > 13.9)
        && (end ? fadeEnd < 0.01 : fadeEnd > 13.9)
        && (overflow || css.maskImage === "none");
    };
    const deadline = performance.now() + 2000;
    while (!matches()) {
      if (performance.now() > deadline) throw new Error(`Stale scroll mask: ${JSON.stringify(e.dataset)}`);
      await new Promise(requestAnimationFrame);
    }
  });
}
async function auditDeferral(scope: Locator, reduced: boolean, ko: boolean) {
  const panel = scope.locator("[data-slot=\"composer-question-panel\"]");
  const options = panel.locator("[data-question-option]");
  await options.last().click();
  const input = panel.locator('textarea');
  await input.fill("Preserved draft");
  await panel.getByRole("button", { name: ko ? "나중에" : "Answer later", exact: true }).click();
  const motion = await panel.evaluate((node) => node.getAnimations().map((a) => ({
    duration: a.effect?.getComputedTiming().duration,
    frames: (a.effect as KeyframeEffect).getKeyframes().map((f) => f.transform),
  })));
  assert(motion.some((a) => Number(a.duration) > 0), "Exit must keep the panel through a fade");
  if (reduced) assert(motion.some((a) => a.frames.every((f) => f === undefined)), "Reduced exit is opacity only");
  await panel.waitFor({ state: "detached" });
  await scope.getByRole("button", { name: ko ? "답변 대기" : "Answer pending", exact: true }).click();
  await panel.waitFor();
  // Restoration preserves the answer even when its row is no longer editing.
  assert.equal(await panel.locator("textarea").inputValue(), "Preserved draft");
}
async function auditChanges(scope: Locator, page: Page) {
  const tabs = scope.locator('[data-slot="tabs-list"]');
  const trigger = tabs.locator('[data-slot="tabs-trigger"]').last();
  const original = await trigger.textContent();
  await trigger.evaluate((e) => { e.textContent = "Long translated question heading ".repeat(5); });
  await assertEdge(tabs);
  assert.equal(await tabs.getAttribute("data-overflowing"), "true");
  await auditEdges(scope);
  await page.setViewportSize({ width: 375, height: 900 });
  await auditEdges(scope);
  await page.setViewportSize({ width: 1280, height: 900 });
  await trigger.evaluate((e, value) => { e.textContent = value; }, original);
  await auditEdges(scope);
}
try {
  for (const width of [375, 1280]) for (const locale of ["ko", "en"]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: 900 });
    const reduced = theme === "dark";
    await page.goto(`${server.url}?page=blocks/ComposerQuestionPanel&width=${width}&locale=${locale}&theme=${theme}&motion=${reduced ? "reduced" : "full"}`);
    const single = story("Single choice · recommended focus · Other");
    const tabbed = story("Three questions · Tabs · review");
    await single.locator('[data-slot="composer-question-panel"]').waitFor();
    await auditEdges(page.locator("[data-ds-examples]"));
    const spacing = await single.locator("[data-slot=\"composer-question-panel\"]").evaluate((e) => {
      const header = e.firstElementChild!;
      const title = header.children[1].lastElementChild!;
      const option = e.querySelector("[data-question-option]")!;
      return { top: parseFloat(getComputedStyle(header).paddingTop), gap: option.getBoundingClientRect().top - title.getBoundingClientRect().bottom };
    });
    assert.equal(spacing.top, 16);
    assert(spacing.gap >= 12 && spacing.gap <= 20, `Unbalanced single rhythm: ${JSON.stringify(spacing)}`);
    console.log(`SPACING ${width} ${locale} ${theme}: top=${spacing.top}px gap=${spacing.gap}px`);
    await single.screenshot({ path: `${output}/${width}-${locale}-${theme}-single.png` });
    await tabbed.screenshot({ path: `${output}/${width}-${locale}-${theme}-tabs.png` });
    await auditDeferral(single, reduced, locale === "ko");
    await auditChanges(tabbed, page);
    console.log(`PASS ${width} ${locale} ${theme}: single/tabs, masks, resize/content, defer/restore`);
  }
} finally {
  await browser.close();
  server.stop();
}
