// test-category: race
import { strict as assert } from "node:assert";
import type { Locator, Page, Request } from "playwright";
import { join } from "node:path";
import { canonAsideClose, closeCanonAside } from "./canon-board-aside.ts";

/** Public-path regression: selection never reads the project dashboard. */
export async function verifyDashboardSelection(page: Page, projectId: string, shots: string, name: string) {
  const card = page.locator('[data-test-class="canon-board"] [data-kanban-item]')
    .filter({ hasText: "캐논" }).getByRole("button").first();
  const aside = page.locator('[data-slot="management-page-aside"]');
  await page.emulateMedia({ reducedMotion: "no-preference" });
  assert.equal(await aside.count(), 0);
  let requests = 0;
  const count = (request: Request) => {
    if (request.method() === "GET" && new URL(request.url()).pathname === '/projects/' + projectId + '/dashboard') requests++;
  };
  page.on("request", count);
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      await sampleAsideMotion(page, card, "open", cycle === 0 ? join(shots, name + "-open-90ms.png") : undefined);
      await aside.getByRole("heading", { name: "캐논", exact: true }).waitFor();
      assert.equal(await card.getAttribute("data-selected"), "true");
      await sampleAsideMotion(page, canonAsideClose(page), "close");
      await aside.waitFor({ state: "hidden" });
      assert.equal(await card.getAttribute("data-selected"), null);
    }
    assert.equal(requests, 0, "Three select/close cycles never refetch the dashboard");
    console.log(JSON.stringify({ selectionCycles: 3, dashboardRequests: requests, case: name }));
  } finally { page.off("request", count); }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await card.click();
  await aside.getByRole("heading", { name: "캐논", exact: true }).waitFor();
  assert(await aside.evaluate(element => {
    const transform = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return transform.m41 === 0 && transform.m42 === 0;
  }), "Reduced motion has no aside travel");
  await closeCanonAside(page);
  const refresh = page.waitForResponse(response => response.request().method() === "GET"
    && new URL(response.url()).pathname === '/projects/' + projectId + '/dashboard');
  await page.getByRole("button", { name: "캐논 보드 프로젝트 대시보드", exact: true }).click();
  assert((await refresh).ok(), "Explicit dashboard navigation still refreshes data");
}

async function sampleAsideMotion(page: Page, trigger: Locator, direction: "open" | "close", screenshot?: string) {
  await trigger.click();
  const aside = page.locator('[data-slot="management-page-aside"][data-state="' + (direction === "close" ? "closed" : "open") + '"]');
  await aside.waitFor({ state: "attached" });
  const sample = await aside.evaluate(element => {
    const animations = element.getAnimations();
    for (const animation of animations) { animation.pause(); animation.currentTime = 90; }
    return { animations: animations.length, opacity: Number(getComputedStyle(element).opacity) };
  });
  assert(sample.animations > 0 && sample.opacity > 0 && sample.opacity < 1,
    "DS aside fades during " + direction + ": " + JSON.stringify(sample));
  if (screenshot) await page.screenshot({ path: screenshot });
  await aside.evaluate(async element => {
    const animations = element.getAnimations();
    for (const animation of animations) animation.play();
    await Promise.allSettled(animations.map(animation => animation.finished));
  });
}
