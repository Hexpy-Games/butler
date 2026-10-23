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
  const show = page.getByRole("button", { name: "사이드바 보기", exact: true });
  if (await show.isVisible()) await show.click();
  const project = page.locator('[data-tree-item^="p:"] [data-test-class="tree-row"]').first();
  if (await project.getAttribute("aria-expanded") === "false") await project.click();
  await page.locator('[data-canon-group]').first().waitFor();
}
export async function openPlan(page: Page, planId: string | null) {
  await showCanonSidebar(page);
  await page.locator(`[data-canon-group="${planId ?? "backlog"}"] [data-test-class="canon-sidebar-group"]`).getByRole("button", { name: planId ? "프리뷰 14" : "백로그", exact: true }).click();
  await page.locator('[data-test-class="canon-plan-overview"]').waitFor();
  // The row lives inside a drawer at phone widths; navigation closes it normally.
}
export async function showEpicInspector(page: Page) {
  const inspector = page.locator('[data-test-class~="right-inspector"]');
  const tab = inspector.getByRole("button", { name: "과제", exact: true });
  if (!await tab.isVisible()) {
    const show = page.getByRole("button", { name: "오른쪽 패널 보기", exact: true });
    await show.click();
  }
  await tab.waitFor();
  assert.equal(await inspector.getByRole("button").first().innerText(), "과제");
  await tab.click();
  await page.locator('[data-test-class="canon-epic-detail"]').waitFor();
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
  assert.equal(result.work.scope_ref, projectId);
  await page.locator('[data-test-class="titlebar-title"]').filter({ hasText: "사이드바에서 만든 과제" }).waitFor();
  await showCanonSidebar(page);
  const row = page.locator(`[data-canon-group="${planId}"] [data-canon-epic="${result.work.id}"]`);
  await row.waitFor(); assert.equal(await row.getByRole("img", { name: "나", exact: true }).count(), 1);
  assert.equal(await page.locator(`[data-tree-item="s:${result.session_id}"]`).count(), 0, "Linked Epic is absent from the plain tree");
  await page.getByRole("tab", { name: "최신", exact: true }).click();
  await page.locator(`[data-tree-item="s:${result.session_id}"]`).waitFor();
  await page.getByRole("tab", { name: "전체보기", exact: true }).click();
  return result;
}
export async function verifySidebarOrder(page: Page, server: NativeAppServerHandle, projectId: string, planId: string) {
  const path = `/projects/${projectId}/canon`;
  const before = await server.api<CanonOverview>(path);
  await showCanonSidebar(page);
  const rows = page.locator(`[data-canon-group="${planId}"] [data-canon-epic]`);
  const ids = await rows.evaluateAll(rows => rows.map(row => row.getAttribute("data-canon-epic")!));
  const saved = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `${path}/sidebar-order`);
  const box = await rows.nth(1).boundingBox(); assert(box);
  await rows.first().dragTo(rows.nth(1), { targetPosition: { x: box.width / 2, y: box.height - 2 } });
  assert((await saved).ok()); await waitToast(page, "내 사이드바 순서만 바뀝니다");
  const sidebar = await server.api<CanonSidebar>(`${path}/sidebar`);
  const personal = sidebar.groups.find(group => group.key === planId)!.rows.map(row => row.id);
  assert.notDeepEqual(personal, ids);
  assert.deepEqual((await server.api<CanonOverview>(path)).plans[0]!.works.map(row => row.id), before.plans[0]!.works.map(row => row.id));
  await page.reload(); await showCanonSidebar(page);
  assert.deepEqual(await rows.evaluateAll(rows => rows.map(row => row.getAttribute("data-canon-epic")!)), personal);
  await openPlan(page, planId);
  const handle = page.locator('[data-test-class="canon-plan-epics"] [data-sortable-handle]').first();
  const ordered = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/canon/plans/${planId}/order`);
  await handle.focus(); await handle.press("Space"); await handle.press("ArrowDown"); await handle.press("Space");
  assert((await ordered).ok()); await waitToast(page, "과제 순서를 바꿨습니다");
  assert.notDeepEqual((await server.api<CanonOverview>(path)).plans[0]!.works.map(row => row.id), before.plans[0]!.works.map(row => row.id));
  await openPlan(page, null);
  const backlog = page.locator('[data-sortable-id]').first();
  const id = await backlog.getAttribute("data-sortable-id"); assert(id);
  await backlog.getByRole("button", { name: /메뉴/u }).click();
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
  await detail.getByRole("button", { name: "고치기", exact: true }).click();
  await detail.getByLabel("제목", { exact: true }).fill("오래된 편집");
  const old = await server.api<EpicDetail>(`/canon/epics/${epicId}`);
  await server.api(`/canon/epics/${epicId}`, { method: "PATCH", body: JSON.stringify({ expected_revision: old.revision, title: "서버에서 고친 과제" }) });
  const conflict = page.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/canon/epics/${epicId}`);
  await detail.getByRole("button", { name: "저장", exact: true }).click();
  assert.equal((await conflict).status(), 409); await waitToast(page, "다른 사람이 먼저 고쳤습니다");
  await detail.getByText("서버에서 고친 과제", { exact: true }).waitFor();
}
