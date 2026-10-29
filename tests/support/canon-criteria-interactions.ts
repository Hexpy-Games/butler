// test-category: security
import { strict as assert } from "node:assert";
import type { Locator, Page } from "playwright";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import { seedChildCriteria, type CriteriaFixture } from "./canon-criteria-fixture.ts";
import { auditCanonCardFocus } from "./canon-registration-cards.ts";

export type Capture = (state: string, region: Locator | Locator[], focus?: boolean, surface?: boolean) => Promise<void>;
export async function verifyCriteriaInteractions(page: Page, server: NativeAppServerHandle, fixture: CriteriaFixture, detail: Locator, capture: Capture) {
  const tree = detail.locator('[data-test-class="canon-spec-tree"]');
  const row = tree.locator('[data-criterion-id="VB-03"]');
  const unconfirmed = row.getByRole("button", { name: "VB-03 미확인", exact: true });
  await unconfirmed.waitFor();
  assert.equal(await unconfirmed.getAttribute("aria-pressed"), "false");
  await capture("criterion-unconfirmed", row, false, true);
  await unconfirmed.focus(); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
  assert(await unconfirmed.evaluate(element => element === document.activeElement));
  await capture("criterion-keyboard-focused", row, true, true);
  await page.evaluate(() => {
    const events: string[] = [];
    Object.assign(window, { criteriaMotion: events });
    document.addEventListener("animationstart", event => events.push((event as AnimationEvent).animationName));
  });
  const update = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith(`/criteria/VB-03`));
  await page.keyboard.press("Space"); assert((await update).ok());
  const confirmed = row.getByRole("button", { name: "VB-03 확인됨", exact: true });
  await confirmed.waitFor();
  const sectionMeters = page.locator('[data-session-section="task"] [data-test-class="canon-criteria-progress"]');
  assert.equal(await sectionMeters.count(), 1);
  await sectionMeters.getByRole("progressbar", { name: "1/2 확인", exact: true }).waitFor();
  await page.waitForFunction(() => (window as unknown as { criteriaMotion: string[] }).criteriaMotion.some(name => name.includes("rolling-swap-in")));
  await capture("criterion-confirmed", row, false, true);
  await detail.getByText("VB-03 확인", { exact: true }).waitFor();
  assert((await detail.locator('[data-test-class="canon-activity"]').innerText()).includes("하늘"));
  await auditCanonCardFocus(page, tree);
  // Both failure classes are delivered at the wire; no retries or hidden optimistic state.
  const path = `**/canon/specs/${fixture.node}/criteria/VB-03`;
  await page.route(path, route => route.fulfill({ status: 500, json: { error: { code: "internal", message: "Request failed" } } }));
  await confirmed.and(page.locator('[aria-disabled="false"]')).waitFor();
  await confirmed.focus(); await page.keyboard.press("Enter");
  await page.locator('[data-sonner-toast]').waitFor();
  assert.equal(await confirmed.getAttribute("aria-pressed"), "true");
  await page.unroute(path);
  let reads = 0;
  page.on("response", response => { if (response.request().method() === "GET" && response.url().endsWith(`/canon/epics/${fixture.epic}`)) reads++; });
  await page.route(path, route => route.fulfill({ status: 409, json: { error: { code: "conflict", message: "Revision conflict" } } }));
  const reloaded = page.waitForResponse(response => response.request().method() === "GET" && response.url().endsWith(`/canon/epics/${fixture.epic}`));
  await confirmed.and(page.locator('[aria-disabled="false"]')).waitFor();
  await confirmed.focus(); await page.keyboard.press("Enter"); await reloaded;
  await page.getByText("다른 사람이 먼저 고쳤습니다", { exact: true }).waitFor();
  assert(reads > 0); await page.unroute(path);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await confirmed.and(page.locator('[aria-disabled="false"]')).waitFor();
  await confirmed.focus(); await page.keyboard.press("Enter");
  await unconfirmed.waitFor();
  await tree.getByRole("progressbar", { name: "0/2 확인", exact: true }).waitFor();
  assert.equal(await row.locator('[data-motion="incoming"]').count(), 0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await unconfirmed.and(page.locator('[aria-disabled="false"]')).waitFor();
  await unconfirmed.focus(); await page.keyboard.press("Space");
  await confirmed.waitFor();
  const current = await server.api<{ criteria: { confirmed: number; total: number } }>(`/canon/epics/${fixture.epic}`);
  assert.deepEqual(current.criteria, { confirmed: 1, total: 2 });
}

export async function verifyChildCriteria(page: Page, server: NativeAppServerHandle, fixture: CriteriaFixture, capture: Capture) {
  seedChildCriteria(server, fixture);
  await page.goto(server.url);
  const toggle = page.locator('[data-test-class="session-info-toggle"]'); await toggle.waitFor();
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  const tree = page.locator('[data-test-class="canon-spec-tree"]');
  await tree.getByRole("progressbar", { name: "0/3 확인", exact: true }).waitFor();
  await tree.getByRole("button", { name: "VB-05 미확인", exact: true }).click();
  await tree.getByRole("button", { name: "VB-05 확인됨", exact: true }).waitFor();
  await tree.getByRole("progressbar", { name: "1/3 확인", exact: true }).waitFor();
  assert.equal(await page.locator('[data-session-section="task"] [data-test-class="canon-criteria-progress"]').count(), 1);
  await capture("child-criterion-confirmed", tree, false, true);
  await auditCanonCardFocus(page, tree);
}

export async function verifyEnglishCriteria(page: Page, server: NativeAppServerHandle) {
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en" }) });
  await page.goto(server.url);
  const toggle = page.locator('[data-test-class="session-info-toggle"]'); await toggle.waitFor();
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  const tree = page.locator('[data-test-class="canon-spec-tree"]');
  const control = tree.getByRole("button", { name: "VB-03 not confirmed", exact: true });
  await control.waitFor(); await control.focus(); await page.keyboard.press("Space");
  await tree.getByRole("button", { name: "VB-03 confirmed", exact: true }).waitFor();
  await tree.getByRole("progressbar", { name: "2/3 confirmed", exact: true }).waitFor();
}
