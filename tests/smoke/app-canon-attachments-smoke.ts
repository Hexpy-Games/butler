import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser.ts";
import { openCanonBoard, seedCanonBoard, waitToast } from "../support/canon-board-scenarios.ts";
import { selectBoardPlan } from "../support/canon-board-selector.ts";
import { closeCanonAside } from "../support/canon-board-aside.ts";
import { probeFocusRing } from "../support/focus-ring-clipping.ts";
import type { EpicDetail } from "../../packages/butler-app/client/shared/canon-contracts.ts";

const cells = [1440, 390].flatMap(width => ["light", "dark"].map(theme => `${width}-${theme}`));
if (await runSmokeCases(cells, "BUTLER_ATTACHMENTS_CASE", import.meta.path, { isolate: true })) process.exit(0);
const cell = process.env.BUTLER_ATTACHMENTS_CASE!;
const [widthText, theme] = cell.split("-");
const before = process.env.BUTLER_SMOKE_BASELINE === "1";
const shots = process.env.BUTLER_SMOKE_SCREENSHOTS ?? "/tmp/butler-canon-attachments-screenshots";
mkdirSync(shots, { recursive: true });
const server = await createNativeAppServer({ uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist") });
let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
try {
  const { projectId, planId } = await seedCanonBoard(server);
  const epic = await server.api<EpicDetail>(`/projects/${projectId}/canon/epics`, { method: "POST", body: JSON.stringify({
    title: "첨부 파일 과제", description: "# 확인할 내용\n\n**설명**과 [문서](https://example.com).\n\n- 이미지 확인\n- 참고 파일 확인", plan_id: planId,
  }) });
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme }) });
  browser = await launchSmokeBrowser();
  const context = await browser.newContext({ viewport: { width: Number(widthText), height: widthText === "390" ? 844 : 1050 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  try {
    await server.signIn(context);
    await page.goto(server.url, { waitUntil: "load" });
    await openCanonBoard(page);
    await selectBoardPlan(page, "프리뷰 14");
    const board = page.locator('[data-test-class="canon-board"]');
    await board.locator(`[data-kanban-item="${epic.id}"]`).getByRole("button").first().click();
    const detail = page.locator('[data-test-class="canon-epic-detail"]');
    await detail.getByText("첨부 파일 과제", { exact: true }).waitFor();
    const capture = (view: string) => page.screenshot({ path: join(shots, `${before ? "before" : "after"}-${cell}-${view}.png`), animations: "disabled" });
    await capture("detail");
    await detail.getByRole("button", { name: "설명 편집", exact: true }).click();
    await detail.locator("textarea").waitFor();
    await capture("edit");
    if (!before) await attachmentRing(page, detail);
    await detail.getByRole("button", { name: "취소", exact: true }).click();
    await closeCanonAside(page);
    await selectBoardPlan(page, "백로그");
    await board.locator('[data-canon-backlog]').getByRole("button", { name: "새 과제", exact: true }).click();
    const create = page.getByRole("dialog");
    await create.getByLabel("제목", { exact: true }).waitFor();
    await capture("create");
    if (!before) await attachmentRing(page, create);
    await create.getByRole("button", { name: "취소", exact: true }).click();
    if (!before && cell === "1440-light") {
      await verifyFiles(page, server, projectId);
    }
    assert.equal(server.stubModelCalls.length, 0);
    console.log(JSON.stringify({ result: "PASS", phase: before ? "before" : "after", cell, screenshots: 3, flows: !before && cell === "1440-light" ? "AT-01,AT-02,AT-04,AT-05" : "visual" }));
  } finally { await context.close(); }
} finally { await browser?.close(); await server.stop(); }

async function verifyFiles(page: import("playwright").Page, server: Awaited<ReturnType<typeof createNativeAppServer>>, projectId: string) {
  const board = page.locator('[data-test-class="canon-board"]');
  await selectBoardPlan(page, "백로그");
  await board.locator('[data-canon-backlog]').getByRole("button", { name: "새 과제", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("제목", { exact: true }).fill("파일 업로드 확인");
  const description = dialog.locator("textarea");
  await description.fill("앞 뒤");
  await description.focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const picker = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "파일 첨부", exact: true }).click();
  await (await picker).setFiles({ name: "capture.png", mimeType: "image/png", buffer: png });
  await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("#canon-create-description")?.value.includes("attachment:file-"));
  const markdown = await description.inputValue();
  assert.match(markdown, /^앞 !\[capture.png\]\(attachment:file-[a-f0-9-]+\)뒤$/u);
  const remote: string[] = [];
  page.on("request", request => { if (request.url().includes("remote-image.invalid")) remote.push(request.url()); });
  await description.fill(`${markdown.replace("attachment:", "AtTaChMeNt:")}\n<script>globalThis.epicExecuted=true</script>\n<img src="https://remote-image.invalid/raw.png">\n![remote](https://remote-image.invalid/image.png)\n[bad](javascript:alert(1))`);
  await dialog.getByRole("button", { name: "만들기", exact: true }).click();
  await waitToast(page, "과제를 만들었습니다");
  const detail = page.locator('[data-test-class="canon-epic-detail"]');
  const image = detail.locator('[data-test-class="canon-markdown"] img');
  await image.waitFor();
  await page.waitForFunction(() => { const image = document.querySelector<HTMLImageElement>('[data-test-class="canon-markdown"] img'); return image?.complete && image.naturalWidth > 0; });
  assert.equal(await image.count(), 1); assert.equal(await detail.locator("script").count(), 0);
  assert.equal(await page.evaluate(() => (globalThis as { epicExecuted?: boolean }).epicExecuted), undefined);
  assert.deepEqual(remote, []);
  assert.equal(await detail.getByRole("link", { name: "bad", exact: true }).count(), 0);
  const id = await detail.getAttribute("data-epic-id"); assert(id);
  const epic = await server.api<EpicDetail>(`/canon/epics/${id}`);
  const file = epic.attachments?.[0]; assert(file);
  await detail.getByRole("button", { name: "설명 편집", exact: true }).click();
  const editDescription = detail.locator("textarea");
  await editDescription.focus();
  await page.keyboard.press("Control+Home");
  await detail.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Reference notes") });
  await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="설명"]')?.value.startsWith("[notes.txt](attachment:"));
  const saved = page.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/canon/epics/${id}`);
  await detail.getByRole("button", { name: "저장", exact: true }).click();
  assert((await saved).ok());
  const notes = detail.getByRole("link", { name: "notes.txt", exact: true });
  await notes.waitFor();
  const notesUrl = await notes.getAttribute("href"); assert(notesUrl);
  const notesFile = await fetch(new URL(notesUrl, server.url), { headers: server.authHeaders });
  assert.equal(notesFile.status, 200); assert.equal(await notesFile.text(), "Reference notes");
  await detail.getByRole("button", { name: "설명 편집", exact: true }).click();
  await detail.locator('input[type="file"]').setInputFiles({ name: "large.txt", mimeType: "text/plain", buffer: Buffer.alloc(11 * 1024 * 1024) });
  await waitToast(page, "10MB 이하만 첨부할 수 있습니다");
  await page.route("**/projects/*/canon/files", route => route.fulfill({ status: 413, contentType: "application/json", body: JSON.stringify({ error: { code: "file_too_large" } }) }));
  await detail.locator('input[type="file"]').setInputFiles({ name: "small.txt", mimeType: "text/plain", buffer: Buffer.from("small") });
  await waitToast(page, "10MB 이하만 첨부할 수 있습니다");
  await page.unroute("**/projects/*/canon/files");
  const excess = Array.from({ length: 21 }, (_, index) => `[file](attachment:file-00000000-0000-4000-8000-${String(index).padStart(12, "0")})`).join("\n");
  await detail.locator("textarea").fill(excess);
  await detail.getByRole("button", { name: "저장", exact: true }).click();
  await waitToast(page, "파일은 20개까지 첨부할 수 있습니다");

  await detail.locator("textarea").fill("참고 파일을 뺐습니다");
  let releaseSave: () => void = () => {};
  const saving = new Promise<void>(resolve => { releaseSave = resolve; });
  const epicRoute = `**/canon/epics/${id}`;
  await page.route(epicRoute, async route => {
    if (route.request().method() === "PATCH") await saving;
    await route.continue();
  });
  try {
    await detail.getByRole("button", { name: "저장", exact: true }).click();
    const attach = detail.getByRole("button", { name: "파일 첨부", exact: true });
    assert(await attach.isDisabled());
    await attach.hover();
    await page.getByRole("tooltip").filter({ hasText: "저장 중" }).waitFor();
  } finally { releaseSave(); }

  await detail.getByText("참고 파일을 뺐습니다", { exact: true }).waitFor();
  await page.unroute(epicRoute);
  await fileRemoved(server, file.url);
  await fileRemoved(server, notesUrl);
  assert.equal(projectId, epic.project_id);
}

async function attachmentRing(page: import("playwright").Page, form: import("playwright").Locator) {
  await page.keyboard.press("Tab");
  await form.getByRole("button", { name: "파일 첨부", exact: true }).focus();
  const ring = await probeFocusRing(page);
  assert(ring, "The upload button must have a keyboard focus ring");
  assert.deepEqual(ring.clips, []);
}

// Match the authenticated E2E check: an unsigned browser file URL can return
// 404 before cleanup. Wait for the owner-visible row to disappear instead.
async function fileRemoved(server: Awaited<ReturnType<typeof createNativeAppServer>>, url: string) {
  const deadline = performance.now() + 30_000;
  let status = 0;
  do {
    const response = await fetch(new URL(url, server.url), { headers: server.authHeaders });
    status = response.status;
    await response.body?.cancel();
    if (status === 404) return;
    assert.equal(status, 200);
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (performance.now() < deadline);
  assert.equal(status, 404, "The file must be removed after its last reference");
}
