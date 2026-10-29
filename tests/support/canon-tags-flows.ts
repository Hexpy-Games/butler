// test-category: race
import { strict as assert } from "node:assert";
import type { Page } from "playwright";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import type { CanonOverview, CanonTag, EpicDetail } from "../../packages/butler-app/client/shared/canon-contracts.ts";
import { closeCanonAside } from "./canon-board-aside.ts";
import { selectBoardPlan } from "./canon-board-selector.ts";
const boardSelector = '[data-test-class="canon-board"]';
const detailSelector = '[data-test-class="canon-epic-detail"]';
const fieldSelector = '[data-test-class="canon-tags-field"]';
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
export async function tagRequest(page: Page, method: string, path: string, trigger: () => Promise<unknown>, status = 200) {
  const response = page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname === path);
  await trigger();
  const completed = await response;
  assert.equal(completed.status(), status, `${method} ${path}`);
  return completed;
}
/** Management stays on a picker row, including tags attached to no epic. */
export async function pickerMenu(page: Page, name: string) {
  await page.locator(fieldSelector).getByRole("combobox", { name: "태그", exact: true }).click();
  const popover = page.locator('[data-slot="filtered-select-popover"]');
  await popover.getByRole("textbox", { name: "태그 검색", exact: true }).fill(name);
  await popover.getByRole("button", { name: `${name} 태그 메뉴`, exact: true }).click();
}
export async function assertNoChipControls(page: Page) {
  const field = page.locator(fieldSelector);
  await field.getByRole("combobox", { name: "태그", exact: true }).waitFor();
  assert.equal(await field.locator('[data-editable="true"], [data-removable="true"]').count(), 0);
  assert.equal(await field.locator('button[aria-label$=" 태그 메뉴"]').count(), 0);
  assert.equal(await field.getByRole("combobox", { name: "태그", exact: true }).count(), 1);
}
export async function chooseTag(page: Page, name: string) {
  await page.locator(fieldSelector).getByRole("combobox", { name: "태그", exact: true }).click();
  const popover = page.locator('[data-slot="filtered-select-popover"]');
  await popover.getByRole("textbox", { name: "태그 검색", exact: true }).fill(name);
  await popover.getByRole("button", { name, exact: true }).click();
  await page.keyboard.press("Escape");
}
async function openEpic(page: Page, title: string) {
  await page.locator(boardSelector).locator('[data-kanban-item]').filter({ hasText: title }).getByRole("button").first().click();
}
async function createTaggedEpic(page: Page, server: NativeAppServerHandle, projectId: string) {
  await page.locator(boardSelector).getByRole("button", { name: "새 과제", exact: true }).first().click();
  const dialog = page.getByRole("dialog").first();
  await dialog.getByLabel("제목", { exact: true }).fill("태그 생성 과제");
  await dialog.getByRole("combobox", { name: "태그", exact: true }).click();
  const popover = page.locator('[data-slot="filtered-select-popover"]');
  await popover.getByRole("textbox", { name: "태그 검색", exact: true }).fill("새 태그");
  const response = await tagRequest(page, "POST", `/projects/${projectId}/canon/tags`,
    () => popover.getByRole("button", { name: "‘새 태그’ 만들기", exact: true }).click(), 201);
  const tag = (await response.json()).data as CanonTag;
  const colors = page.getByRole("dialog", { name: "색 바꾸기", exact: true });
  assert.equal(await colors.getByRole("radio", { name: "파랑", exact: true }).getAttribute("aria-checked"), "true");
  await colors.getByRole("radio", { name: "파랑", exact: true }).click();
  await tagRequest(page, "PATCH", `/canon/tags/${tag.id}`, () => colors.getByRole("button", { name: "저장", exact: true }).click());
  assert.equal((await server.api<CanonOverview>(`/projects/${projectId}/canon`)).backlog.some(epic => epic.title === "태그 생성 과제"), false,
    "Saving a tag color never submits the enclosing epic form");
  const created = await tagRequest(page, "POST", `/projects/${projectId}/canon/epics`,
    () => dialog.getByRole("button", { name: "만들기", exact: true }).click(), 201);
  const epic = (await created.json()).data as EpicDetail;
  assert.deepEqual(epic.tags.map(tag => [tag.name, tag.color]), [["새 태그", "blue"]]);
  await page.locator(boardSelector).locator(`[data-kanban-item="${epic.id}"] [data-test-class="canon-tags"]`).getByText("새 태그", { exact: true }).waitFor();
  await closeCanonAside(page);
  return epic;
}
async function assignmentFlow(page: Page, server: NativeAppServerHandle, epic: EpicDetail, tag: CanonTag) {
  await openEpic(page, epic.title);
  const response = await tagRequest(page, "PATCH", `/canon/epics/${epic.id}`, () => chooseTag(page, tag.name));
  assert.equal(response.request().postDataJSON().expected_revision, epic.revision);
  let saved = await server.api<EpicDetail>(`/canon/epics/${epic.id}`);
  assert(saved.revision > epic.revision);
  assert(saved.tags.some(item => item.id === tag.id));
  await page.locator(detailSelector).locator('[data-test-class="canon-tags"]').getByText(tag.name, { exact: true }).waitFor();
  await page.locator(boardSelector).locator(`[data-kanban-item="${epic.id}"]`).getByText(tag.name, { exact: true }).waitFor();
  await assertNoChipControls(page);
  await tagRequest(page, "PATCH", `/canon/epics/${epic.id}`, () => chooseTag(page, tag.name));
  const revision = saved.revision;
  saved = await server.api<EpicDetail>(`/canon/epics/${epic.id}`);
  assert(saved.revision > revision); assert(!saved.tags.some(item => item.id === tag.id));
  await page.locator(boardSelector).locator(`[data-kanban-item="${epic.id}"]`).getByText(tag.name, { exact: true }).waitFor({ state: "hidden" });
  await closeCanonAside(page);
}
async function manageFlow(page: Page, server: NativeAppServerHandle, epic: EpicDetail) {
  await openEpic(page, epic.title);
  const tag = (await server.api<EpicDetail>(`/canon/epics/${epic.id}`)).tags.find(tag => tag.name === "새 태그")!;
  await assertNoChipControls(page);
  await pickerMenu(page, "새 태그");
  await page.getByRole("menuitem", { name: "이름 바꾸기", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "이름 바꾸기", exact: true });
  await dialog.getByLabel("태그 이름", { exact: true }).fill("고친 태그");
  await tagRequest(page, "PATCH", `/canon/tags/${tag.id}`, () => dialog.getByRole("button", { name: "저장", exact: true }).click());
  await pickerMenu(page, "고친 태그");
  await page.getByRole("menuitem", { name: "색 바꾸기", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "색 바꾸기", exact: true });
  await dialog.getByRole("radio", { name: "청록", exact: true }).click();
  await tagRequest(page, "PATCH", `/canon/tags/${tag.id}`, () => dialog.getByRole("button", { name: "저장", exact: true }).click());
  const saved = await server.api<EpicDetail>(`/canon/epics/${epic.id}`);
  assert(saved.tags.some(tag => tag.name === "고친 태그" && tag.color === "teal"));
  await page.locator(boardSelector).locator(`[data-kanban-item="${epic.id}"] [data-tone="teal"]`).getByText("고친 태그", { exact: true }).waitFor();
  await closeCanonAside(page);
}
const actionsOpacity = (row: ReturnType<Page["locator"]>) =>
  row.locator('[data-slot="filtered-select-item-actions"]').evaluate(element => getComputedStyle(element).opacity);
/** A tag on no 과제 is managed from its picker row: the pencil shows on hover, keyboard focus and while its menu is open. */
async function unattachedFlow(page: Page, server: NativeAppServerHandle, projectId: string) {
  const loose = await server.api<CanonTag>(`/projects/${projectId}/canon/tags`, post({ name: "외톨이", color: "orange" }));
  const epic = await server.api<EpicDetail>(`/projects/${projectId}/canon/epics`, post({ title: "태그 없는 과제" }));
  await page.locator(boardSelector).locator(`[data-kanban-item="${epic.id}"]`).waitFor();
  await openEpic(page, epic.title);
  const popover = page.locator('[data-slot="filtered-select-popover"]');
  const openPicker = async (name: string) => {
    await page.locator(fieldSelector).getByRole("combobox", { name: "태그", exact: true }).click();
    await popover.getByRole("textbox", { name: "태그 검색", exact: true }).fill(name);
    return popover.locator('[data-slot="filtered-select-row"]').filter({ hasText: name });
  };
  let row = await openPicker("외톨이");
  assert.equal(await actionsOpacity(row), "0", "Row actions rest hidden");
  await row.hover();
  assert.equal(await actionsOpacity(row), "1", "Row hover shows the pencil");
  await row.getByRole("button", { name: "외톨이 태그 메뉴", exact: true }).click();
  await page.mouse.move(0, 0);
  assert.equal(await actionsOpacity(row), "1", "The pencil stays while its menu is open");
  await page.getByRole("menuitem", { name: "이름 바꾸기", exact: true }).click();
  const rename = page.getByRole("dialog", { name: "이름 바꾸기", exact: true });
  await rename.getByLabel("태그 이름", { exact: true }).fill("외톨이 고침");
  await tagRequest(page, "PATCH", `/canon/tags/${loose.id}`, () => rename.getByRole("button", { name: "저장", exact: true }).click());
  assert((await server.api<CanonTag[]>(`/projects/${projectId}/canon/tags`)).some(tag => tag.id === loose.id && tag.name === "외톨이 고침"));
  assert(!(await server.api<EpicDetail>(`/canon/epics/${epic.id}`)).tags.some(tag => tag.id === loose.id), "Managing a tag never attaches it");
  row = await openPicker("외톨이 고침");
  await page.mouse.move(0, 0);
  for (let step = 0; step < 4 && !await page.evaluate(() => Boolean(document.activeElement?.closest('[data-slot="filtered-select-row"]'))); step++) await page.keyboard.press("Tab");
  assert.equal(await actionsOpacity(row), "1", "Keyboard focus in the row shows the pencil");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "외톨이 고침 태그 메뉴", "The pencil follows the row in keyboard order");
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "삭제", exact: true }).click();
  const remove = page.getByRole("dialog", { name: "‘외톨이 고침’ 태그를 지울까요?", exact: true });
  await tagRequest(page, "DELETE", `/canon/tags/${loose.id}`, () => remove.getByRole("button", { name: "삭제", exact: true }).click());
  assert(!(await server.api<CanonTag[]>(`/projects/${projectId}/canon/tags`)).some(tag => tag.id === loose.id));
  await closeCanonAside(page);
}
async function duplicateFlow(page: Page, server: NativeAppServerHandle, projectId: string) {
  await page.locator(boardSelector).getByRole("button", { name: "새 과제", exact: true }).first().click();
  const dialog = page.getByRole("dialog").first();
  await dialog.getByLabel("제목", { exact: true }).fill("중복 태그 과제");
  const bug = await server.api<CanonTag>(`/projects/${projectId}/canon/tags`, post({ name: "bug", color: "red" }));
  await dialog.getByRole("combobox", { name: "태그", exact: true }).click();
  const popover = page.locator('[data-slot="filtered-select-popover"]');
  await popover.getByRole("textbox", { name: "태그 검색", exact: true }).fill("Bug");
  const response = await tagRequest(page, "POST", `/projects/${projectId}/canon/tags`,
    () => popover.getByRole("button", { name: "‘Bug’ 만들기", exact: true }).click(), 409);
  assert.equal((await response.json()).error.code, "tag_exists");
  // The existing tag is selected as it is; no color edit opens for it.
  await dialog.locator(fieldSelector).getByText("bug", { exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog", { name: "색 바꾸기", exact: true }).count(), 0);
  const created = await tagRequest(page, "POST", `/projects/${projectId}/canon/epics`,
    () => dialog.getByRole("button", { name: "만들기", exact: true }).click(), 201);
  assert.deepEqual((await created.json()).data.tags.map((tag: CanonTag) => tag.id), [bug.id]);
  assert.equal((await server.api<CanonTag[]>(`/projects/${projectId}/canon/tags`)).filter(tag => tag.name.toLowerCase() === "bug").length, 1);
  await closeCanonAside(page);
}
async function deleteFlow(page: Page, server: NativeAppServerHandle, projectId: string) {
  const tag = await server.api<CanonTag>(`/projects/${projectId}/canon/tags`, post({ name: "공유 태그", color: "purple" }));
  const epics: EpicDetail[] = [];
  for (let index = 0; index < 3; index++) epics.push(await server.api<EpicDetail>(`/projects/${projectId}/canon/epics`, post({ title: `공유 ${index}`, tags: [tag.id] })));
  await page.locator(boardSelector).locator(`[data-kanban-item="${epics[0]!.id}"]`).waitFor();
  await openEpic(page, "공유 0");
  await pickerMenu(page, "공유 태그");
  await page.getByRole("menuitem", { name: "삭제", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "‘공유 태그’ 태그를 지울까요?", exact: true });
  await dialog.getByText("과제 3개에서 빠집니다", { exact: true }).waitFor();
  await tagRequest(page, "DELETE", `/canon/tags/${tag.id}`, () => dialog.getByRole("button", { name: "삭제", exact: true }).click());
  for (const epic of epics) {
    const saved = await server.api<EpicDetail>(`/canon/epics/${epic.id}`);
    assert.equal(saved.tags.length, 0); assert.equal(saved.revision, epic.revision);
    await page.locator(boardSelector).locator(`[data-kanban-item="${epic.id}"]`).getByText("공유 태그", { exact: true }).waitFor({ state: "hidden" });
  }
  await closeCanonAside(page);
}
async function filterFlow(page: Page, server: NativeAppServerHandle, projectId: string, tags: CanonTag[], planTitle: string) {
  const canon = await server.api<CanonOverview>(`/projects/${projectId}/canon`);
  for (const title of ["백로그", planTitle, "빈 계획"]) {
    await selectBoardPlan(page, title);
    const all = title === "백로그" ? canon.backlog : canon.plans.find(plan => plan.title === title)!.works;
    const board = page.locator(boardSelector);
    await board.getByRole("combobox", { name: "태그 필터", exact: true }).click();
    const popover = page.locator('[data-slot="filtered-select-popover"]');
    await popover.getByRole("button", { name: tags[0]!.name, exact: true }).waitFor();
    assert.equal(await popover.locator('[data-slot="filtered-select-item-actions"]').count(), 0, "The board filter has no tag management");
    for (const tag of tags.slice(0, 2)) await popover.getByRole("button", { name: tag.name, exact: true }).click();
    await page.keyboard.press("Escape");
    const expected = all.filter(epic => epic.tags.some(tag => tags.slice(0, 2).some(selected => selected.id === tag.id)));
    assert.deepEqual((await board.locator('[data-kanban-item]').evaluateAll(elements => elements.map(element => element.getAttribute("data-kanban-item")))).sort(), expected.map(epic => epic.id).sort());
    await board.getByRole("combobox", { name: "태그 필터", exact: true }).click();
    await popover.getByRole("button", { name: "모두 지우기", exact: true }).click();
    await page.keyboard.press("Escape");
    assert.equal(await board.locator('[data-kanban-item]').count(), all.length);
  }
  await selectBoardPlan(page, "백로그");
}
async function conflictFlow(page: Page, server: NativeAppServerHandle, epic: EpicDetail, tag: CanonTag) {
  for (const deleted of [false, true]) {
    await openEpic(page, epic.title);
    const path = `/canon/epics/${epic.id}`;
    // Pause the real PATCH after its revision was captured, then introduce a competing write.
    await page.route(`**${path}`, async route => {
      if (route.request().method() !== "PATCH") { await route.continue(); return; }
      if (deleted) await server.api(`/canon/tags/${tag.id}`, { method: "DELETE" });
      else {
        const latest = await server.api<EpicDetail>(path);
        await server.api(path, { method: "PATCH", body: JSON.stringify({ expected_revision: latest.revision, description: "다른 편집" }) });
      }
      await route.continue();
    });
    await tagRequest(page, "PATCH", path, () => chooseTag(page, tag.name), 409);
    await page.unroute(`**${path}`);
    await page.getByText("다른 사람이 먼저 고쳤습니다", { exact: true }).first().waitFor();
    await page.locator(detailSelector).getByText("다른 편집", { exact: true }).waitFor();
    assert(!(await server.api<EpicDetail>(path)).tags.some(item => item.id === tag.id));
    await closeCanonAside(page);
  }
}
export async function verifyTagFlows(page: Page, server: NativeAppServerHandle, projectId: string, tags: CanonTag[]) {
  await selectBoardPlan(page, "백로그");
  const epic = await createTaggedEpic(page, server, projectId);
  await assignmentFlow(page, server, epic, tags[0]!);
  await manageFlow(page, server, epic);
  await unattachedFlow(page, server, projectId);
  await duplicateFlow(page, server, projectId);
  await deleteFlow(page, server, projectId);
  await filterFlow(page, server, projectId, tags, "프리뷰 14");
  const conflictTag = await server.api<CanonTag>(`/projects/${projectId}/canon/tags`, post({ name: "충돌 태그", color: "teal" }));
  await conflictFlow(page, server, epic, conflictTag);
}
