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

// Observe real preload calls and retain transient error toasts for the whole flow.
async function observeBridge(page: Page) {
  await page.evaluate((usageFailed) => {
    const target = window as unknown as SmokeWindow;
    const bridge = target.butlerApp;
    if (typeof bridge?.getUsageHistory !== "function" || typeof bridge.documents !== "function") {
      throw new Error("Real desktop preload must expose getUsageHistory and documents");
    }
    const state: SmokeWindow["desktopBridgeSmoke"] = { calls: [], errors: [] };
    target.desktopBridgeSmoke = state;
    // The preload object is frozen. Wrap only for observation, forwarding unchanged.
    target.butlerApp = { ...bridge };
    for (const method of ["getUsageHistory", "documents"]) {
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

const started = performance.now();
const output = resolve(process.env.BUTLER_DESKTOP_BRIDGE_SHOTS ?? ".tmp/desktop-bridge");
mkdirSync(output, { recursive: true });
const server = await createNativeAppServer({
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
    assert.equal(server.stubModelCalls.length, 0, "This smoke makes no model calls");
    console.log(`Desktop bridge smoke passed (${Math.round(performance.now() - started)} ms); screenshots: ${output}`);
  } finally { await browser.close(); }
} finally { await server.stop(); }
