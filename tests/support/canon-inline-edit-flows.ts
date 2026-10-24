// test-category: race
import { strict as assert } from "node:assert";
import { join } from "node:path";
import type { Page } from "playwright";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import type { EpicDetail } from "../../packages/butler-app/client/shared/canon-contracts.ts";
import { probeFocusRing } from "./focus-ring-clipping.ts";
import { waitToast } from "./canon-board-scenarios.ts";
import { canonInspectorClose } from "./canon-board-inspector.ts";

const detail = (page: Page) => page.locator('[data-test-class="canon-epic-detail"]');
const title = (page: Page) => detail(page).getByRole("button", { name: "제목 수정", exact: true });
const input = (page: Page) => detail(page).getByLabel("제목", { exact: true });
const patch = (page: Page, id: string) => page.waitForResponse(response => response.request().method() === "PATCH"
  && new URL(response.url()).pathname === `/canon/epics/${id}`);
const read = (server: NativeAppServerHandle, id: string) => server.api<EpicDetail>(`/canon/epics/${id}`);
const shot = (page: Page, dir: string, name: string) => page.screenshot({ path: join(dir, `${name}.png`) });

async function ring(page: Page) {
  const probe = await probeFocusRing(page);
  assert(probe && !probe.noIndicator, "Keyboard focus has a visible ring");
  assert.deepEqual(probe.clips, [], "Inline edit focus ring fits its ancestors");
}

export async function verifyInlineFields(page: Page, server: NativeAppServerHandle, id: string, shots: string) {
  await title(page).hover();
  await page.getByRole("tooltip", { name: "제목 수정", exact: true }).waitFor();
  assert.equal(await title(page).locator("svg").count(), 1);
  assert.equal(await title(page).evaluate(element => getComputedStyle(element).cursor), "pointer");
  await shot(page, shots, "final-title-hover");
  await title(page).focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
  await ring(page); await page.keyboard.press("Space");
  await input(page).fill("문서 정리"); await shot(page, shots, "final-title-editing");
  await page.keyboard.press("Tab"); await ring(page);
  await page.keyboard.press("Tab"); await ring(page);
  await input(page).focus();
  const saved = patch(page, id); await input(page).press("Enter"); assert((await saved).ok());
  await waitToast(page, "저장했습니다"); assert.equal((await read(server, id)).title, "문서 정리");
  await title(page).click(); await input(page).fill("취소할 제목"); await input(page).press("Escape");
  assert.equal((await read(server, id)).title, "문서 정리");
  const body = detail(page).getByRole("button", { name: "본문 편집", exact: true });
  await body.hover(); await page.getByRole("tooltip", { name: "본문 편집", exact: true }).waitFor();
  await shot(page, shots, "final-desc-hover");
  await body.focus(); await page.keyboard.press("Enter");
  const textarea = detail(page).getByLabel("설명", { exact: true });
  const before = await read(server, id);
  let writes = 0;
  const countWrite = (request: import("playwright").Request) => { if (request.method() === "PATCH") writes++; };
  page.on("request", countWrite);
  await textarea.fill("첫 줄"); await textarea.press("Enter"); await textarea.pressSequentially("둘째 줄");
  assert.equal(await textarea.inputValue(), "첫 줄\n둘째 줄"); assert.equal(writes, 0);
  assert.equal((await read(server, id)).revision, before.revision);
  await shot(page, shots, "final-desc-editing");
  const bodySaved = patch(page, id); await detail(page).getByRole("button", { name: "저장", exact: true }).click();
  assert((await bodySaved).ok()); page.off("request", countWrite);
  await detail(page).getByText("첫 줄\n둘째 줄", { exact: true }).waitFor();
  assert.equal((await read(server, id)).description, "첫 줄\n둘째 줄");
  await shot(page, shots, "final-saved");
  await verifyConflict(page, server, id, shots);
}

async function verifyConflict(page: Page, server: NativeAppServerHandle, id: string, shots: string) {
  await title(page).click(); await input(page).fill("내 초안");
  const before = await read(server, id);
  await server.api(`/canon/epics/${id}`, { method: "PATCH", body: JSON.stringify({ expected_revision: before.revision, title: "다른 사람 제목" }) });
  const conflict = patch(page, id); await input(page).press("Enter");
  assert.equal((await conflict).status(), 409); await waitToast(page, "다른 사람이 먼저 고쳤습니다");
  await detail(page).getByText("제목: 다른 사람 제목", { exact: true }).waitFor();
  assert.equal(await input(page).inputValue(), "내 초안");
  await shot(page, shots, "final-conflict");
  const saved = patch(page, id); await input(page).press("Enter"); assert((await saved).ok());
  await title(page).waitFor(); assert.equal((await read(server, id)).title, "내 초안");
}

export async function verifyInlineExits(page: Page, server: NativeAppServerHandle, id: string, shots: string) {
  const other = page.locator('[data-kanban-item]').filter({ hasText: "ChatGPT 공식 로그인" }).getByRole("button").first();
  for (const choice of ["계속 편집", "저장 안 함", "저장"]) {
    await title(page).click(); await input(page).fill(`전환 ${choice}`);
    await other.click();
    const dialog = page.getByRole("dialog", { name: "변경 내용을 저장할까요?", exact: true });
    await dialog.waitFor();
    if (choice === "계속 편집") await shot(page, shots, "final-unsaved-dialog");
    const saved = choice === "저장" ? patch(page, id) : null;
    await dialog.getByRole("button", { name: choice, exact: true }).click();
    if (saved) assert((await saved).ok());
    if (choice === "계속 편집") {
      assert.equal(await detail(page).getAttribute("data-epic-id"), id);
      assert.equal(await input(page).inputValue(), `전환 ${choice}`);
      await input(page).press("Escape");
    } else {
      await detail(page).getByRole("heading", { name: "ChatGPT 공식 로그인", exact: true }).waitFor();
      assert.equal((await read(server, id)).title, choice === "저장" ? `전환 ${choice}` : "내 초안");
      await page.locator(`[data-kanban-item="${id}"]`).getByRole("button").first().click();
      await title(page).waitFor();
    }
  }
  await detail(page).getByRole("button", { name: "본문 편집", exact: true }).click();
  const textarea = detail(page).getByLabel("설명", { exact: true });
  await textarea.fill("설명 초안");
  await textarea.press("Tab"); await ring(page);
  await page.keyboard.press("Tab"); await ring(page);
  await page.keyboard.press("Tab");
  await page.getByRole("dialog").getByRole("button", { name: "계속 편집", exact: true }).click();
  assert.equal(await textarea.inputValue(), "설명 초안");
  await textarea.press("Escape");
  assert.equal((await read(server, id)).description, "첫 줄\n둘째 줄");
  await verifyCloseAndNavigation(page, id);
}

async function verifyCloseAndNavigation(page: Page, id: string) {
  await title(page).click(); await input(page).fill("닫기 초안");
  await canonInspectorClose(page).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "계속 편집", exact: true }).click();
  assert.equal(await input(page).inputValue(), "닫기 초안");
  await input(page).press("Tab"); await page.keyboard.press("Tab"); await page.keyboard.press("Tab");
  await dialog.getByRole("button", { name: "계속 편집", exact: true }).click();
  assert.equal(await input(page).inputValue(), "닫기 초안");
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await dialog.getByRole("button", { name: "계속 편집", exact: true }).click();
  assert.equal(await input(page).inputValue(), "닫기 초안");
  await canonInspectorClose(page).click();
  await dialog.getByRole("button", { name: "저장 안 함", exact: true }).click();
  await detail(page).waitFor({ state: "hidden" });
  await page.locator(`[data-kanban-item="${id}"]`).getByRole("button").first().click();
  await title(page).click(); // Unchanged drafts leave without a dialog.
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await detail(page).waitFor({ state: "hidden" });
  assert.equal(await dialog.count(), 0);
}
