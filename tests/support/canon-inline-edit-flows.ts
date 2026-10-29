// test-category: race
import { strict as assert } from "node:assert";
import { join } from "node:path";
import type { Page, Locator } from "playwright";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import type { EpicDetail } from "../../packages/butler-app/client/shared/canon-contracts.ts";
import { probeFocusRing } from "./focus-ring-clipping.ts";
import { waitToast } from "./canon-board-scenarios.ts";
import { canonAsideClose } from "./canon-board-aside.ts";

const detail = (page: Page) => page.locator('[data-test-class="canon-epic-detail"]');
const title = (page: Page) => detail(page).getByRole("button", { name: "제목 수정", exact: true });
const input = (page: Page) => detail(page).getByLabel("제목", { exact: true });
const patch = (page: Page, id: string) => page.waitForResponse(response => response.request().method() === "PATCH"
  && new URL(response.url()).pathname === `/canon/epics/${id}`);
const read = (server: NativeAppServerHandle, id: string) => server.api<EpicDetail>(`/canon/epics/${id}`);
export async function assertFocused(target: Locator) {
  await target.page().waitForFunction(element => document.activeElement === element, await target.elementHandle());
  assert(await target.evaluate(element => document.activeElement === element));
}

export async function inlineShot(page: Page, dir: string, name: string) {
  if (name === "pane-saved") {
    await waitToast(page, "저장했습니다");
    await page.waitForFunction(() => [...document.querySelectorAll("[data-sonner-toast]")]
      .every(element => getComputedStyle(element).opacity === "1"));
  }
  else await page.waitForFunction(() => document.querySelectorAll("[data-sonner-toast]").length === 0);
  if (!name.endsWith("-hover")) {
    await page.mouse.move(5, 895); // Park the pointer so no hover tooltip overlaps the capture.
    await page.waitForFunction(() => document.querySelectorAll('[role="tooltip"]:not([data-slot="resize-hint"])').length === 0).catch(async error => {
      const open = await page.evaluate(() => [...document.querySelectorAll('[role="tooltip"]:not([data-slot="resize-hint"])')].map(tip => tip.textContent));
      throw new Error(`${name}: tooltip still open ${JSON.stringify(open)} (focus: ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 160))})`, { cause: error });
    });
  }
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

const editedTitle = "문서 화면 정리와 검색 개선안";
export const description = "문서 목록과 검색 흐름을 정리합니다.\n\n- 제목과 최근 수정일 표시\n- **검색 결과**에서 본문 확인\n- 선택한 문서의 태그 정리\n\n[검토 자료](https://example.com/guide)를 참고합니다.";

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
  await inlineShot(page, shots, "pane-title-hover");
  await title(page).focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
  await ring(page); await page.keyboard.press("Space");
  await input(page).fill("문서 화면 정리와 검색 개선"); await inlineShot(page, shots, "pane-title-editing");
  await page.keyboard.press("Tab"); await ring(page);
  await page.keyboard.press("Tab"); await ring(page);
  await input(page).focus();
  const saved = patch(page, id); await input(page).press("Enter"); assert((await saved).ok());
  await title(page).waitFor(); await assertFocused(title(page)); assert.equal((await read(server, id)).title, "문서 화면 정리와 검색 개선");
  await title(page).click(); await input(page).fill("취소할 제목"); await input(page).press("Escape");
  await assertFocused(title(page));
  await title(page).click(); await detail(page).getByRole("button", { name: "취소", exact: true }).click();
  await assertFocused(title(page));
  assert.equal((await read(server, id)).title, "문서 화면 정리와 검색 개선");
  const body = detail(page).getByRole("button", { name: "설명 편집", exact: true });
  await detail(page).getByRole("group", { name: "설명 편집", exact: true }).hover(); await page.getByRole("tooltip", { name: "설명 편집", exact: true }).waitFor();
  await inlineShot(page, shots, "pane-desc-hover");
  await body.focus(); await page.keyboard.press("Enter");
  const textarea = detail(page).getByLabel("설명", { exact: true });
  const before = await read(server, id);
  let writes = 0;
  const countWrite = (request: import("playwright").Request) => { if (request.method() === "PATCH") writes++; };
  page.on("request", countWrite);
  await textarea.fill("문서 목록을 검토합니다.\n검색 흐름을 확인합니다.\n수정 내용을 정리합니다.");
  const initialHeight = (await textarea.boundingBox())!.height;
  await textarea.press("End");
  for (let line = 0; line < 5; line++) { await textarea.press("Enter"); await textarea.pressSequentially("추가 설명"); }
  const grownHeight = (await textarea.boundingBox())!.height;
  assert(grownHeight > initialHeight, `Description grows after five lines: ${initialHeight} → ${grownHeight}`);
  console.log(JSON.stringify({ descriptionInitialHeight: initialHeight, descriptionGrownHeight: grownHeight }));
  await inlineShot(page, shots, "desc-editing-autogrow");
  await textarea.fill(description.split("\n")[0]!); await textarea.press("Enter"); await textarea.pressSequentially(description.split("\n").slice(1).join("\n"));
  assert.equal(await textarea.inputValue(), description); assert.equal(writes, 0);
  assert.equal((await read(server, id)).revision, before.revision);
  await inlineShot(page, shots, "pane-desc-editing");
  const bodySaved = patch(page, id); await detail(page).getByRole("button", { name: "저장", exact: true }).click();
  assert((await bodySaved).ok()); page.off("request", countWrite);
  await detail(page).locator("[data-test-class=canon-markdown] li").nth(2).waitFor();
  assert.equal(await detail(page).locator("[data-test-class=canon-markdown] li").count(), 3);
  assert.equal(await detail(page).locator("strong").innerText(), "검색 결과");
  assert.equal((await read(server, id)).description, description);
  await inlineShot(page, shots, "pane-saved");
  await assertFocused(body);
  await inlineShot(page, shots, "pane-desc-markdown");
  await detail(page).getByRole("group", { name: "설명 편집", exact: true }).hover();
  await inlineShot(page, shots, "pane-desc-hover");
  await body.click(); await textarea.press("Escape"); await assertFocused(body);
  await body.click(); await detail(page).getByRole("button", { name: "취소", exact: true }).click(); await assertFocused(body);
  await verifyMarkdownLink(page);
  await verifyConflict(page, server, id, shots);
}

async function verifyMarkdownLink(page: Page) {
  const link = detail(page).getByRole("link", { name: "검토 자료", exact: true });
  await link.focus(); await assertFocused(link);
  assert.equal(await link.evaluate(element => element.closest('[role="button"]')), null);
  assert.equal(await link.getAttribute("target"), "_blank");
  assert.equal(await link.getAttribute("href"), "https://example.com/guide");
  // Observe the real click without navigating the smoke to an external network.
  await page.evaluate(() => {
    const observe = (event: MouseEvent) => {
      const anchor = (event.target as HTMLElement).closest("a");
      if (anchor?.href !== "https://example.com/guide") return;
      document.documentElement.setAttribute("data-link-default-prevented", String(event.defaultPrevented));
      event.preventDefault();
      document.removeEventListener("click", observe, true);
    };
    document.documentElement.removeAttribute("data-link-default-prevented");
    document.addEventListener("click", observe, true);
  });
  await link.click();
  assert.equal(await page.locator("html").getAttribute("data-link-default-prevented"), "false");
  assert.equal(await detail(page).getByLabel("설명", { exact: true }).count(), 0);
}

async function verifyConflict(page: Page, server: NativeAppServerHandle, id: string, shots: string) {
  await title(page).click(); await input(page).fill(editedTitle);
  const before = await read(server, id);
  await server.api(`/canon/epics/${id}`, { method: "PATCH", body: JSON.stringify({ expected_revision: before.revision, title: "문서 화면 정리와 분류 개선" }) });
  const conflict = patch(page, id); await input(page).press("Enter");
  assert.equal((await conflict).status(), 409);
  await detail(page).getByText("제목: 문서 화면 정리와 분류 개선", { exact: true }).waitFor();
  assert.equal(await input(page).inputValue(), editedTitle);
  await inlineShot(page, shots, "pane-conflict");
  const saved = patch(page, id); await input(page).press("Enter"); assert((await saved).ok());
  await title(page).waitFor(); await assertFocused(title(page)); assert.equal((await read(server, id)).title, editedTitle);
}

export async function verifyInlineExits(page: Page, server: NativeAppServerHandle, id: string, shots: string) {
  const other = page.locator('[data-kanban-item]').filter({ hasText: "ChatGPT 공식 로그인" }).getByRole("button").first();
  for (const choice of ["계속 편집", "저장 안 함", "저장"]) {
    await title(page).click(); await input(page).fill(editedTitle + " 작업");
    await other.click();
    const dialog = page.getByRole("alertdialog", { name: "변경 내용을 저장할까요?", exact: true });
    await dialog.waitFor();
    await dialog.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
    const bounds = await dialog.boundingBox();
    assert(bounds);
    assert(Math.abs(bounds.x + bounds.width / 2 - page.viewportSize()!.width / 2) < 2);
    assert(Math.abs(bounds.y + bounds.height / 2 - 450) < 2);
    await page.locator('[data-slot="dialog-overlay"]').waitFor({ state: "visible" });
    if (choice === "계속 편집") await inlineShot(page, shots, "pane-unsaved-dialog");
    const saved = choice === "저장" ? patch(page, id) : null;
    await dialog.getByRole("button", { name: choice, exact: true }).click();
    if (saved) assert((await saved).ok());
    if (choice === "계속 편집") {
      assert.equal(await detail(page).getAttribute("data-epic-id"), id);
      assert.equal(await input(page).inputValue(), editedTitle + " 작업");
      await input(page).press("Escape");
    } else {
      await detail(page).getByRole("heading", { name: "ChatGPT 공식 로그인", exact: true }).waitFor();
      assert.equal((await read(server, id)).title, choice === "저장" ? editedTitle + " 작업" : editedTitle);
      await page.locator(`[data-kanban-item="${id}"]`).getByRole("button").first().click();
      await title(page).waitFor();
    }
  }
  await detail(page).getByRole("button", { name: "설명 편집", exact: true }).click();
  const textarea = detail(page).getByLabel("설명", { exact: true });
  await textarea.fill("설명 초안");
  await textarea.press("Tab"); await ring(page);
  await page.keyboard.press("Tab"); await ring(page);
  for (let stop = 0; stop < 5 && !await page.getByRole("alertdialog").isVisible(); stop++) await page.keyboard.press("Tab");
  await page.getByRole("alertdialog").getByRole("button", { name: "계속 편집", exact: true }).click();
  assert.equal(await textarea.inputValue(), "설명 초안");
  await textarea.press("Escape");
  assert.equal((await read(server, id)).description, description);
  await verifyCloseAndNavigation(page, id);
}

async function verifyCloseAndNavigation(page: Page, id: string) {
  await title(page).click(); await input(page).fill("닫기 초안");
  await canonAsideClose(page).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "계속 편집", exact: true }).click();
  assert.equal(await input(page).inputValue(), "닫기 초안");
  await input(page).press("Tab"); await page.keyboard.press("Tab"); await page.keyboard.press("Tab");
  await dialog.getByRole("button", { name: "계속 편집", exact: true }).click();
  assert.equal(await input(page).inputValue(), "닫기 초안");
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await dialog.getByRole("button", { name: "계속 편집", exact: true }).click();
  assert.equal(await input(page).inputValue(), "닫기 초안");
  await canonAsideClose(page).click();
  await dialog.getByRole("button", { name: "저장 안 함", exact: true }).click();
  await detail(page).waitFor({ state: "hidden" });
  await page.locator(`[data-kanban-item="${id}"]`).getByRole("button").first().click();
  await title(page).click(); // Unchanged drafts leave without a dialog.
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await detail(page).waitFor({ state: "hidden" });
  assert.equal(await dialog.count(), 0);
}
