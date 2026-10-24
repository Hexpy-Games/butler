// test-category: race
import { strict as assert } from "node:assert";
import { join } from "node:path";
import type { Page } from "playwright";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import type { CanonTag, EpicDetail } from "../../packages/butler-app/client/shared/canon-contracts.ts";
import { selectBoardPlan } from "./canon-board-selector.ts";
import { closeCanonInspector } from "./canon-board-inspector.ts";
import { chooseTag } from "./canon-tags-flows.ts";
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
    const plan = await board.getByRole("button", { name: "계획", exact: true }).boundingBox();
    const filter = await board.getByRole("combobox", { name: "태그 필터", exact: true }).boundingBox();
    assert(plan && filter && Math.abs(plan.y - filter.y) < 4 && filter.x >= plan.x + plan.width,
      "Tag filter is beside the plan selector");
  }
  if (!before) {
    assert.equal(await card.locator('[data-test-class="canon-tags"] [data-size="sm"]').count(), 4);
    await card.getByText("+5", { exact: true }).waitFor();
    assert.equal(await card.locator("svg").count(), 0, "Tags add no status icon to idle cards");
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
  if (!before) for (const tone of tones) assert.equal(await detail.locator(`[data-test-class="canon-tags"] [data-tone="${tone}"]`).count(), 1);
  await capture("inspector");
  await detail.getByRole("button", { name: "고치기", exact: true }).click();
  await capture("inspector-edit");
  await closeCanonInspector(page);
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
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "No viewport overflow");
}
