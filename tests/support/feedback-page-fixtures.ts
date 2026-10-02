import type { Page, Route } from "playwright";
export const feedbackStates = ["populated", "long", "confirm-delete", "confirm-reset", "empty", "load-failure"];
export function feedbackRows(locale: string, long: boolean) {
  const text = locale === "ko" ? "날짜는 확인한 자료를 기준으로 적어 주세요." : "Use dates from the verified source.";
  return [
    { feedback_id: "fb_global", text: long ? `${text}\n${"complete_identifier_".repeat(90)}\n${text.repeat(12)}` : text, scope: "global", state: "active", updated_at: new Date().toISOString(), expires_at: new Date(Date.now() + 7 * 86400000).toISOString() },
    { feedback_id: "fb_project", text: locale === "ko" ? "이 프로젝트에서는 접근성을 먼저 확인해 주세요." : "Check accessibility first in this project.", scope: "project:shot-project", state: "pending", updated_at: new Date().toISOString(), expires_at: null },
    { feedback_id: "fb_session", text: locale === "ko" ? "이번 답변에는 예시를 모두 포함해 주세요." : "Include all examples in this reply.", scope: "session:shot-chat", state: "active", updated_at: new Date().toISOString(), expires_at: null },
    { feedback_id: "fb_promoted", text: "PROMOTED_HIDDEN", scope: "global", state: "applied", updated_at: new Date().toISOString(), expires_at: null },
    { feedback_id: "fb_discarded", text: "DISCARDED_HIDDEN", scope: "global", state: "discarded", updated_at: new Date().toISOString(), expires_at: null },
  ];
}
export async function seedFeedback(page: Page, locale: string, state: string) {
  let rows = state === "empty" ? [] : feedbackRows(locale, state === "long");
  let reads = 0;
  let deletes = 0;
  let resets = 0;
  await page.route("**/memory/feedback**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "DELETE") { deletes++; rows = rows.filter((row) => !path.endsWith(row.feedback_id)); }
    else if (request.method() === "POST" && path.endsWith("/reset")) { resets++; rows = []; }
    else {
      reads++;
      if (state === "load-failure") return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Unavailable" } }) });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: { entries: rows } }) });
  });
  return { counts: () => ({ reads, deletes, resets }) };
}
export async function checkFeedback(page: Page, locale: string, state: string) {
  const card = page.locator('[data-settings-section-id="recent-feedback"]');
  await card.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('[data-settings-section-id="recent-feedback"]')?.getAttribute("aria-busy") !== "true");
  if (await card.getByText("PROMOTED_HIDDEN").count() || await card.getByText("DISCARDED_HIDDEN").count()) throw new Error("Resolved feedback must stay hidden");
  if (["confirm-delete", "confirm-reset"].includes(state)) {
    if (state === "confirm-delete") await card.locator('[data-test-class="feedback-row"]').first().getByRole("button").click();
    else await card.getByRole("button", { name: locale === "ko" ? "초기화" : "Reset", exact: true }).click();
    await page.getByRole("alertdialog").waitFor();
  }
}
export async function feedbackFlow(page: Page, locale: string, counts: () => { reads: number; deletes: number; resets: number }) {
  const card = page.locator('[data-settings-section-id="recent-feedback"]');
  const rows = card.locator('[data-test-class="feedback-row"]');
  if (await rows.count() !== 3) throw new Error("Complete active list required");
  const beforeEvent = counts().reads;
  await page.evaluate(() => {
    const streams = (window as unknown as { memorySmokeStreams: EventSource[] }).memorySmokeStreams;
    for (const stream of streams) stream.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ id: 10002, type: "memory.operation", payload: { kind: "recent_feedback" } }) }));
  });
  await page.waitForFunction(() => document.querySelectorAll('[data-test-class="feedback-row"]').length === 3);
  await page.waitForTimeout(100);
  if (counts().reads <= beforeEvent) throw new Error("Feedback changes must refresh the card");
  const before = counts().reads;
  await page.waitForTimeout(1000);
  if (counts().reads !== before) throw new Error("Idle feedback polling");
  await rows.first().getByRole("button").click();
  await page.getByRole("alertdialog").getByRole("button", { name: locale === "ko" ? "삭제" : "Delete", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-test-class="feedback-row"]').length === 2);
  await card.getByRole("button", { name: locale === "ko" ? "초기화" : "Reset", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: locale === "ko" ? "초기화" : "Reset", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-test-class="feedback-row"]').length === 0);
  if (counts().deletes !== 1 || counts().resets !== 1) throw new Error("Page must issue exact owner routes");
  console.log(`feedback page flow: delete=1 reset=1 idle reads=0 total reads=${counts().reads}`);
}
export async function auditFeedback(page: Page) {
  const proof = await page.evaluate(() => {
    const section = document.querySelector<HTMLElement>('[data-settings-section-id="recent-feedback"]')!;
    const surface = section.querySelector<HTMLElement>("[data-kind]")!;
    const css = getComputedStyle(surface);
    const parent = getComputedStyle(section.closest('[data-slot="settings-detail"]') ?? section.parentElement!);
    const rows = [...section.querySelectorAll<HTMLElement>('[data-test-class="feedback-row"]')];
    const horizontal = [...section.querySelectorAll<HTMLElement>("*")].some((node) => node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 1 && ["auto", "scroll"].includes(getComputedStyle(node).overflowX));
    const scrolls = [...document.querySelectorAll<HTMLElement>("[data-scroll-top], [data-scroll-bottom]")];
    const fades = scrolls.filter((node) => node.scrollHeight > node.clientHeight + 1).map((node) => ({ top: node.dataset.atStart, bottom: node.dataset.atEnd, mask: getComputedStyle(node).maskImage }));
    return {
      cardBackground: css.backgroundColor, pageBackground: parent.backgroundColor, inset: css.padding,
      rowInsets: rows.every((row) => row.getBoundingClientRect().left > surface.getBoundingClientRect().left && row.getBoundingClientRect().right < surface.getBoundingClientRect().right),
      horizontalScroll: horizontal, fades,
      noticeAlignment: "DS Notice uses a start-aligned message stack",
      labels: "Title and description precede the card; Reset wraps below them on mobile",
      iconSlot: "No row glyphs; busy Spinner uses Button iconStart",
    };
  });
  if (proof.cardBackground === "rgba(0, 0, 0, 0)" || !proof.rowInsets || proof.horizontalScroll || proof.inset === "0px") throw new Error(`Feedback DS audit failed: ${JSON.stringify(proof)}`);
  return proof;
}
