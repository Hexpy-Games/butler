import { closeCanonAside } from "./canon-board-aside.ts";
import { selectBoardPlan } from "./canon-board-selector.ts";
import { strict as assert } from "node:assert";
import type { Page } from "playwright";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import type { CanonOverview, EpicDetail, PlanDetail, CanonStatus } from "../../packages/butler-app/client/shared/canon-contracts.ts";
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
export async function seedCanonBoard(server: NativeAppServerHandle): Promise<{ projectId: string; planId: string; emptyPlanId: string; singlePlanId: string }> {
  const { project } = await server.api<{ project: { id: string } }>("/projects", post({ source: "scratch", display_name: "캐논 보드" }));
  const prefix = `/projects/${project.id}/canon`;
  const plan = await server.api<PlanDetail>(`${prefix}/plans`, post({ title: "프리뷰 14", due_on: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10) }));
  const titles = ["캐논", "작업 큐", "시각화 블록", "문서", "이미지 도구", "ChatGPT 공식 로그인", "크레이트 분리"];
  const statuses: CanonStatus[] = ["in_progress", "done", "in_review", "planned", "blocked", "planned", "done"];
  for (const [index, title] of titles.entries()) {
    const epic = await server.api<EpicDetail>(`${prefix}/epics`, post({ title, description: `${title}의 계획`, plan_id: plan.id, assignee: index === 0 ? "app-user" : null }));
    await server.api(`/canon/epics/${epic.id}`, { method: "PATCH", body: JSON.stringify({
      expected_revision: epic.revision, status: statuses[index],
    }) });
    if (index === 0) await server.api(`/canon/epics/${epic.id}/conversation`, post({}));
  }
  for (const title of ["단축키가 입력창과 충돌", "검색 결과 정렬"]) await server.api(`${prefix}/epics`, post({ title }));
  const canon = await server.api<CanonOverview>(prefix);
  assert.equal(canon.plans[0]!.works.length, 7); assert.equal(canon.backlog.length, 2);
  const longTitle = "아주 긴 과제 제목에서도 번호와 상태 표시와 담당자 아바타와 오른쪽 작업 메뉴가 서로 겹치지 않고 한 줄에 올바르게 정렬되는지 확인합니다";
  await server.api(`${prefix}/epics`, post({ title: longTitle, plan_id: plan.id, assignee: "app-user", description: "긴 제목 정렬 확인" }));
  const empty = await server.api<PlanDetail>(`${prefix}/plans`, post({ title: "빈 계획" }));
  const single = await server.api<PlanDetail>(`${prefix}/plans`, post({ title: "단일 과제 계획" }));
  await server.api(`${prefix}/epics`, post({ title: "단일 과제", plan_id: single.id, assignee: "app-user", description: "과제 하나" }));
  return { projectId: project.id, planId: plan.id, emptyPlanId: empty.id, singlePlanId: single.id };
}
export async function openCanonBoard(page: Page): Promise<void> {
  // The shared inspector is a modal drawer on phones; dismiss it before sidebar navigation.
  if (page.viewportSize()!.width === 390 && await page.locator('[data-test-class="right-panel-overlay-close"]').isVisible()) {
    await closeCanonAside(page);
  }
  const dashboard = page.getByRole("button", { name: "캐논 보드 프로젝트 대시보드", exact: true });
  await page.locator('[data-test-class~="mac-window"]').waitFor();
  await page.waitForFunction(() => document.documentElement.lang.startsWith("ko"));
  const showSidebar = page.getByRole("button", { name: "사이드바 보기", exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  await dashboard.click();
  await page.getByRole("tab", { name: "보드", exact: true }).click();
}
export async function waitToast(page: Page, text: string): Promise<void> {
  await page.locator('[data-sonner-toast]').filter({ hasText: text }).first().waitFor({ state: "visible" });
}
export async function verifyCanonFlows(page: Page, server: NativeAppServerHandle, projectId: string, planId: string): Promise<void> {
  const board = page.locator('[data-test-class="canon-board"]');
  await selectBoardPlan(page, "백로그");
  await board.locator('[data-canon-backlog]').getByRole("button", { name: "새 과제", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const create = dialog.getByRole("button", { name: "만들기", exact: true });
  assert(await create.isDisabled());
  await create.locator('..').hover();
  await page.getByRole("tooltip", { name: "제목을 입력하세요", exact: true }).waitFor();
  await dialog.getByLabel("제목", { exact: true }).fill("생성한 과제");
  assert(await create.isEnabled());
  await create.click(); await waitToast(page, "과제를 만들었습니다");
  const createdCard = board.locator('[data-canon-backlog] [data-kanban-item]').filter({ hasText: "생성한 과제" });
  await createdCard.waitFor(); assert.equal(await createdCard.locator('[role="button"]').getAttribute("data-selected"), "true");
  const detail = page.locator('[data-test-class="canon-epic-detail"]');
  await detail.getByText("생성한 과제", { exact: true }).waitFor();
  assert.equal(await detail.getByRole("button", { name: "대화 열기", exact: true }).count(), 0, "No conversation action without a home session");
  let canon = await server.api<CanonOverview>(`/projects/${projectId}/canon`);
  const created = canon.backlog.find(epic => epic.title === "생성한 과제")!; assert(created);
  const moved = page.waitForResponse(response => response.request().method() === "PATCH"
    && new URL(response.url()).pathname.endsWith(`/canon/epics/${encodeURIComponent(created.id)}`));
  await detail.getByRole("combobox", { name: "계획", exact: true }).selectOption(planId);
  assert((await moved).ok(), "Detail plan move request succeeded");
  await waitToast(page, "프리뷰 14에 넣었습니다");
  await selectBoardPlan(page, "프리뷰 14");
  await board.locator(`[data-kanban-item="${created.id}"]`).getByRole("button").click();
  await detail.getByText("생성한 과제", { exact: true }).waitFor();
  await detail.getByRole("combobox", { name: "상태", exact: true }).selectOption("in_review");
  await waitToast(page, "상태를 바꿨습니다");
  await board.locator(`[data-canon-lane="in_review"] [data-kanban-item="${created.id}"]`).waitFor();
  const saved = await server.api<EpicDetail>(`/canon/epics/${created.id}`);
  assert.equal(saved.plan_id, planId); assert.equal(saved.canon_status, "in_review");
  await verifyCanonConflict(page, server, created.id);
  await closeCanonAside(page);
  await board.getByRole("button", { name: "새 계획", exact: true }).click();
  await dialog.getByLabel("제목", { exact: true }).fill("다음 계획");
  await dialog.getByRole("button", { name: "만들기", exact: true }).click();
  await board.locator("section").getByText("다음 계획", { exact: true }).waitFor();
  canon = await server.api<CanonOverview>(`/projects/${projectId}/canon`);
  assert(canon.plans.some(plan => plan.title === "다음 계획"));
  const section = board.locator("section").filter({ has: page.getByText("다음 계획", { exact: true }) }).first();
  await section.getByRole("button", { name: "고치기", exact: true }).click();
  await dialog.getByLabel("제목", { exact: true }).fill("고친 계획");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await board.locator("section").getByText("고친 계획", { exact: true }).waitFor();
  canon = await server.api<CanonOverview>(`/projects/${projectId}/canon`);
  assert(canon.plans.some(plan => plan.title === "고친 계획"));
}
async function verifyCanonConflict(page: Page, server: NativeAppServerHandle, id: string): Promise<void> {
  const detail = page.locator('[data-test-class="canon-epic-detail"]');
  const current = await server.api<EpicDetail>(`/canon/epics/${id}`);
  await server.api(`/canon/epics/${id}`, { method: "PATCH", body: JSON.stringify({ expected_revision: current.revision, title: "실시간으로 고친 제목" }) });
  await detail.getByText("실시간으로 고친 제목", { exact: true }).waitFor();
  // The open edit retains its starting revision while canon.changed reloads the background.
  await detail.getByRole("button", { name: "제목 수정", exact: true }).click();
  const epic = await server.api<EpicDetail>(`/canon/epics/${id}`);
  await server.api(`/canon/epics/${id}`, { method: "PATCH", body: JSON.stringify({ expected_revision: epic.revision, title: "다른 사람이 쓴 제목" }) });
  await detail.getByLabel("제목", { exact: true }).fill("오래된 화면의 제목");
  const conflict = page.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/canon/epics/${id}`);
  await detail.getByRole("button", { name: "저장", exact: true }).click();
  assert.equal((await conflict).status(), 409);
  await waitToast(page, "다른 사람이 먼저 고쳤습니다");
  await detail.getByText("제목: 다른 사람이 쓴 제목", { exact: true }).waitFor();
  assert.equal(await detail.getByLabel("제목", { exact: true }).inputValue(), "오래된 화면의 제목");
  await detail.getByRole("button", { name: "취소", exact: true }).click();
  assert.equal((await server.api<EpicDetail>(`/canon/epics/${id}`)).title, "다른 사람이 쓴 제목");
}
