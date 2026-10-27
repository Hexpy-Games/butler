import { strict as assert } from "node:assert";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { probeFocusRing } from "./focus-ring-clipping.ts";
import type { NativeAppServerHandle } from "./native-app-server.ts";

export async function auditCanonFacts(card: Locator) {
  assert.equal(await card.locator('[data-test-class="key-value-row"]').count(), 0, "proposal facts stack vertically");
  const facts = card.locator('[data-slot="field"][aria-labelledby]');
  for (const fact of await facts.all()) {
    const label = fact.locator('[data-slot="field-label"]');
    const title = await label.textContent(); assert(title);
    assert(await card.getByRole("group", { name: title, exact: true }).count() > 0, "title names the field group");
    assert.equal(await fact.getAttribute("aria-labelledby"), await label.getAttribute("id"));
    assert.equal(await label.evaluate(element => element.tagName), "DIV", "read-only title is not a control label");
    const geometry = await fact.evaluate(element => {
      const [label, value] = [...element.children].map(child => child.getBoundingClientRect());
      return { label, value, gap: getComputedStyle(element).rowGap, textAlign: getComputedStyle(element.lastElementChild!).textAlign };
    });
    assert(Math.abs(geometry.label.x - geometry.value.x) < 1, "label and value share the left edge");
    assert(geometry.value.y >= geometry.label.bottom, "value is below its label");
    assert(Math.abs(geometry.value.y - geometry.label.bottom - parseFloat(geometry.gap)) < 1, "field uses its DS gap");
    assert(["start", "left"].includes(geometry.textAlign), "value is left aligned");
  }
  const gaps = await card.locator('[data-slot="field"]').evaluateAll(fields => fields.map(field => getComputedStyle(field.parentElement!).rowGap));
  assert(gaps.every(gap => gap === gaps[0]), "read-only and editable fields share the card's field spacing");
}

export async function auditCanonCardFocus(page: Page, card: Locator) {
  const controls = card.locator("button, input, select");
  for (const control of await controls.all()) {
    if (await control.getAttribute("disabled") !== null) continue;
    await control.focus(); await page.keyboard.press("Tab"); await control.focus();
    const ring = await probeFocusRing(page); assert(ring); assert.deepEqual(ring.clips, []);
  }
  await page.mouse.move(0, 0);
  await page.locator(":focus").evaluateAll(elements => elements.forEach(element => (element as HTMLElement).blur()));
  await page.waitForFunction(() => [...document.querySelectorAll('[role="tooltip"]')].every(element => {
    const style = getComputedStyle(element);
    return style.visibility === "hidden" || Number.parseFloat(style.opacity) === 0 || !element.getClientRects().length;
  }));
}

/** The same native transcript anchor renders ask-tier changes and an Auto receipt. */
export async function captureRegistrationVariants(page: Page, server: NativeAppServerHandle, anchor: { session_id: string; source_turn_id: string }, project: string, shots: string, baseline: boolean) {
  await server.api(`/sessions/${anchor.session_id}/canon/propose`, { method: "POST", body: JSON.stringify({ turn_id: anchor.source_turn_id, call_id: "visual-record", apply: true,
    arguments: { project_id: project, summary: "추가 확인", changes: [{ op: "epic.create", title: "추가 확인 과제" }] },
  }) });
  const changed = await server.api<{ ask_id: string }>(`/sessions/${anchor.session_id}/canon/propose`, { method: "POST", body: JSON.stringify({ turn_id: anchor.source_turn_id, call_id: "visual-changes", apply: false,
    arguments: { project_id: project, summary: "다음 계획 등록", changes: [{ op: "plan.create", title: "다음 계획", description: "확인한 내용을 계획으로 남깁니다." }] },
  }) });
  await page.addInitScript(id => localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({ schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), active_session_id: id, left_open: true, right_open: false })), anchor.session_id);
  for (const theme of ["light", "dark"]) {
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: theme }) });
    await page.setViewportSize({ width: 1440, height: 1100 }); await page.goto(server.url);
    await page.getByText("입력 오류 과제 초안을 준비했습니다.", { exact: true }).first().waitFor();
    if (!baseline) {
      const record = page.locator('[data-test-class="canon-proposal-card"]').filter({ hasText: "과제 등록함 · 버틀러" });
      await record.waitFor(); assert.equal(await record.getByRole("button", { name: "열기", exact: true }).count(), 1);
      const changes = page.locator('[data-test-class="canon-proposal-card"][data-state="open"]');
      await changes.getByText("변경 제안 · 버틀러", { exact: true }).waitFor();
      assert.equal(await changes.getByRole("button", { name: "반영", exact: true }).count(), 1);
      await changes.scrollIntoViewIfNeeded();
      await auditCanonCardFocus(page, changes);
      await auditCanonCardFocus(page, record);
    }
    await page.screenshot({ path: join(shots, `${baseline ? "before" : "after"}-1440-${theme}-record-changes.png`) });
  }
  if (!baseline) await assertLatestCanonState(page, server, changed.ask_id.slice("canon:".length));
}

/** A chat/card acceptance can arrive while the card's first snapshot is in flight. */
async function assertLatestCanonState(page: Page, server: NativeAppServerHandle, id: string) {
  const path = `/canon/proposals/${id}`;
  const captured = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const states: unknown[] = [];
  let first = true;
  const handler = async (route: import("playwright").Route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch({ headers: { ...route.request().headers(), origin: new URL(server.url).origin } });
    assert.equal(response.status(), 200);
    states.push((await response.json()).data?.state);
    if (!first) return route.fulfill({ response });
    first = false; captured.resolve(); await release.promise;
    try { await route.fulfill({ response }); } finally { completed.resolve(); }
  };
  await page.route(`**${path}`, handler);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const live = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/events/live"));
    await page.reload(); await live;
    await Promise.race([captured.promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("initial proposal snapshot was not captured")), 30_000); })]);
    await server.api(path, { method: "POST", body: JSON.stringify({ outcome: "accepted" }) });
    const card = page.locator(`[data-proposal-id="${id}"]`);
    await card.getByText("등록함", { exact: true }).waitFor();
    release.resolve(); await completed.promise;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(await card.getAttribute("data-state"), "applied", "an earlier response must not reopen an applied card");
  } catch (error) {
    console.error(JSON.stringify({ snapshots: states, cards: await page.locator('[data-test-class="canon-proposal-card"]').allTextContents(), current: (await server.api<{ state: string }>(path)).state }));
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    release.resolve(); if (!first) await completed.promise; await page.unroute(`**${path}`, handler);
  }
}
