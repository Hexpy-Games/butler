import { strict as assert } from "node:assert";
import type { Locator, Page, Request } from "playwright";
import { join } from "node:path";
import { closeCanonInspector } from "./canon-board-inspector.ts";

/** Public-path regression: UI selection must not read the project dashboard. */
export async function verifyDashboardSelection(page: Page, projectId: string, shots: string, name: string) {
  const card = page.locator('[data-test-class="canon-board"] [data-kanban-item]')
    .filter({ hasText: "캐논" }).getByRole("button").first();
  const inspector = page.locator('[data-test-class~="right-inspector"]');
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.waitForFunction(() => {
    const panel = document.querySelector<HTMLElement>('[data-slot="adaptive-shell-inspector"]');
    return panel && new DOMMatrixReadOnly(getComputedStyle(panel).transform).m41 >= panel.getBoundingClientRect().width - 1;
  });
  assert.equal(await inspector.count(), 1, "Closed dashboard inspector stays mounted before its first open");
  let requests = 0;
  const count = (request: Request) => {
    if (request.method() === "GET" && new URL(request.url()).pathname === `/projects/${projectId}/dashboard`) requests++;
  };
  page.on("request", count);
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      await sampleInspectorMotion(page, card, "open", cycle === 0 ? join(shots, `${name}-open-90ms.png`) : undefined);
      await inspector.getByRole("heading", { name: "캐논", exact: true }).waitFor();
      assert.equal(await card.getAttribute("data-selected"), "true");
      await sampleInspectorMotion(page, page.locator('[data-test-class="titlebar-right-panel-toggle"]'), "close");
      assert.equal(await card.getAttribute("data-selected"), null);
    }
    assert.equal(requests, 0, "Three select/close cycles never refetch the dashboard");
    console.log(JSON.stringify({ selectionCycles: 3, dashboardRequests: requests, case: name }));
  } finally { page.off("request", count); }
  // Reduced motion uses the same mounted shell and fades without a slide.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await card.click();
  await inspector.getByRole("heading", { name: "캐논", exact: true }).waitFor();
  assert.equal(await page.locator('[data-slot="adaptive-shell-inspector"]').evaluate(element =>
    getComputedStyle(element).transform), "none", "Reduced motion never translates the inspector");
  await closeCanonInspector(page);
  const refresh = page.waitForResponse(response => response.request().method() === "GET"
    && new URL(response.url()).pathname === `/projects/${projectId}/dashboard`);
  await page.getByRole("button", { name: "캐논 보드 프로젝트 대시보드", exact: true }).click();
  assert((await refresh).ok(), "Explicit dashboard navigation still refreshes data");
}

async function sampleInspectorMotion(page: Page, trigger: Locator, direction: "open" | "close", screenshot?: string) {
  const sample = await trigger.evaluate(async element => {
    (element as HTMLElement).click();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const panel = document.querySelector<HTMLElement>('[data-slot="adaptive-shell-inspector"]');
    if (!panel) return null;
    const animations = document.getAnimations().filter(animation => animation.playState === "running" && animation.timeline === document.timeline);
    // Pin the real DS animations at 90ms so screenshot transport cannot miss the slide.
    for (const animation of animations) { animation.pause(); animation.currentTime = 90; }
    const transform = new DOMMatrixReadOnly(getComputedStyle(panel).transform);
    return { x: transform.m41, width: panel.getBoundingClientRect().width, animations: animations.length };
  });
  assert(sample, `Inspector remains mounted during ${direction}`);
  assert(sample.animations > 0 && sample.x > 0 && sample.x < sample.width,
    `Inspector is between its endpoints during ${direction}: ${JSON.stringify(sample)}`);
  if (screenshot) await page.screenshot({ path: screenshot });
  await page.evaluate(async () => {
    const animations = document.getAnimations().filter(animation => animation.playState === "paused" && animation.timeline === document.timeline);
    for (const animation of animations) animation.play();
    await Promise.allSettled(animations.map(animation => animation.finished));
  });
}
