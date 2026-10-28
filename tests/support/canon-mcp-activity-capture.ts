// test-category: format-pin
import { strict as assert } from "node:assert";
import type { Page } from "playwright";
import type { CanonActivityPage, EpicDetail } from "../../packages/butler-app/client/shared/canon-contracts.ts";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import { auditCanonCardFocus } from "./canon-registration-cards.ts";
import { assertActivityTimes } from "./canon-mcp-layout.ts";
import { captureRegion } from "./canon-mcp-crops.ts";

/** A compact capture fixture; the smoke verifies real paging before this runs. */
export async function captureActivitySample(page: Page, server: NativeAppServerHandle,
  epicId: string, directory: string, name: string) {
  const snapshot = await server.api<EpicDetail>(`/canon/epics/${epicId}`);
  const history = [...snapshot.activity ?? []];
  let cursor = snapshot.activity_before;
  while (cursor != null) {
    const older = await server.api<CanonActivityPage>(`/canon/epics/${epicId}/activity?before=${cursor}`);
    history.push(...older.activity); cursor = older.activity_before;
  }
  const activity = ["comment", "status", "created", "proposal_opened"].map(kind => {
    const row = history.find(row => row.kind === kind); assert(row, `Missing ${kind} capture fixture`); return row;
  }).sort((a, b) => b.seq - a.seq);
  assert(snapshot.activity_before != null, "Real history has more pages");
  const path = `**/canon/epics/${epicId}`;
  await page.route(path, route => route.fulfill({ json: { ok: true, data: {
    ...snapshot, activity, activity_before: snapshot.activity_before,
  } } }));
  try {
    await page.reload();
    await page.locator('[data-test-class~="mac-window"]').waitFor();
    const aside = page.getByRole("complementary", { name: "세션 정보", exact: true });
    if (!await aside.isVisible()) await page.locator('[data-test-class="session-info-toggle"]').click();
    const region = page.locator('[data-test-class="canon-epic-detail"] [data-test-class="canon-activity"]');
    await region.getByRole("button", { name: "더 보기", exact: true }).waitFor();
    await region.getByText("예정 → 진행 중", { exact: true }).waitFor();
    await region.getByText("과제를 만들었습니다", { exact: true }).waitFor();
    await region.getByText("명세 변경 제안 · 검토 기준 보강", { exact: true }).waitFor();
    assert.doesNotMatch(await region.innerText(), /in_progress|planned/u);
    await assertActivityTimes(region);
    await auditCanonCardFocus(page, region);
    await captureRegion(page, directory, name, [region]);
  } finally { await page.unroute(path); }
}
