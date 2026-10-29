// UI behavior smoke: offline gateway fixtures, real Lexical editor and product screens.
import { assertDocumentOverflow, assertDocumentLayout, measureDocumentLayout, checkDocumentImage, checkTrailing, checkTitleLine, clickDocumentAction, checkDocumentMenu, measureHeader, documentHarnessPlugin } from "./document-page-checks";
import assert from "node:assert/strict";
import { getAppCopy } from "../../packages/butler-i18n/src/index";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { createServer } from "../../packages/butler-app/client/ui/node_modules/vite/dist/node/index.js";
import { launchSmokeBrowser } from "../support/smoke-browser";
import { documentProfilePlugin } from "../support/document-profile";
const layouts: { width: number; theme: string; background: string; state: string; layout: Awaited<ReturnType<typeof measureDocumentLayout>> }[] = [];
const root = process.cwd(), stage = process.env.BUTLER_DOCUMENT_STAGE ?? "after";
const evidence = process.env.BUTLER_SMOKE_EVIDENCE ?? resolve(process.env.TMPDIR ?? "/tmp", "bd8/shots"); mkdirSync(evidence, { recursive: true });
const image = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 300 200"><rect width="300" height="200" fill="#8ca5ab"/><circle cx="210" cy="65" r="26" fill="#efd79c"/><path d="M0 200V150L90 60L220 200M120 200L220 110L300 180V200" fill="#55766d"/></svg>');
const imageData = `data:image/svg+xml;base64,${image.toString("base64")}`;
const spec = { v: 2, blocks: [{ type: "metrics", title: "Budget", items: [{ label: "Total", value: 120 }] }] };
const initial = `# Report\n\nAn **important** paragraph with *emphasis*.\n\n- first\n- second\n\n1. one\n2. two\n\n\`\`\`blocks\n${JSON.stringify(spec)}\n\`\`\`\n\n![image](img_abcdefghij)\n\n> Preserve unknown Markdown\n`;
const artifact = { id: "doc_report", title: "Report", kind: "doc", session_id: "butler-client", message_id: "answer", created_at: "2026-10-25T08:00:00Z", deliverable: true };
const message = { id: "answer", cursor: 1, chat_id: "butler-client", role: "assistant", status: "delivered", text: "Here is your report.", created_at: artifact.created_at, artifacts: [artifact] };
let head = { id: artifact.id, title: "Report", body: initial, rev: 1, author: "butler", chat_id: "butler-client", message_id: "answer", created_at: artifact.created_at, updated_at: artifact.created_at,
  assets: [{ id: "img_abcdefghij", url: "/message-assets/img_abcdefghij", signed_url: "/message-assets/img_abcdefghij?expires=9999999999&signature=fixture", image_width: 600, image_height: 400 }] };
let history = [structuredClone(head)], conflict = false, projectImageSize = true;
const projected = (doc: typeof head) => projectImageSize ? doc : { ...doc, assets: doc.assets.map(({ image_width, image_height, ...asset }) => asset) };
const puts: Record<string, unknown>[] = [], restores: Record<string, unknown>[] = [], exports: Record<string, string>[] = [], queries: string[] = [], errors: string[] = [];
const file = { file_id: "mf_abcdefghij", safe_name: "report.md", size_bytes: 16, mime_type: "text/markdown", kind: "text", url: "/message-files/mf_abcdefghij", created_at: artifact.created_at };
const fileItem = { id: "file-report", kind: "document", title: "File report", session: "butler-client", url: file.url, file, capturedAt: artifact.created_at,
  revisions: [{ file, capturedAt: artifact.created_at }, { file: { ...file, file_id: "mf_klmnopqrst", url: "/message-files/mf_klmnopqrst" }, capturedAt: "2026-10-24T08:00:00Z" }] };
const scrap = { id: "saved-metrics", kind: "scrap", title: "Saved budget", url: "", block: spec, capturedAt: artifact.created_at };
const baselineRef = process.env.BUTLER_DOCUMENT_BASELINE;
if (baselineRef) assert.equal(stage, "before", "baseline mode is for before captures only");
if (stage === "before") assert(baselineRef, "BUTLER_DOCUMENT_BASELINE is required for before captures");
const baseline = new Map<string, string>();
if (stage === "before") for (const file of execFileSync("git", ["diff", "--name-only", "--diff-filter=M", baselineRef!], { cwd: root, encoding: "utf8" }).trim().split("\n")) {
  if (!file || (!file.startsWith("packages/butler-app/client/ui/src/") && !file.startsWith("packages/butler-i18n/src/")) || !/\.tsx?$/u.test(file) || file.includes("/design-system/")) continue;
  baseline.set(resolve(root, file), execFileSync("git", ["show", `${baselineRef}:${file}`], { cwd: root, encoding: "utf8" }));
}
process.chdir(join(root, "packages/butler-app/client/ui"));
const vite = await createServer({ plugins: [documentHarnessPlugin, documentProfilePlugin(), { name: "documents-baseline", enforce: "pre", load(id) { return baseline.get(id.split("?")[0]!); } }], server: { host: "127.0.0.1", port: 0 }, logLevel: "error" }); await vite.listen();
const base = vite.resolvedUrls!.local[0]!, browser = await launchSmokeBrowser();
let background = "plain";
async function setup(page: Page) {
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path.startsWith("/src/") || path.startsWith("/node_modules/") || path.startsWith("/@")) return route.continue();
    if (url.origin !== new URL(base).origin) return route.abort();
    const answer = (data: unknown) => route.fulfill({ json: { ok: true, data } });
    if (path === "/") {
      const response = await route.fetch(), fixture = JSON.stringify({ messages: [message], background, settings: { reduce_motion: false } }).replaceAll("<", "\\u003c");
      return route.fulfill({ response, body: (await response.text()).replace("<head>", `<head><script>window.butlerConversationFixture=${fixture}</script>`) });
    }
    if (path === "/documents" && request.method() === "POST") {
      const body = request.postDataJSON();
      head = { ...head, id: "doc_created", title: body.title, body: body.body, chat_id: body.chat_id ?? head.chat_id, rev: head.rev + 1 };
      history = [structuredClone(head)]; return answer(head);
    }
    if (path === `/documents/${head.id}`) {
      if (request.method() === "PUT") {
        const body = request.postDataJSON(); puts.push(body);
        if (conflict) { conflict = false; head = { ...head, body: head.body.replace("Preserve unknown", "Remote unknown"), rev: head.rev + 1 }; history.unshift(structuredClone(head)); return route.fulfill({ status: 409, json: { error: { code: "revision_conflict", message: "Conflict" } } }); }
        assert.equal(body.expected_rev, head.rev); head = { ...head, body: body.body, author: "user", rev: head.rev + 1 }; history.unshift(structuredClone(head));
      }
      return answer(projected(head));
    }
    if (path.endsWith("/revisions")) return answer(history);
    if (path.includes("/revisions/")) return answer(projected(history.find(row => row.rev === Number(path.split("/").at(-1)))!));
    if (path.endsWith("/restore")) {
      const body = request.postDataJSON(); restores.push(body);
      const old = history.find(row => row.rev === body.rev)!;
      head = { ...head, body: old.body, author: "user", rev: head.rev + 1 }; history.unshift(structuredClone(head)); return answer(head);
    }
    if (path === "/library") { queries.push(url.search); return answer({ items: url.searchParams.has("kinds") ? [{ ...head, kind: "doc", capturedAt: head.created_at, updatedAt: head.updated_at, session: head.chat_id }, fileItem] : url.searchParams.get("kind") === "scrap" ? [scrap] : url.searchParams.get("kind") === "document" ? [fileItem] : [], next_cursor: null }); }
    if (path === "/library/groups") return answer({ groups: [], ungrouped: 1, total: 1 });
    if (path === "/library/facets") return answer({ total: 2, tags: [], sites: [] });
    if (path === "/library/tags") return answer({ tags: [] });
    if (path.startsWith("/message-assets/")) return route.fulfill({ contentType: "image/svg+xml", body: image });
    if (path.startsWith("/message-files/")) return route.fulfill({ contentType: "text/markdown", body: "# File report\n" });
    if (path.endsWith("/controls")) return answer({ session_id: "butler-client", revision: 0, catalog_generation: "harness-model-catalog-v1", controls: { model: "openai/gpt-5.6-sol", reasoning_effort: "none", access_mode: "full_access", plan_mode: false } });
    if (path === "/session-queue") return answer({ queued_messages: [] });
    if (/^\/projects\/[^/]+\/canon(\/sidebar)?$/u.test(path)) return answer(path.endsWith("/sidebar") ? { groups: [] } : { backlog: [], plans: [], backlog_revision: 0 });
    if (["/session-view", "/summary", "/navigation", "/events/live", "/health"].includes(path)) return answer({});
    if (path === "/favicons") return route.fulfill({ status: 404 });
    return route.continue();
  });
  await page.exposeFunction("captureExport", (value: Record<string, string>) => exports.push(value));
  await page.addInitScript(() => {
    const capture = (window as unknown as { captureExport: (value: unknown) => Promise<void> }).captureExport;
    (window as unknown as { captureExport: (value: { format: string }) => Promise<void> }).captureExport = async value => {
      await capture(value); (window as unknown as { lastExport?: string }).lastExport = value.format;
    };
  });
}
async function open(page: Page, width = 1440, theme = "light", fullPage = false) {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(`${base}?visual=components&theme=${theme}&locale=ko`);
  if (fullPage) {
    await drawer(page);
    await page.locator('[data-library-item="doc_report"]').getByText(head.title, { exact: true }).click();
  } else await page.locator('[data-test-class="message-artifact-list"]').getByText("Report", { exact: true }).click();
  await page.getByRole("textbox", { name: "문서", exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(new URL(page.url()).searchParams.get("doc"), fullPage ? head.id : null);
  assert.equal(await page.locator('[data-test-class="file-viewer"]').count(), fullPage ? 0 : 1);
  if (!fullPage) {
    const pane = page.locator('[data-test-class="file-viewer"]');
    await pane.locator('[data-slot="document-editor-page"]').waitFor();
    // One title row: the document's own, carrying the viewer's close (and back on a phone); the pane adds no header.
    const row = pane.locator('[data-test-class="editable-document"] > :first-child');
    assert.equal(await pane.locator('[data-test-class="file-viewer-header"]').count(), 0, "no pane title row over the document");
    assert.deepEqual(await pane.evaluate(node => [...node.querySelectorAll("h2")].filter(h => !h.closest('[role="textbox"]')).map(h => h.textContent)), [head.title], "the title shows once");
    assert.equal(await row.locator('[data-test-class="file-viewer-close"]').count(), 1, "close sits in the document's title row");
    if (width === 390 || width === 1440) assert.equal(await row.locator('[data-test-class="file-viewer-back"]').count(), width === 390 ? 1 : 0, "back sits in the title row on a phone");
    if (width === 1440) {
      const chat = await page.locator('[data-test-class~="conversation-scroll"]').boundingBox(), viewer = await pane.boundingBox();
      assert(chat && viewer && viewer.x >= chat.x + chat.width, "document occupies the right slot beside the chat");
    }
  }
  await page.locator('[data-slot="document-editor-page"]').waitFor();
}
const editor = (page: Page) => page.getByRole("textbox", { name: "문서", exact: true });
async function selectText(page: Page) {
  await editor(page).locator("p, li").first().evaluate(node => {
    const selection = window.getSelection()!, range = document.createRange(); range.selectNodeContents(node); selection.removeAllRanges(); selection.addRange(range);
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); document.dispatchEvent(new Event("selectionchange"));
  });
  await page.getByRole("toolbar", { name: "서식" }).waitFor();
}
async function shot(page: Page, name: string, width: number, theme: string) {
  await page.screenshot({ path: join(evidence, `${stage}-${name}-${width}-${theme}-${background}.png`), animations: "disabled" });
}
async function live(page: Page) {
  const before = head.rev;
  head = { ...head, body: head.body.replace("important", "Butler revised"), author: "butler", rev: head.rev + 1 }; history.unshift(structuredClone(head));
  await page.evaluate(async ({ id, rev }) => {
    const path = "/src/app/documentEvents.ts", events = await import(/* @vite-ignore */ path);
    events.publishDocumentEvent({ type: "document.updated", payload: { id, rev, author: "butler", changed: [{ start_line: 3, end_line: 3 }] } });
  }, { id: head.id, rev: head.rev });
  await page.getByText("버틀러가 수정 중", { exact: true }).waitFor();
  await page.locator('[data-butler-editing="true"]').first().waitFor();
  return before;
}
async function interactions(page: Page, width = 1440) {
  await open(page, width); const count = puts.length;
  await page.waitForTimeout(950); assert.equal(puts.length, count, "opening preserves exact Markdown without PUT");
  await editor(page).locator("h1").click(); await page.keyboard.press("ControlOrMeta+End"); await page.keyboard.type("My new paragraph");
  await page.getByText("저장됨", { exact: true }).waitFor(); assert.equal(puts.length, count + 1); assert.ok(head.body.includes("My new paragraph"));
  await selectText(page); await page.getByRole("button", { name: "굵게", exact: true }).click();
  await selectText(page); await page.getByRole("button", { name: "제목", exact: true }).click();
  await editor(page).locator("h2").waitFor();
  await editor(page).locator("h2").evaluate(node => { const selection = window.getSelection()!, range = document.createRange(); range.selectNodeContents(node); selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event("selectionchange")); });
  await page.getByRole("button", { name: "목록", exact: true }).click();
  await selectText(page); await page.getByRole("button", { name: "블록 추가", exact: true }).click();
  await page.getByRole("button", { name: "Saved budget", exact: true }).click();
  await page.getByRole("dialog", { name: "블록 추가", exact: true }).waitFor({ state: "hidden" });
  assert.equal(await editor(page).locator('[data-test-class="answer-blocks"]').count(), 2, "two block embeds");
  await page.getByText("저장됨", { exact: true }).waitFor();
  const undo = await live(page);
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: "버틀러가 수정했어요" });
  await toast.waitFor();
  const restored = page.waitForResponse(response => response.url().endsWith("/restore"));
  await toast.getByRole("button", { name: getAppCopy("ko-KR").library.undo, exact: true }).click();
  await restored;
  await page.waitForFunction(() => !document.querySelector('[data-butler-editing="true"]'));
  assert.equal(restores.at(-1)?.rev, undo);
  conflict = true;
  await editor(page).locator("h1").click(); await page.keyboard.press("ControlOrMeta+End"); await page.keyboard.type(" typed through conflict");
  await page.getByText("저장됨", { exact: true }).waitFor();
  assert.ok(head.body.includes("typed through conflict")); assert.ok(head.body.includes("Remote unknown"));
  await clickDocumentAction(page, "버전 기록");
  await page.getByRole("listbox", { name: "버전 기록" }).getByText("버틀러", { exact: true }).first().waitFor();
  await page.getByRole("option").last().click();
  await page.locator("[data-document-read-only]").waitFor();
  await checkDocumentImage(page, width, evidence, "[data-document-read-only]");
  await page.locator('[data-slot="version-history"]').getByRole("button", { name: "되돌리기" }).click();
  await editor(page).waitFor();
  await page.evaluate(() => {
    (window as unknown as { butlerApp: unknown }).butlerApp = { exportDocument: (window as unknown as { captureExport: (value: unknown) => void }).captureExport };
  });
  await clickDocumentAction(page, "Markdown으로 내보내기");
  await page.waitForTimeout(200); assert.equal(exports.at(-1)?.format, "markdown"); assert.ok(!exports.at(-1)!.content.includes("```blocks")); assert.ok(exports.at(-1)!.content.includes("data:image/svg+xml;base64,"));
  const expected = initial.replace(/```blocks\n[^]*?\n```/u, "### Budget\n\n- Total: 120").replace("(img_abcdefghij)", `(${imageData})`);
  assert.equal(exports.at(-1)!.content, expected);
  await clickDocumentAction(page, "PDF로 내보내기");
  await page.waitForTimeout(200); assert.equal(exports.at(-1)?.format, "pdf"); assert.ok(exports.at(-1)!.content.includes("data-document-read-only")); assert.ok(!exports.at(-1)!.content.includes("contenteditable=\"true\""));
  await page.evaluate(() => { delete window.butlerApp; });
  await closeAndFlush(page);
}
async function closeAndFlush(page: Page) {
  await editor(page).locator("h1").click(); await selectText(page);
  await page.keyboard.press("Escape");
  await page.getByRole("toolbar", { name: "서식" }).waitFor({ state: "hidden" });
  assert.ok(await editor(page).evaluate(node => node.contains(document.activeElement)), "Escape keeps editor focus");
  await page.keyboard.press("Escape"); await editor(page).waitFor();
  await editor(page).focus(); await page.keyboard.press("ControlOrMeta+End");
  const saved = page.waitForResponse(response => response.request().method() === "PUT" && response.url().endsWith(`/documents/${head.id}`));
  await page.keyboard.type(" flushed on navigation");
  await page.locator('[data-test-class="file-viewer-close"]').click();
  await editor(page).waitFor({ state: "hidden" });
  await saved; assert.ok(head.body.includes(" flushed on navigation"));
  assert.equal(new URL(page.url()).searchParams.get("doc"), null);
}
async function drawer(page: Page) {
  await page.evaluate(async () => { const path = "/src/components/library/libraryNav.ts"; (await import(/* @vite-ignore */ path)).openLibrary({ section: "document" }); });
  await page.locator('[data-library-item="doc_report"]').waitFor(); await page.locator('[data-library-item="file-report"]').waitFor();
}
async function outsideUndo(page: Page) {
  head = { ...head, body: initial }; history = [structuredClone(head)];
  await open(page);
  const rev = await live(page);
  await page.locator('[data-test-class="file-viewer-close"]').click();
  await editor(page).waitFor({ state: "hidden" });
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: "버틀러가 수정했어요" });
  const restored = page.waitForResponse(response => response.url().endsWith("/restore"));
  await toast.getByRole("button", { name: getAppCopy("ko-KR").library.undo, exact: true }).click();
  await restored; assert.equal(restores.at(-1)?.rev, rev);
}
async function navigation(page: Page) {
  await open(page, 900);
  await clickDocumentAction(page, "원래 대화");
  await page.locator('[data-test-class="file-viewer-close"]').click();
  await page.locator('[data-test-class="session-info-toggle"]').click();
  await page.locator('[data-session-section="artifacts"]').getByText("Report", { exact: true }).click();
  await editor(page).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("doc"), null);
  await drawer(page);
  await page.locator('[data-library-item="doc_report"]').getByText("Report", { exact: true }).click();
  await editor(page).waitFor();
  await page.reload(); await editor(page).waitFor();
  await clickDocumentAction(page, "원래 대화");
  assert.equal(new URL(page.url()).searchParams.get("doc"), null);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(async fixture => {
    const path = "/src/app/store.ts", { useButlerStore } = await import(/* @vite-ignore */ path);
    useButlerStore.setState({ messages: [{ ...fixture, answer_blocks: [{ call_id: "reply-blocks", set_ids: [], spec: { v: 2, blocks: [{ type: "text", text: "Editable reply", title: "Reply document" }] } }] }] });
  }, message);
  const block = page.locator('[data-answer-block="text"]').filter({ hasText: "Editable reply" });
  await block.hover(); await block.getByRole("button", { name: "더 보기", exact: true }).click();
  await page.getByRole("menuitem", { name: "문서로 만들기", exact: true }).click();
  await editor(page).getByText("Editable reply", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("doc"), null);
  await page.locator('[data-test-class="file-viewer"] [data-test-class="editable-document"]').waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  head = { ...head, id: artifact.id, title: "Report", body: initial }; history = [structuredClone(head)];
}
async function slotSharing(page: Page) {
  await open(page);
  const expected = await editor(page).innerText();
  await page.evaluate(async () => {
    const bridgePath = "/src/components/browser/browserBridge.ts", shellPath = "/src/components/browser/browserShellState.ts";
    (window as Window & { butlerBrowser?: unknown }).butlerBrowser = {
      call: async () => null, subscribe: () => () => {}, onFrame: () => () => {}, onPointer: () => () => {},
      onElementDrag: () => () => {}, onSelectionAction: () => () => {}, onAddress: () => () => {},
    };
    (await import(/* @vite-ignore */ bridgePath)).useBrowserState.setState({ enabled: true, restored: false });
    (await import(/* @vite-ignore */ shellPath)).useBrowserShellState.getState().setOpen("butler-client", true);
  });
  await editor(page).waitFor({ state: "hidden" });
  await page.locator('[data-test-class="browser-area"]').waitFor();
  await page.evaluate(async doc => {
    const path = "/src/components/documents/documentApi.ts";
    (await import(/* @vite-ignore */ path)).openDocument(doc);
  }, { id: head.id, title: head.title, chat_id: head.chat_id });
  await page.locator('[data-test-class="file-viewer"] [data-test-class="editable-document"]').waitFor();
  await page.evaluate(async () => {
    const path = "/src/components/browser/browserShellState.ts";
    (await import(/* @vite-ignore */ path)).useBrowserShellState.getState().setOpen("butler-client", true);
  });
  await editor(page).waitFor({ state: "hidden" });
  await page.locator('[data-test-class="browser-area"]').waitFor();
  await page.evaluate(async () => {
    const path = "/src/app/fileViewerState.ts";
    (await import(/* @vite-ignore */ path)).useFileViewerState.getState().setShown("butler-client", true);
  });
  await editor(page).waitFor();
  assert.equal(await editor(page).innerText(), expected, "slot switches preserve the complete edited document");
  await page.evaluate(async doc => {
    const path = "/src/components/documents/documentApi.ts";
    (await import(/* @vite-ignore */ path)).openDocument(doc);
  }, { id: head.id, title: head.title });
  await editor(page).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("doc"), head.id);
  assert.equal(await page.locator('[data-test-class="file-viewer"]').count(), 0);
}
async function measure(page: Page) {
  const embeds = Array.from({ length: 10 }, () => `\`\`\`blocks\n${JSON.stringify(spec)}\n\`\`\`\n\n`).join("");
  const prefix = "# Large document\n\n" + embeds + "![image](img_abcdefghij)\n\n";
  const text = "Complete paragraph with **bold** words.\n\n";
  const length = 256 * 1024 - prefix.length;
  head = { ...head, body: prefix + text.repeat(Math.floor(length / text.length)) + "x".repeat(length % text.length) };
  assert.equal(Buffer.byteLength(head.body), 256 * 1024);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}?visual=components&theme=light&locale=ko`);
  await page.evaluate(() => {
    performance.clearMeasures();
    const start = performance.now();
    (window as unknown as { documentFirstPaint: Promise<number> }).documentFirstPaint = new Promise(resolve => {
      const check = () => {
        const root = document.querySelector('[data-document-id]');
        const images = [...root?.querySelectorAll("img") ?? []];
        if (root?.querySelectorAll('[data-test-class="answer-blocks"]').length !== 10 || images.length !== 1 || !images.every(image => image.complete && image.naturalWidth > 0)) return;
        observer.disconnect(); document.removeEventListener("load", check, true);
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)));
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      document.addEventListener("load", check, true);
    });
  });
  const start = performance.now();
  await page.locator('[data-test-class="message-artifact-list"]').getByText("Report", { exact: true }).click();
  await editor(page).waitFor();
  await editor(page).locator('[data-test-class="answer-blocks"]').nth(9).waitFor();
  assert.equal(await editor(page).getAttribute("contenteditable"), "true");
  const openMs = performance.now() - start;
  assert.equal(await editor(page).locator('[data-test-class="answer-blocks"]').count(), 10);
  const firstPaintMs = await page.evaluate(() => (window as unknown as { documentFirstPaint: Promise<number> }).documentFirstPaint);
  const steps = await page.evaluate(() => {
    const totals: Record<string, { ms: number; calls: number }> = {};
    for (const entry of performance.getEntriesByType("measure").filter(entry => entry.name.startsWith("document:"))) {
      const step = totals[entry.name.slice("document:".length)] ??= { ms: 0, calls: 0 };
      step.ms += entry.duration; step.calls++;
    }
    const update = totals["Lexical update"]?.ms ?? 0, imported = totals["import total"]?.ms ?? 0;
    totals["Lexical reconcile/commit"] = { ms: update - imported, calls: totals["Lexical update"]?.calls ?? 0 };
    return totals;
  });
  assert.equal(await editor(page).locator(":scope > p").allTextContents().then(parts => parts.join("\n\n")), head.body.slice(prefix.length).trim().replaceAll("**", ""), "every paragraph is rendered in order");
  assert.equal(await editor(page).locator("img").count(), 1);
  const original = head.body, count = puts.length;
  await editor(page).focus();
  await editor(page).evaluate(root => {
    const text = document.createTreeWalker(root.querySelector("h1")!, NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 1);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event("selectionchange"));
    (window as unknown as { documentPaint: Promise<number> }).documentPaint = new Promise(resolve => {
      root.addEventListener("keydown", () => { const start = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start))); }, { once: true });
    });
  });
  await page.keyboard.type("t");
  const paintMs = await page.evaluate(() => (window as unknown as { documentPaint: Promise<number> }).documentPaint);
  await page.getByText("저장됨", { exact: true }).waitFor();
  const expected = original.replace("# Large document", "# targe document");
  assert.equal(head.body, expected);
  assert.equal(puts.length, count + 1, "one debounced save for the large document");
  assert.equal(puts.at(-1)?.body, expected, "the complete Markdown reaches the server");
  assert.equal(await editor(page).locator("h1").innerText(), "targe document");
  assert.equal(await editor(page).locator('[data-test-class="answer-blocks"]').count(), 10);
  const result = { bytes: Buffer.byteLength(original), blocks: 10, images: 1, openMs, firstPaintMs, keystrokeToPaintMs: paintMs, steps };
  writeFileSync(join(evidence, process.env.BUTLER_DOCUMENT_MEASUREMENT === "before" ? "before-performance.json" : "performance.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
}
async function unknownImage(page: Page) {
  projectImageSize = false;
  head = { ...head, body: initial }; history = [structuredClone(head), { ...head, rev: head.rev - 1 }];
  try {
    await open(page);
    const image = editor(page).locator('[data-slot="media-frame"]');
    assert.equal(await image.getAttribute("data-natural"), null);
    assert.equal(await image.getAttribute("data-aspect"), "16:10", "unknown editor images retain their existing frame");
    await clickDocumentAction(page, "버전 기록");
    await page.getByRole("option").last().click();
    const preview = page.locator('[data-document-read-only]');
    await preview.locator("img").waitFor();
    assert.equal(await preview.locator('[data-slot="media-frame"]').count(), 0, "unknown revision images retain their existing Markdown rendering");
  } finally { projectImageSize = true; }
}
async function imageEmbeds(page: Page) {
  const body = head.body;
  const imageSpec = { v: 2, blocks: [{ type: "image", img: "img_abcdefghij", alt: "Mountain" }] };
  head = { ...head, body: `![Mountain](img_abcdefghij)\n\n\`\`\`blocks\n${JSON.stringify(imageSpec)}\n\`\`\`\n` };
  for (const width of [1440, 390]) {
    await open(page, width);
    assert.equal(await editor(page).locator('[data-slot="media-frame"][data-natural]').count(), 2);
    await checkDocumentImage(page, width, evidence);
    await clickDocumentAction(page, "버전 기록");
    await page.getByRole("listbox").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("listbox").waitFor({ state: "hidden" });
    await editor(page).waitFor();
    await page.keyboard.press("Escape");
    await editor(page).waitFor();
  }
  head = { ...head, body }; history = [structuredClone(head)];
}
async function keyboardUnits(page: Page) {
  await open(page);
  const unit = editor(page).locator('[data-test-class="answer-blocks"]').first();
  const position = () => unit.evaluate(node => {
    const root = node.closest('[role="textbox"]')!; let top: Element = node;
    while (top.parentElement !== root) top = top.parentElement!;
    return [...root.children].indexOf(top);
  });
  const before = await position();
  await unit.getByText("Total", { exact: true }).click();
  await page.locator('[data-slot="document-block-embed"][data-selected="true"]').waitFor();
  await page.keyboard.press("Alt+ArrowUp"); assert.equal(await position(), before - 1);
  await page.keyboard.press("Delete");
  await unit.waitFor({ state: "hidden" });
  await page.getByText("저장됨", { exact: true }).waitFor();
  assert.ok(!head.body.includes("```blocks")); assert.ok(head.body.includes("![image](img_abcdefghij)"));
  await editor(page).locator("h1").click(); await page.keyboard.press("End"); await page.keyboard.type("ordered");
  await page.getByText("저장됨", { exact: true }).waitFor(); assert.ok(head.body.includes("ordered"));
}
const wideContent = "\n\n> " + "Unknown raw Markdown ".repeat(30)
  + "\n\n```typescript\nconst values = [" + "1234567890, ".repeat(40) + "];\n```"
  + "\n\n| First column | Second column |\n| --- | --- |\n| " + "wide-cell-".repeat(50) + " | preserved |\n";
async function titleLines() {
  const page = await browser.newPage({ deviceScaleFactor: 2 }), results = [];
  try {
    await setup(page);
    for (const width of [1440, 390]) for (const theme of ["light", "dark"]) for (const fullPage of [false, true]) {
      await open(page, width, theme, fullPage);
      results.push(await checkTitleLine(page, { width, theme, stage, evidence, fullPage }));
      if (width === 390 && stage !== "before") await checkDocumentMenu(page, { theme, evidence, fullPage, exports });
    }
    for (const fullPage of [false, true]) for (const width of [390, 768, 1024, 1280, 1440]) {
      await open(page, width, "light", fullPage); await measureHeader(page, width, fullPage);
    }
    assert(results.every(result => result.buttons.every(button => Math.abs(button.center - result.title) <= 0.5)), JSON.stringify(results));
  } finally { await page.close(); }
}
async function matrix(page: Page) {
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) for (background of ["plain", "wallpaper"]) {
    head = { ...head, title: "Report — document layout, revisions and export", body: initial + wideContent }; history = [structuredClone(head), { ...head, rev: head.rev - 1, author: "user" }];
    await open(page, width, theme);
    const paneLayout = await measureDocumentLayout(page);
    layouts.push({ width, theme, background, state: "pane-document", layout: paneLayout });
    assertDocumentLayout(paneLayout, width); await assertDocumentOverflow(page);
    await shot(page, "pane-document", width, theme);
    await live(page);
    const paneEditing = await measureDocumentLayout(page);
    layouts.push({ width, theme, background, state: "pane-editing", layout: paneEditing });
    assertDocumentLayout(paneEditing, width); await assertDocumentOverflow(page);
    await shot(page, "pane-butler-editing", width, theme);
    await open(page, width, theme, true); await shot(page, "drawer-document", width, theme);
    const layout = await measureDocumentLayout(page);
    layouts.push({ width, theme, background, state: "document", layout });
    assertDocumentLayout(layout, width); await assertDocumentOverflow(page);
    await checkDocumentImage(page, width, evidence);
    await selectText(page); await shot(page, "format", width, theme); await page.keyboard.press("ArrowRight");
    await live(page); await shot(page, "butler-editing", width, theme);
    const editingLayout = await measureDocumentLayout(page);
    layouts.push({ width, theme, background, state: "editing", layout: editingLayout });
    assertDocumentLayout(editingLayout, width); await assertDocumentOverflow(page);
    await clickDocumentAction(page, "버전 기록"); await page.getByRole("listbox").waitFor(); await shot(page, "versions", width, theme);
    await page.getByRole("option").last().click(); await page.locator('[data-document-read-only] table').waitFor();
    await assertDocumentOverflow(page);
    await page.getByRole("option").first().click(); await editor(page).waitFor();
    await page.keyboard.press("Escape"); await page.getByRole("listbox").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: await page.getByRole("button", { name: "내보내기", exact: true }).isVisible() ? "내보내기" : "더보기", exact: true }).click(); await page.getByRole("menuitem", { name: /PDF/u }).waitFor(); await shot(page, "export", width, theme); await page.keyboard.press("Escape"); await page.getByRole("menu").waitFor({ state: "hidden" });
    await drawer(page); await shot(page, "drawer", width, theme);
    await page.locator('[data-library-item="doc_report"]').getByText(head.title, { exact: true }).click(); await editor(page).waitFor(); await shot(page, "drawer-reopened", width, theme);
    assert.equal(new URL(page.url()).searchParams.get("doc"), head.id);
    await page.reload(); await editor(page).waitFor();
    await drawer(page); await page.locator('[data-library-item="file-report"]').getByText("File report", { exact: true }).click();
    await page.getByRole("combobox", { name: "버전", exact: true }).waitFor(); await page.locator('[data-test-class="artifact-viewer"]').waitFor();
    await shot(page, "file-viewer", width, theme);
  }
}
try {
  const page = await browser.newPage(); await setup(page);
  await titleLines();
  if (stage === "before") { await matrix(page); await measure(page); }
  else {
    await imageEmbeds(page);
    await checkTrailing(page, base, head.id);
    await interactions(page);
    await interactions(page, 390);
    await keyboardUnits(page);
    await slotSharing(page);
    await navigation(page);
    await outsideUndo(page);
    await unknownImage(page);
    await matrix(page);
    for (const width of [1440, 390]) for (const theme of ["light", "dark"]) for (background of ["plain", "wallpaper"]) {
      head = { ...head, body: initial };
      await open(page, width, theme); await shot(page, "drawer-document", width, theme);
    }
    await measure(page);
    assert.ok(queries.some(query => query.includes("kinds=doc%2Cdocument")));
  }
  writeFileSync(join(evidence, `${stage}-layout.json`), JSON.stringify(layouts, null, 2));
  assert.deepEqual(errors, []);
  writeFileSync(join(evidence, `${stage}-result.json`), JSON.stringify({ ok: true, puts: puts.length, restores: restores.length, exports: exports.map(item => item.format), modelCalls: 0 }, null, 2));
  console.log("documents-ui: passed");
} catch (error) {
  writeFileSync(join(evidence, `${stage}-layout.json`), JSON.stringify(layouts, null, 2));
  const page = browser.contexts()[0]?.pages()[0];
  if (page) { await page.screenshot({ path: join(evidence, `${stage}-failure.png`) }); writeFileSync(join(evidence, `${stage}-failure.txt`), JSON.stringify({ error: String(error), errors, body: await page.locator("body").innerText(), head, puts, restores })); }
  throw error;
} finally { await browser.close(); await vite.close(); }
