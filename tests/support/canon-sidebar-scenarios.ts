import { strict as assert } from "node:assert";
import type { Page } from "playwright";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import type { CanonOverview, CanonSidebar, CanonConversation, EpicDetail } from "../../packages/butler-app/client/shared/canon-contracts.ts";
import { seedCanonBoard, waitToast } from "./canon-board-scenarios.ts";
export async function seedCanonSidebar(server: NativeAppServerHandle) {
  const seed = await seedCanonBoard(server);
  const canon = await server.api<CanonOverview>(`/projects/${seed.projectId}/canon`);
  // Some rows are assigned only; others are linked but unassigned.
  const works = [...canon.plans[0]!.works, ...canon.backlog];
  for (const [index, epic] of works.entries()) {
    if (index % 2 === 0) await server.api(`/canon/epics/${epic.id}`, { method: "PATCH", body: JSON.stringify({ expected_revision: epic.revision, assignee: "app-user" }) });
    else await server.api(`/canon/epics/${epic.id}/conversation`, { method: "POST", body: "{}" });
  }
  return seed;
}
export async function showCanonSidebar(page: Page) {
  // The visibility checks below are instantaneous; wait until the chrome has rendered its sidebar toggle.
  await page.getByRole("button", { name: /^사이드바 (보기|숨기기)$/u }).first().waitFor();
  const show = page.getByRole("button", { name: "사이드바 보기", exact: true });
  if (await show.isVisible()) await show.click();
  const project = page.locator('[data-tree-item^="p:"] [data-test-class="tree-row"]').filter({ hasText: "캐논 보드" });
  if (await project.getAttribute("aria-expanded") === "false") await project.click();
  await page.locator('[data-canon-group]').first().waitFor();
}
export async function openPlan(page: Page, planId: string | null) {
  await showCanonSidebar(page);
  await page.locator(`[data-canon-group="${planId ?? "backlog"}"] [data-test-class="canon-sidebar-group"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "계획 개요", exact: true }).click();
  await page.locator('[data-test-class="canon-plan-overview"]').waitFor();
  // The row lives inside a drawer at phone widths; navigation closes it normally.
}
export async function showEpicInspector(page: Page) {
  const toggle = page.getByRole("button", { name: "세션 정보", exact: true });
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  const info = page.getByRole("complementary", { name: "세션 정보", exact: true });
  await info.locator('[data-test-class="canon-epic-detail"]').waitFor();
  assert.equal(await info.getByRole("button", { name: "대화 열기", exact: true }).count(), 0);
  await info.getByRole("progressbar", { name: "작업", exact: true }).waitFor();
  await info.getByRole("combobox", { name: "상태", exact: true }).waitFor();
}
export async function createFromSidebar(page: Page, projectId: string, planId: string): Promise<CanonConversation> {
  await showCanonSidebar(page);
  await page.locator(`[data-canon-group="${planId}"]`).getByRole("button", { name: "프리뷰 14에 새 과제", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const create = dialog.getByRole("button", { name: "만들기", exact: true });
  assert(await create.isDisabled());
  await create.locator("..").hover();
  await page.getByRole("tooltip", { name: "제목을 입력하세요", exact: true }).waitFor();
  await dialog.getByLabel("제목", { exact: true }).fill("사이드바에서 만든 과제");
  const linked = page.waitForResponse(response => response.request().method() === "POST" && /\/canon\/epics\/[^/]+\/conversation$/u.test(new URL(response.url()).pathname));
  await create.click();
  const response = await linked; assert(response.ok());
  const envelope = await response.json();
  const result: CanonConversation = envelope.data;
  assert.equal(result.work.project_id, projectId);
  await page.locator('[data-test-class="titlebar-title"]').filter({ hasText: "사이드바에서 만든 과제" }).waitFor();
  await showCanonSidebar(page);
  const row = page.locator(`[data-canon-group="${planId}"] [data-canon-epic="${result.work.id}"]`);
  await row.waitFor(); assert.equal(await row.getByRole("img", { name: "나", exact: true }).count(), 1);
  assert.equal(await page.locator(`[data-tree-item="s:${result.session_id}"]`).count(), 0, "Linked Epic is absent from the plain tree");
  await page.getByRole("radio", { name: "최신", exact: true }).click();
  await page.locator(`[data-tree-item="s:${result.session_id}"]`).waitFor();
  await page.getByRole("radio", { name: "전체보기", exact: true }).click();
  return result;
}
export async function verifySidebarOrder(page: Page, server: NativeAppServerHandle, projectId: string, planId: string) {
  const path = `/projects/${projectId}/canon`;
  const before = await server.api<CanonOverview>(path);
  await showCanonSidebar(page);
  const rows = page.locator(`[data-canon-group="${planId}"] [data-canon-epic]`);
  const ids = await rows.evaluateAll(rows => rows.map(row => row.getAttribute("data-canon-epic")!));
  const saved = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `${path}/sidebar-order`);
  const source = await rows.first().boundingBox(), target = await rows.nth(1).boundingBox();
  assert(source && target);
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height - 2, { steps: 12 });
  await page.mouse.move(target.x + target.width / 2, target.y + target.height - 1);
  await page.mouse.up();
  assert((await saved).ok()); await waitToast(page, "내 사이드바 순서만 바뀝니다");
  const sidebar = await server.api<CanonSidebar>(`${path}/sidebar`);
  const personal = sidebar.groups.find(group => group.key === planId)!.rows.map(row => row.id);
  assert.notDeepEqual(personal, ids);
  assert.deepEqual((await server.api<CanonOverview>(path)).plans[0]!.works.map(row => row.id), before.plans[0]!.works.map(row => row.id));
  await page.reload(); await showCanonSidebar(page);
  assert.deepEqual(await rows.evaluateAll(rows => rows.map(row => row.getAttribute("data-canon-epic")!)), personal);
  await openPlan(page, planId);
  const handle = page.locator('[data-test-class="canon-plan-epics"] [data-sortable-handle]').first();
  await handle.focus(); await page.keyboard.press("Space");
  await page.getByText(/^Dragging .+ Use arrow keys to move it\.$/u).waitFor();
  // dnd-kit's KeyboardSensor adds its keydown listener in a zero-delay timer after the lift; a timer
  // queued now runs after it, so the arrow key reaches the sensor instead of scrolling the page.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve)));
  await page.keyboard.press("ArrowDown");
  await page.locator('[data-test-class="canon-plan-epics"] [data-drop-target="true"]').waitFor();
  const ordered = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/canon/plans/${planId}/order`);
  await page.keyboard.press("Space");
  assert((await ordered).ok()); await waitToast(page, "과제 순서를 바꿨습니다");
  assert.notDeepEqual((await server.api<CanonOverview>(path)).plans[0]!.works.map(row => row.id), before.plans[0]!.works.map(row => row.id));
  await openPlan(page, null);
  const backlog = page.locator('[data-sortable-id]').first();
  const id = await backlog.getAttribute("data-sortable-id"); assert(id);
  await backlog.getByRole("button", { name: /메뉴$/u }).click();
  await page.getByRole("menuitem", { name: "계획 바꾸기", exact: true }).hover();
  const moved = page.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/canon/epics/${id}`);
  await page.getByRole("menuitem", { name: "프리뷰 14", exact: true }).click();
  assert((await moved).ok()); await waitToast(page, "프리뷰 14에 넣었습니다");
  assert.equal((await server.api<EpicDetail>(`/canon/epics/${id}`)).plan_id, planId);
  await showCanonSidebar(page);
  await page.locator(`[data-canon-group="${planId}"] [data-canon-epic="${id}"]`).waitFor();
}
export async function verifyInspectorConflict(page: Page, server: NativeAppServerHandle, epicId: string) {
  const detail = page.locator('[data-test-class="canon-epic-detail"]');
  await detail.getByRole("button", { name: "제목 수정", exact: true }).click();
  await detail.getByLabel("제목", { exact: true }).fill("오래된 편집");
  const old = await server.api<EpicDetail>(`/canon/epics/${epicId}`);
  await server.api(`/canon/epics/${epicId}`, { method: "PATCH", body: JSON.stringify({ expected_revision: old.revision, title: "서버에서 고친 과제" }) });
  const conflict = page.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/canon/epics/${epicId}`);
  await detail.getByRole("button", { name: "저장", exact: true }).click();
  assert.equal((await conflict).status(), 409); await waitToast(page, "다른 사람이 먼저 고쳤습니다");
  await detail.getByText("제목: 서버에서 고친 과제", { exact: true }).waitFor();
  assert.equal(await detail.getByLabel("제목", { exact: true }).inputValue(), "오래된 편집");
  await detail.getByRole("button", { name: "취소", exact: true }).click();
}

export async function verifyOverviewLayout(page: Page, width: number) {
  const rows = page.locator('[data-test-class="canon-plan-epics"] [data-sortable-id]');
  for (const row of await rows.all()) {
    const select = row.getByRole("combobox"), menu = row.getByRole("button", { name: /메뉴$/u });
    const selectBox = await select.boundingBox(), menuBox = await menu.boundingBox();
    assert(selectBox && menuBox);
    assert(Math.abs(selectBox.y - menuBox.y) < 2, "Status and menu share one line");
    const box = await row.boundingBox(); assert(box);
    assert(box.x >= 0 && box.x + box.width <= width + 1, "Overview row stays in viewport");
    assert(await row.getByRole("img", { name: "나", exact: true }).count() <= 1);
    const title = row.locator('[data-test-class="canon-epic-title"]');
    const titleBox = await title.boundingBox(); assert(titleBox);
    assert(width === 390 ? titleBox.y + titleBox.height <= selectBox.y : titleBox.x < selectBox.x,
      "Phone actions sit below title; desktop actions follow it");
    await verifyEpicLabel(row);
    assert(box.height < 145, "Rows remain compact");
  }
}
export async function verifySidebarLongPress(page: Page, planId: string) {
  const group = page.locator(`[data-canon-group="${planId}"]`);
  const header = group.locator('[data-test-class="canon-sidebar-group"]');
  await header.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true });
  await page.getByRole("menuitem", { name: "계획 개요", exact: true }).waitFor();
  assert.equal(await page.getByRole("menuitem").first().innerText(), "계획 개요");
  await header.dispatchEvent("pointerup", { pointerType: "touch", isPrimary: true });
  await page.keyboard.press("Escape");
  await page.getByRole("menu").waitFor({ state: "hidden" });
  const row = group.locator('[data-canon-epic]').filter({ has: page.getByRole("button", { name: /메뉴$/u }) }).first();
  await row.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true });
  await page.getByRole("menu").waitFor();
  assert.equal(await page.getByRole("menuitem", { name: "계획 개요", exact: true }).count(), 0, "Child long press opens only its own menu");
  await row.dispatchEvent("pointerup", { pointerType: "touch", isPrimary: true });
  await page.keyboard.press("Escape");
  await page.getByRole("menu").waitFor({ state: "hidden" });
}
export async function verifyEmptyEpicConversation(page: Page, server: NativeAppServerHandle, sessionId: string) {
  const view = await server.api<{ messages: unknown[] }>(`/session-view?session_id=${encodeURIComponent(sessionId)}`);
  assert.equal(view.messages.length, 0, "New Epic conversation has no system or user messages");
  const empty = page.locator('[data-test-class="new-chat-empty-state"]');
  await empty.getByRole("heading", { name: "사이드바에서 만든 과제", exact: true }).waitFor();
  await empty.getByText("프리뷰 14 · 과제", { exact: true }).waitFor();
  const bounds = await empty.boundingBox();
  const title = await empty.getByRole("heading").boundingBox();
  const caption = await empty.getByText("프리뷰 14 · 과제", { exact: true }).boundingBox();
  assert(bounds && title && caption);
  assert(Math.abs(title.x + title.width / 2 - bounds.x - bounds.width / 2) < 2, "Epic title is horizontally centered");
  assert(Math.abs((title.y + caption.y + caption.height) / 2 - bounds.y - bounds.height / 2) < 2, "Epic heading and caption are vertically centered");
  await page.getByRole("button", { name: "메시지 입력", exact: true }).getByText("이 과제에 대해 말해 보세요", { exact: true }).waitFor();
}

/** Verify the actual text and assigned Avatar, rather than the drag handle. */
export async function verifyEpicLabel(row: import("playwright").Locator) {
  const title = row.locator('[data-test-class="canon-epic-title"]');
  const text = await title.evaluate(element => {
    const style = getComputedStyle(element), box = element.getBoundingClientRect();
    return { ellipsis: style.textOverflow, overflow: style.overflow, width: box.width, contentWidth: element.scrollWidth };
  });
  assert.equal(text.ellipsis, "ellipsis"); assert.equal(text.overflow, "hidden");
  assert(text.width >= Math.min(40, text.contentWidth) - 1, "Title retains readable space");
  const avatar = row.getByRole("img", { name: "나", exact: true });
  if (await avatar.count()) {
    const box = await avatar.boundingBox(), bounds = await row.boundingBox();
    assert(box && bounds && box.width >= 16 && box.x >= bounds.x && box.x + box.width <= bounds.x + bounds.width,
      "Avatar stays full-size inside the row");
    const titleBox = await title.boundingBox();
    const gap = await title.evaluate(element => parseFloat(getComputedStyle(element).getPropertyValue("--space-sm")));
    assert(titleBox && Math.abs(box.x - titleBox.x - titleBox.width - gap) < 1,
      "Title and Avatar use the shared small spacing token");
  }
}
