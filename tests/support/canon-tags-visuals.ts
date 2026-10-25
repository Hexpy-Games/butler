// test-category: race
import { strict as assert } from "node:assert";
import { join } from "node:path";
import type { Page } from "playwright";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import type { CanonTag, EpicDetail } from "../../packages/butler-app/client/shared/canon-contracts.ts";
import { selectBoardPlan } from "./canon-board-selector.ts";
import { closeCanonAside } from "./canon-board-aside.ts";
import { assertNoChipControls, chooseTag } from "./canon-tags-flows.ts";
export const tones = ["gray", "red", "orange", "yellow", "green", "teal", "blue", "purple"] as const;
const names = ["회색", "빨강", "주황", "노랑", "초록", "청록", "파랑", "보라"];
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
export async function seedTagPalette(server: NativeAppServerHandle, projectId: string, planId: string) {
  const tags: CanonTag[] = [];
  for (const [index, color] of tones.entries()) {
    const tag = await server.api<CanonTag>(`/projects/${projectId}/canon/tags`, post({ name: names[index], color }));
    tags.push(tag);
    for (const plan_id of [null, planId]) await server.api(`/projects/${projectId}/canon/epics`, post({ title: `${names[index]} 과제`, plan_id, tags: [tag.id] }));
  }
  const palette = await server.api<EpicDetail>(`/projects/${projectId}/canon/epics`, post({ title: "모든 색 태그", plan_id: planId, tags: tags.map(tag => tag.id) }));
  return { tags, palette };
}
export async function captureTagViews(page: Page, shots: string, name: string, tags: CanonTag[], palette: EpicDetail, before: boolean) {
  const capture = (view: string) => page.screenshot({ path: join(shots, `${name}-${view}.png`), animations: "disabled" });
  const board = page.locator('[data-test-class="canon-board"]');
  const card = board.locator(`[data-kanban-item="${palette.id}"]`);
  await selectBoardPlan(page, "프리뷰 14");
  await card.waitFor();
  if (!before) {
    assert.equal(await card.locator('[data-test-class="canon-tags"] [data-size="sm"]').count(), 4);
    await card.getByText("+5", { exact: true }).waitFor();
    assert.equal(await card.locator("svg").count(), 0, "Tags add no status icon to idle cards");
    assert.equal(await board.locator('[data-test-class="canon-tags"] [data-editable="true"]').count(), 0, "Board cards show no tag pencil");
    // Every tone is also shown uncapped, on its own card.
    for (const tone of tones) assert(await board.locator(`[data-test-class="canon-tags"] [data-tone="${tone}"]`).count() > 0);
  }
  await capture("cards");
  for (const tag of tags) {
    await board.locator('[data-kanban-item]').filter({ hasText: `${tag.name} 과제` }).scrollIntoViewIfNeeded();
    await capture(`card-${tag.color}`);
  }
  await card.getByRole("button").first().click();
  const detail = page.locator('[data-test-class="canon-epic-detail"]');
  await detail.waitFor();
  await captureInspectorTags(page, tags, before, capture);
  await closeCanonAside(page);
  await board.getByRole("button", { name: "새 과제", exact: true }).first().click();
  await page.getByRole("dialog").getByLabel("제목", { exact: true }).fill("태그가 있는 과제");
  if (!before) {
    for (const tag of tags) await chooseTag(page, tag.name);
    assert.equal(await page.getByRole("dialog").locator('[data-test-class="canon-tags-field"] [data-removable="true"][data-tone]').count(), 8);
  }
  await capture("dialog");
  await page.getByRole("dialog").getByRole("button", { name: "취소", exact: true }).click();
  if (!before) await board.getByRole("combobox", { name: "태그 필터", exact: true }).click();
  else await board.getByRole("button", { name: "계획", exact: true }).click();
  await capture("filter");
  await page.keyboard.press("Escape");
}

async function captureInspectorTags(page: Page, tags: CanonTag[], before: boolean, capture: (view: string) => Promise<unknown>) {
  const detail = page.locator('[data-test-class="canon-epic-detail"]');
  if (!before) {
    for (const tone of tones) assert.equal(await detail.locator(`[data-test-class="canon-tags"] [data-tone="${tone}"]`).count(), 1);
    await assertNoChipControls(page);
  }
  await capture("inspector");
  if (before) await detail.getByRole("button", { name: "고치기", exact: true }).click();
  await detail.getByRole("combobox", { name: "태그", exact: true }).click();
  const popover = page.locator('[data-slot="filtered-select-popover"]');
  await popover.getByRole("textbox", { name: "태그 검색", exact: true }).waitFor();
  if (!before) {
    assert.equal(await popover.locator('[data-slot="filtered-select-item"]').count(), tags.length, "All tags are available");
    await popover.locator('[data-slot="filtered-select-item"]').last().scrollIntoViewIfNeeded();
  }
  await capture("inspector-open");
  const row = popover.locator('[data-slot="filtered-select-item"]').filter({ hasText: tags[1]!.name });
  await row.hover();
  await capture("picker-hover");
  await page.mouse.move(0, 0);
  await popover.getByRole("textbox", { name: "태그 검색", exact: true }).focus();
  for (let step = 0; step < 4 && !await page.evaluate(() => Boolean(document.activeElement?.closest('[data-slot="filtered-select-item"], [data-slot="filtered-select-row"]'))); step++) await page.keyboard.press("Tab");
  await capture("picker-focus");
  await popover.getByRole("button", { name: `${tags[1]!.name} 태그 메뉴`, exact: true }).click();
  await page.getByRole("menuitem", { name: "색 바꾸기", exact: true }).waitFor();
  await capture("picker-menu");
  await page.keyboard.press("Escape");
  await page.getByRole("menu").waitFor({ state: "hidden" });
  await page.keyboard.press("Escape");
  await popover.waitFor({ state: "hidden" });
  if (!before) {
    await detail.getByRole("button", { name: "제목 수정", exact: true }).click();
    assert.equal(await detail.locator('[data-canon-inline-editor] [data-test-class="canon-tags-field"]').count(), 0, "Inline editor keeps the immediate-save tag row outside the draft");
    await capture("inspector-edit");
    await detail.getByRole("button", { name: "취소", exact: true }).click();
  }
}
