// test-category: race
import { verifyDelayedInlineSave } from "./session-inline-edit.ts";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import { strict as assert } from "node:assert";
import type { Locator, Page } from "playwright";

export async function verifyTaskOrder(detail: Locator) {
  const fields = [
    detail.getByRole("button", { name: "제목 수정", exact: true }),
    detail.getByText("진행 중 · 프리뷰 14", { exact: true }),
    detail.getByRole("group", { name: "설명 편집", exact: true }),
    detail.getByRole("combobox", { name: "상태", exact: true }),
    detail.getByText("담당", { exact: true }),
    detail.getByRole("combobox", { name: "계획", exact: true }),
    detail.getByText("태그", { exact: true }),
    detail.getByRole("progressbar", { name: "작업", exact: true }),
    detail.getByText("릴리스 노트 검토", { exact: true }),
    detail.getByText("명세", { exact: true }),
  ];
  for (const field of fields) await field.waitFor();
  for (let index = 1; index < fields.length; index++) {
    const next = await fields[index]!.elementHandle();
    assert(await fields[index - 1]!.evaluate((node, next) => Boolean(node.compareDocumentPosition(next!) & Node.DOCUMENT_POSITION_FOLLOWING), next),
      `Task detail order at ${index}`);
  }
  assert.equal(await detail.getByText("아직 작업이 없습니다", { exact: true }).count(), 0);
}

export async function verifyCompactContext(context: Locator, capture: (name: string) => Promise<unknown>) {
  assert.equal(await context.locator("[data-context-group]").count(), 5);
  assert.equal(await context.locator("[data-context-item]").count(), 0);
  await capture("context-rows");
  await context.getByRole("button", { name: "자세히", exact: true }).click();
  await context.locator("[data-context-item]").last().waitFor();
  assert.equal(await context.locator("[data-context-item]").count(), 10);
  const ids = await context.locator("[data-context-group]").evaluateAll(groups => groups.map(group => ({
    id: group.getAttribute("data-context-group"), items: [...group.querySelectorAll("[data-context-item]")].map(item => item.getAttribute("data-context-item")),
  })));
  assert.deepEqual(ids, [
    { id: "conversation", items: ["working", "current-input"] },
    { id: "memory", items: ["retrieved", "references"] },
    { id: "rules", items: ["live-config"] },
    { id: "base", items: ["static", "runtime-state"] },
    { id: "reserve", items: ["output-reserve", "tool-reserve", "compaction-reserve"] },
  ]);
  assert.deepEqual(await context.locator("*").evaluateAll(nodes => nodes.filter(node => {
    const css = getComputedStyle(node);
    return node.scrollHeight > node.clientHeight && /auto|scroll/u.test(css.overflowY);
  }).map(node => node.outerHTML.slice(0, 200))), [], "Context flows with the pane scroll");
  await context.evaluate(node => node.scrollIntoView({ block: "start" }));
  await capture("context-expanded");
  await context.getByRole("button", { name: "간단히", exact: true }).click();
  await context.locator("[data-context-item]").first().waitFor({ state: "detached" });
  assert.equal(await context.locator("[data-context-group]").count(), 5);
}

export async function verifyDashboardTask(page: Page, epicId: string, capture: (name: string) => Promise<unknown>, server: NativeAppServerHandle) {
  await page.getByRole("button", { name: "버틀러 앱 프로젝트 대시보드", exact: true }).click();
  await page.getByRole("tab", { name: "보드", exact: true }).click();
  await page.locator(`[data-kanban-item="${epicId}"]`).getByRole("button").first().click();
  const aside = page.locator('[data-slot="management-page-aside"]');
  await verifyTaskOrder(aside.locator('[data-test-class="canon-epic-detail"]'));
  assert.equal(await aside.getByRole("button", { name: "대화 열기", exact: true }).count(), 1);
  await capture("dashboard-task-order");
  await verifyDelayedInlineSave(page, server, epicId, "description");
  console.log("PASS dashboard inline delayed save + deferred focusout (session-info smoke)");
  await aside.getByRole("button", { name: "대화 열기", exact: true }).click();
  await page.getByRole("complementary", { name: "세션 정보", exact: true }).waitFor();
}
