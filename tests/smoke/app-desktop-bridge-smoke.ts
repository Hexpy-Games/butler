// test-category: race
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src/index";
import { LEGACY_FIRST_RUN_STORAGE_KEY, legacyFirstRunCompleteRecord } from "../../packages/butler-app/client/ui/src/app/onboarding";
import type { EditableDocument, DocumentRevision } from "../../packages/butler-app/client/ui/src/components/documents/documentApi";
import { installMemoryDesktopBridge } from "../support/memory-desktop-bridge";
import { createNativeAppServer, type NativeAppServerHandle } from "../support/native-app-server";
import { launchSmokeBrowser } from "../support/smoke-browser";

type SmokeWindow = Window & {
  butlerApp: Record<string, unknown>;
  desktopBridgeSmoke: { calls: Array<{ method: string; input: unknown }>; errors: string[] };
};

type AnswerMessage = { role: string; status: string; answer_blocks?: Array<{
  spec: { blocks: Array<{ type: string; items?: Array<{ title: string; image_url?: string }> }> };
}> };

// Observe real preload calls and retain transient error toasts for the whole flow.
async function observeBridge(page: Page) {
  await page.evaluate((usageFailed) => {
    const target = window as unknown as SmokeWindow;
    const bridge = target.butlerApp;
    if (typeof bridge?.getUsageHistory !== "function" || typeof bridge.documents !== "function" || typeof bridge.saveLibrary !== "function") {
      throw new Error("Real desktop preload must expose getUsageHistory, documents and saveLibrary");
    }
    const state: SmokeWindow["desktopBridgeSmoke"] = { calls: [], errors: [] };
    target.desktopBridgeSmoke = state;
    // The preload object is frozen. Wrap only for observation, forwarding unchanged.
    target.butlerApp = { ...bridge };
    for (const method of ["getUsageHistory", "documents", "saveLibrary"]) {
      const original = bridge[method] as (...args: unknown[]) => unknown;
      target.butlerApp[method] = (...args: unknown[]) => {
        state.calls.push({ method, input: args[0] });
        return original(...args);
      };
    }
    const scan = () => {
      for (const toast of document.querySelectorAll("[data-sonner-toast]")) {
        const text = toast.textContent ?? "";
        if (toast.getAttribute("data-type") === "error" || text.includes(usageFailed)) {
          if (!state.errors.includes(text)) state.errors.push(text);
        }
      }
    };
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    scan();
  }, getAppCopy("ko-KR").interfacePanels.usageFailed);
}

async function assertNoErrors(page: Page, step: string) {
  const errors = await page.evaluate(() => (window as unknown as SmokeWindow).desktopBridgeSmoke.errors);
  assert.deepEqual(errors, [], `${step}: no error toast (including usage-history)`);
  assert.equal(await page.locator('[data-sonner-toast][data-type="error"]').count(), 0, `${step}: no current error toast`);
}

async function usageHistory(page: Page, server: NativeAppServerHandle, output: string) {
  const started = performance.now();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  const response = page.waitForResponse(res => new URL(res.url()).origin === new URL(server.url).origin
    && new URL(res.url()).pathname === "/usage-history" && res.request().method() === "GET");
  // Settle the response listener on negative-control failures too.
  void response.catch(() => {});
  await page.getByRole("button", { name: "사용량", exact: true }).click();
  const section = page.locator('[data-settings-section-id="usage-history"]');
  await section.waitFor();
  await page.waitForFunction(() => (window as unknown as SmokeWindow).desktopBridgeSmoke.errors.length > 0
    || document.querySelector('[data-settings-section-id="usage-history"] [data-test-class="usage-history"]')?.getAttribute("aria-busy") === "false");
  await assertNoErrors(page, "Usage history");
  assert.equal(await section.locator('[data-test-class="usage-history"]').getAttribute("aria-busy"), "false");
  const result = await response;
  assert(result.ok(), `Native /usage-history returned ${result.status()}`);
  assert(await page.evaluate(() => (window as unknown as SmokeWindow).desktopBridgeSmoke.calls
    .some(call => call.method === "getUsageHistory")), "UI api() called the real preload getUsageHistory");
  const copy = getAppCopy("ko-KR").composer.usage;
  await section.getByText(copy.lifetimeTokens, { exact: true }).waitFor();
  await section.scrollIntoViewIfNeeded();
  await page.evaluate(() => document.fonts.ready);
  await section.screenshot({ path: resolve(output, "usage-history-ko-light-1280.png") });
  await assertNoErrors(page, "Loaded usage history");
  console.log(`Usage history passed (${Math.round(performance.now() - started)} ms): loaded, real preload call, native GET /usage-history, no error toast`);
}

async function editDocument(page: Page, server: NativeAppServerHandle, output: string) {
  const started = performance.now();
  const title = "서랍 브리지 확인";
  const original = "처음 저장한 문서 본문입니다.";
  const edited = "서랍에서 열어 실제 편집기로 수정한 본문입니다.";
  // Start with a Butler revision so the user's edit creates a separate revision;
  // consecutive unseen user saves intentionally coalesce in the native store.
  const doc = await server.api<EditableDocument>("/documents", {
    method: "POST", body: JSON.stringify({ title, body: original, author: "butler" }),
  });
  const path = `/documents/${encodeURIComponent(doc.id)}`;
  await page.locator('[data-test-class~="settings-titlebar"]').getByRole("button", { name: "돌아가기", exact: true }).click();
  await page.locator('[data-test-class="library-entry"]').click();
  await page.locator('[data-library-kind="document"]').getByText(title, { exact: true }).click();
  const document = page.locator('[data-test-class="editable-document"]');
  const editor = document.locator(`[contenteditable="true"][data-document-id="${doc.id}"]`);
  await editor.waitFor();
  assert.equal(await editor.innerText(), original, "Library opened the API-created document body");
  await document.getByText("저장됨", { exact: true }).waitFor();
  const savedResponse = page.waitForResponse(res => new URL(res.url()).origin === new URL(server.url).origin
    && new URL(res.url()).pathname === path && res.request().method() === "PUT");
  void savedResponse.catch(() => {});
  await editor.fill(edited);
  // A real focus change flushes DocumentSession's draft (also autosaved after 800 ms).
  await document.getByRole("heading", { name: title, exact: true }).click();
  const response = await savedResponse;
  assert(response.ok(), `Native document save returned ${response.status()}`);
  await document.getByText("저장됨", { exact: true }).waitFor();
  const head = await server.api<EditableDocument>(path);
  assert(head.rev > doc.rev, "Editing stores a new revision");
  assert.equal(head.body, edited, "Latest native document contains the entire edited body");
  assert.equal(head.author, "user");
  const revisions = await server.api<DocumentRevision[]>(`${path}/revisions`);
  assert(revisions.some(row => row.rev === doc.rev) && revisions.some(row => row.rev === head.rev), "Native history retains original and saved revisions");
  const revision = await server.api<EditableDocument>(`${path}/revisions/${head.rev}`);
  assert.equal(revision.body, edited, "Stored revision contains the edited body");
  assert.equal((await server.api<EditableDocument>(`${path}/revisions/${doc.rev}`)).body, original);
  const calls = await page.evaluate(() => (window as unknown as SmokeWindow).desktopBridgeSmoke.calls);
  for (const method of ["GET", "PUT"]) {
    assert(calls.some(call => call.method === "documents" && (call.input as { path: string; method: string }).path === path
      && (call.input as { method: string }).method === method), `UI ${method} ${path} went through real preload documents`);
  }
  await assertNoErrors(page, "Saved document");
  assert.equal(await editor.innerText(), edited);
  await page.screenshot({ path: resolve(output, "saved-document-ko-light-1280.png") });
  console.log(`Document passed (${Math.round(performance.now() - started)} ms): library open/edit/blur-save, native revision ${doc.rev} → ${head.rev}, full text verified, no error toast`);
}

async function saveAnswerCard(page: Page, server: NativeAppServerHandle, output: string) {
  const started = performance.now();
  // Store a real picture before the stub's answer_blocks tool references it.
  const data = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 100; canvas.height = 80;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#426c98"; context.fillRect(0, 0, 100, 80);
    return canvas.toDataURL("image/jpeg").split(",")[1];
  });
  const image = await server.api<{ id: string }>("/internal/e2e/images/generated", {
    method: "POST", body: JSON.stringify({ session: "general", data, model_ref: "local/stub" }),
  });
  answerImage = image.id;
  await server.api("/messages", { method: "POST", body: JSON.stringify({
    chat_id: "general", text: "그림 카드를 보여 주세요", client_message_id: crypto.randomUUID(),
  }) });
  await page.waitForFunction(async (title) => {
    const response = await fetch("/messages?chat_id=general");
    const body = await response.json() as { data: { messages: AnswerMessage[] } };
    return body.data.messages.some(message => message.role === "assistant" && message.status === "delivered"
      && message.answer_blocks?.some(set => set.spec.blocks.some(block => block.type === "cards"
        && block.items?.some(item => item.title === title && item.image_url))));
  }, answerTitle);
  await page.locator('[data-tree-item="s:general"]').first().click();
  const card = page.locator('[data-slot="item-card"]').filter({ has: page.getByText(answerTitle, { exact: true }) });
  await card.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-slot="item-card"] img')]
    .some(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0));
  await card.screenshot({ path: resolve(output, "answer-card-before-save-ko-light-1280.png") });
  const savedResponse = page.waitForResponse(res => new URL(res.url()).pathname === "/library" && res.request().method() === "POST");
  void savedResponse.catch(() => {});
  await card.getByRole("button", { name: "서랍에 저장", exact: true }).click();
  const response = await savedResponse;
  const payload = response.request().postDataJSON() as { title: string; url: string; crop?: string };
  assert.equal(payload.title, answerTitle);
  assert.equal(payload.url, "");
  assert(payload.crop?.startsWith("data:image/jpeg;base64,"), "Card sends its photo as a JPEG crop");
  await page.waitForFunction(() => (window as unknown as SmokeWindow).desktopBridgeSmoke.errors.length > 0
    || [...document.querySelectorAll("[data-sonner-toast]")].some(toast => toast.textContent?.includes("서랍에 저장했어요")));
  await page.screenshot({ path: resolve(output, "answer-card-save-result-ko-light-1280.png") });
  await assertNoErrors(page, `Answer card save (native HTTP ${response.status()})`);
  assert(response.ok(), `Native card save returned ${response.status()}`);
  await page.locator("[data-sonner-toast]").getByText("서랍에 저장했어요", { exact: true }).waitFor();
  const calls = await page.evaluate(() => (window as unknown as SmokeWindow).desktopBridgeSmoke.calls);
  assert(calls.some(call => call.method === "saveLibrary" && (call.input as { title: string }).title === answerTitle),
    "Card save went through the real preload saveLibrary");
  const saved = await server.api<{ items: Array<{ title: string; url: string; crop: string }> }>("/library?kind=scrap");
  const item = saved.items.find(item => item.title === answerTitle);
  assert(item); assert.equal(item.url, ""); assert(item.crop.startsWith("data:image/jpeg;base64,"));
  await page.locator('[data-test-class="library-entry"]').click();
  await page.locator('[data-library-kind="scrap"]').getByText(answerTitle, { exact: true }).waitFor();
  await assertNoErrors(page, "Answer card in library");
  await page.screenshot({ path: resolve(output, "saved-answer-card-ko-light-1280.png") });
  await scrapSources(page, server, output, item.crop);
  console.log(`Answer card passed (${Math.round(performance.now() - started)} ms): real assistant card, preload saveLibrary, native HTTP ${response.status()}, empty source and JPEG retained, visible in scraps`);
}

// Exercise the saved answer crop and existing stored-picture scraps through the drawer UI.
async function scrapSources(page: Page, server: NativeAppServerHandle, output: string, crop: string) {
  const copy = getAppCopy("ko-KR");
  const sourcedTitle = "출처 있는 그림 스크랩";
  const assetTitle = "출처 없는 저장 그림";
  for (const item of [
    { title: sourcedTitle, url: "https://example.com/picture", crop, site: "example.com" },
    { title: assetTitle, url: "", asset: answerImage, site: "Previous site" },
  ]) {
    await server.api("/library", { method: "POST", body: JSON.stringify({
      ...item, id: crypto.randomUUID(), kind: "scrap", text: "", capturedAt: new Date().toISOString(),
    }) });
  }
  // Remount the drawer so API-created scraps are fetched along with the UI-saved answer.
  await page.locator('[data-tree-item="s:general"]').first().click();
  await page.locator('[data-test-class="library-entry"]').click();
  await page.locator('[data-library-kind="scrap"]').getByRole("button", { name: copy.library.viewAll, exact: true }).click();
  const failures: string[] = [];
  for (const [title, hasSource, filename] of [
    [answerTitle, false, "sourceless-scrap-detail"],
    [sourcedTitle, true, "sourced-scrap-detail"],
    [assetTitle, false, "sourceless-asset-detail"],
  ] as const) {
    const card = page.locator("[data-library-item]").filter({ has: page.getByText(title, { exact: true }) });
    await card.waitFor();
    await card.getByRole("button", { name: copy.browser.more, exact: true }).click();
    await page.getByRole("menu").waitFor();
    const sourceAction = page.getByRole("menuitem", { name: copy.browser.openSource, exact: true });
    if (await sourceAction.count() !== Number(hasSource)) failures.push(`${title}: card source action`);
    await page.keyboard.press("Escape");
    if (!hasSource && (await card.innerText()).includes("Previous site")) failures.push(`${title}: card source metadata`);
    await card.getByText(title, { exact: true }).click();
    const detail = page.locator('[data-test-class="library-detail"]');
    await detail.waitFor();
    await detail.getByText(copy.artifacts.loading, { exact: true }).waitFor({ state: "hidden" });
    await detail.locator("img").evaluateAll(images => Promise.all(images.map(image => (image as HTMLImageElement).decode())));
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: resolve(output, `${filename}-ko-light-1280.png`) });
    const button = detail.getByRole("button", { name: copy.browser.openSourcePage, exact: true });
    const sourceRow = detail.getByText(copy.library.source, { exact: true });
    if (await button.count() !== Number(hasSource)) failures.push(`${title}: detail source button`);
    if (await sourceRow.count() !== Number(hasSource)) failures.push(`${title}: detail source row`);
    if (hasSource) await detail.getByText("example.com", { exact: true }).waitFor();
    await page.locator('[data-test-class="titlebar-back"]').click();
    await card.waitFor();
  }
  assert.deepEqual(failures, [], "Only scraps with an HTTP(S) source show source actions and metadata");
  await assertNoErrors(page, "Scrap source visibility");
}

const answerTitle = "출처 없는 그림 카드";
let answerImage = "";
let answerToolSent = false;

const started = performance.now();
const output = resolve(process.env.BUTLER_DESKTOP_BRIDGE_SHOTS ?? ".tmp/desktop-bridge");
mkdirSync(output, { recursive: true });
const server = await createNativeAppServer({
  stubReply: () => "그림을 카드로 정리했습니다.",
  stubToolCall: () => {
    if (answerToolSent) return null;
    answerToolSent = true;
    return { name: "answer_blocks", arguments: { v: 2, blocks: [{ type: "cards", items: [{ title: answerTitle, img: answerImage }] }] } };
  },
  uiRoot: resolve("packages/butler-app/client/ui/dist"), config: { user: { name: "Smoke", language: "ko" } },
});
console.log(`Native smoke data (removed on stop): ${server.butlerData}`);
try {
  const browser = await launchSmokeBrowser();
  try {
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: "light" }) });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1400 }, locale: "ko-KR", timezoneId: "Asia/Seoul", colorScheme: "light", reducedMotion: "reduce" });
    await server.signIn(page);
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
      key: LEGACY_FIRST_RUN_STORAGE_KEY, value: JSON.stringify(legacyFirstRunCompleteRecord()),
    });
    await page.goto(server.url);
    await page.locator('[data-test-class~="app-sidebar"]').waitFor();
    // Install before in-app navigation mounts either screen and calls api().
    await installMemoryDesktopBridge(page, server);
    await observeBridge(page);
    await usageHistory(page, server, output);
    await editDocument(page, server, output);
    assert.equal(server.stubModelCalls.length, 0, "Usage and document steps make no model calls");
    await saveAnswerCard(page, server, output);
    // The native server only reaches the local stub; the seeded answer turn is its only model use.
    assert(server.stubModelCalls.length > 0, "The answer turn ran on the local stub model");
    console.log(`Desktop bridge smoke passed (${Math.round(performance.now() - started)} ms); screenshots: ${output}`);
  } finally { await browser.close(); }
} finally { await server.stop(); }
