// test-category: race
import { strict as assert } from "node:assert";
import type { Page } from "playwright";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import type { EpicDetail } from "../../packages/butler-app/client/shared/canon-contracts.ts";
import { inlineShot, assertFocused } from "./canon-inline-edit-flows.ts";
import { probeFocusRing } from "./focus-ring-clipping.ts";

const detail = (page: Page) => page.locator('[data-test-class="canon-epic-detail"]');
const title = (page: Page) => detail(page).getByRole("button", { name: "제목 수정", exact: true });
const input = (page: Page) => detail(page).getByLabel("제목", { exact: true });
const toggle = (page: Page) => page.locator('[data-test-class="session-info-toggle"]');
const dialog = (page: Page) => page.getByRole("alertdialog", { name: "변경 내용을 저장할까요?", exact: true });
const patch = (page: Page, id: string) => page.waitForResponse(response => response.request().method() === "PATCH"
  && new URL(response.url()).pathname === `/canon/epics/${id}`);

export async function verifyPaneExits(page: Page, server: NativeAppServerHandle, id: string, shots: string, otherId: string) {
  await verifyDialogFocus(page);
  for (const exit of ["close", "conversation"]) {
    for (const choice of ["계속 편집", "저장 안 함", "저장"]) {
      const before = (await server.api<EpicDetail>(`/canon/epics/${id}`)).title;
      await title(page).click(); await input(page).fill(`${before} 검토`);
      if (exit === "close") await toggle(page).click();
      else await page.locator(`[data-canon-epic="${otherId}"]`).getByRole("button").first().click();
      await dialog(page).waitFor();
      let streamed: import("playwright").Locator | undefined;
      if (exit === "close" && choice === "계속 편집" || exit === "conversation" && choice === "저장") {
        streamed = await streamWhileGuardOpen(page, server, id, `${exit}-${choice}`);
        if (exit === "close") await inlineShot(page, shots, "pane-unsaved-dialog");
      }
      const saved = choice === "저장" ? patch(page, id) : null;
      await dialog(page).getByRole("button", { name: choice, exact: true }).click();
      if (saved) assert((await saved).ok());
      if (choice === "계속 편집") {
        if (streamed) assert.equal(await streamed.count(), 1, "Keeping the draft retains streamed state");
        await assertFocused(input(page));
        assert.equal(await input(page).inputValue(), `${before} 검토`);
        assert.equal(await detail(page).getAttribute("data-epic-id"), id);
        await input(page).press("Escape");
      } else {
        if (exit === "close") { await detail(page).waitFor({ state: "hidden" }); await toggle(page).click(); }
        else {
          await page.locator(`[data-test-class="canon-epic-detail"][data-epic-id="${otherId}"]`).waitFor();
          await page.locator(`[data-canon-epic="${id}"]`).getByRole("button").first().click();
        }
        await page.locator(`[data-test-class="canon-epic-detail"][data-epic-id="${id}"]`).waitFor();
        if (streamed) await streamed.waitFor();
        assert.equal((await server.api<EpicDetail>(`/canon/epics/${id}`)).title, choice === "저장" ? `${before} 검토` : before);
      }
    }
  }
  await verifyLayoutAndGraph(page, shots);
}

async function verifyLayoutAndGraph(page: Page, shots: string) {
  await title(page).click(); await input(page).fill("문서 화면과 검색 흐름 검토");
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.waitForFunction(() => document.querySelector('[data-slot="conversation-aside"]')?.getAttribute("data-layout") === "floating");
  await dialog(page).getByRole("button", { name: "계속 편집", exact: true }).click();
  assert.equal(await input(page).inputValue(), "문서 화면과 검색 흐름 검토");
  await input(page).press("Tab");
  assert.deepEqual((await probeFocusRing(page))?.clips, []);
  await page.keyboard.press("Tab");
  assert.deepEqual((await probeFocusRing(page))?.clips, []);
  await inlineShot(page, shots, "floating-1024-editing");
  await page.setViewportSize({ width: 1440, height: 900 });
  await dialog(page).getByRole("button", { name: "계속 편집", exact: true }).click();
  await page.getByRole("button", { name: "작업 그래프", exact: true }).click();
  await dialog(page).getByRole("button", { name: "계속 편집", exact: true }).click();
  assert.equal(await page.getByRole("dialog", { name: "작업 그래프", exact: true }).count(), 0);
  assert.equal(await input(page).inputValue(), "문서 화면과 검색 흐름 검토");
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await dialog(page).getByRole("button", { name: "계속 편집", exact: true }).click();
  assert.equal(await input(page).inputValue(), "문서 화면과 검색 흐름 검토");
  await input(page).press("Escape");
}

export async function verifyInlineAttachment(page: Page, id: string) {
  await detail(page).getByRole("button", { name: "설명 편집", exact: true }).click();
  const textarea = detail(page).getByLabel("설명", { exact: true });
  const text = await textarea.inputValue();
  await verifyWindowBlur(page, textarea);
  await textarea.fill(`${text}\n\n`); await textarea.press("End");
  let release!: () => void;
  const uploading = new Promise<void>(done => { release = done; });
  const uploadPath = "**/projects/*/canon/files";
  await page.route(uploadPath, async route => {
    const response = await route.fetch();
    await uploading;
    await route.fulfill({ response });
  });
  const uploaded = page.waitForResponse(response => response.request().method() === "POST" && /\/canon\/files$/u.test(new URL(response.url()).pathname));
  await detail(page).getByLabel("파일 첨부", { exact: true }).setInputFiles({ name: "문서 검토.txt", mimeType: "text/plain", buffer: Buffer.from("검색 흐름과 문서 배치를 검토합니다.") });
  try { await detail(page).locator('[data-slot="attachment-item"][data-upload="uploading"]').waitFor(); }
  finally { release(); }
  const response = await uploaded; assert(response.ok());
  await page.unroute(uploadPath);
  await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="설명"]')?.value.includes("attachment:"));
  assert((await textarea.inputValue()).includes(text));
  const draft = await textarea.inputValue();
  const pill = detail(page).locator('[data-slot="attachment-item"]');
  assert.equal(await pill.count(), 1);
  await textarea.fill(text);
  assert.equal(await pill.count(), 0, "Deleting the draft link immediately removes its pill");
  await textarea.fill(draft);
  assert.equal(await pill.count(), 1);
  const saved = patch(page, id); await detail(page).getByRole("button", { name: "저장", exact: true }).click();
  assert((await saved).ok());
  const file = detail(page).locator('[data-test-class="canon-markdown"]').getByRole("link", { name: "문서 검토.txt", exact: true });
  await file.waitFor();
  assert.equal(await detail(page).locator('[data-slot="attachment-list"]').count(), 0, "Markdown already renders the attached file");
  await detail(page).getByRole("button", { name: "설명 편집", exact: true }).click();
  await textarea.fill(text);
  assert.equal(await pill.count(), 0, "Saved attachments also follow draft references");
  await textarea.press("Escape");
  const downloaded = await page.request.get(new URL((await file.getAttribute("href"))!, page.url()).href);
  assert(downloaded.ok());
  assert.equal(await downloaded.text(), "검색 흐름과 문서 배치를 검토합니다.");
}

export async function verifyEmptyDescription(page: Page, id: string) {
  const body = detail(page).getByRole("button", { name: "설명 편집", exact: true });
  await body.click();
  const textarea = detail(page).getByLabel("설명", { exact: true });
  const original = await textarea.inputValue();
  await textarea.fill("");
  const cleared = patch(page, id); await detail(page).getByRole("button", { name: "저장", exact: true }).click();
  assert((await cleared).ok());
  await detail(page).getByText("재현 방법, 기대 결과", { exact: true }).waitFor();
  await body.click(); assert.equal(await textarea.inputValue(), "");
  await textarea.fill(original);
  const restored = patch(page, id); await detail(page).getByRole("button", { name: "저장", exact: true }).click();
  assert((await restored).ok()); await body.waitFor();
}

async function verifyWindowBlur(page: Page, textarea: import("playwright").Locator) {
  // Headless single-process Chromium reports every page focused. Replay the OS
  // attention signal with a real DOM focusout, restoring the native method immediately.
  await textarea.evaluate(element => {
    const descriptor = Object.getOwnPropertyDescriptor(document, "hasFocus");
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
    try {
      window.dispatchEvent(new Event("blur"));
      element.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    } finally {
      if (descriptor) Object.defineProperty(document, "hasFocus", descriptor);
      else Reflect.deleteProperty(document, "hasFocus");
    }
  });
  assert.equal(await textarea.count(), 1, "A clean editor survives window blur");
  assert.equal(await dialog(page).count(), 0);
}

async function verifyDialogFocus(page: Page) {
  for (const field of ["제목", "설명"]) {
    const trigger = detail(page).getByRole("button", { name: field === "제목" ? "제목 수정" : "설명 편집", exact: true });
    const editor = detail(page).getByLabel(field, { exact: true });
    for (const choice of ["계속 편집", "저장 안 함", "저장"]) {
      await trigger.click(); await editor.fill(`${await editor.inputValue()} 검토`);
      await editor.evaluate(element => (element as HTMLElement).blur());
      await dialog(page).waitFor();
      const saved = choice === "저장" ? patch(page, (await detail(page).getAttribute("data-epic-id"))!) : null;
      await dialog(page).getByRole("button", { name: choice, exact: true }).click();
      if (saved) assert((await saved).ok());
      await assertFocused(choice === "계속 편집" ? editor : trigger);
      if (choice === "계속 편집") { await editor.press("Escape"); await assertFocused(trigger); }
    }
  }
}

async function streamWhileGuardOpen(page: Page, server: NativeAppServerHandle, epicId: string, suffix: string) {
  // Match openEpicConversation; the persisted UI state can lag behind navigation.
  const epic = await server.api<EpicDetail>(`/canon/epics/${epicId}`);
  assert(epic.home_session_id, "The open epic has a linked conversation");
  const view = await server.api<import("../../packages/butler-app/client/ui/src/app/types.ts").SessionView>(`/session-view?session_id=${epic.home_session_id}`);
  const message = { id: `guard-stream-${suffix}`, chat_id: view.session_id, role: "assistant" as const,
    text: suffix.startsWith("close") ? "검토 자료가 도착했습니다." : "검색 흐름 검토 결과가 도착했습니다.", created_at: new Date().toISOString(), cursor: 1 };
  await page.route("**/session-view?**", async route => {
    if (new URL(route.request().url()).searchParams.get("session_id") !== view.session_id) { await route.fallback(); return; }
    await route.fulfill({ json: { protocol_version: "butler.app.v1", data: { ...view, messages: [...view.messages, message] } } });
  });
  await page.evaluate(message => {
    const sources = (window as unknown as { __sessionInfoEventSources: EventSource[] }).__sessionInfoEventSources;
    sources.at(-1)!.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", payload: { message } }) }));
  }, message);
  const streamed = page.getByText(message.text, { exact: true });
  await streamed.waitFor();
  assert.equal(await dialog(page).count(), 1);
  return streamed;
}
