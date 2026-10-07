// Public UI flow against an isolated native gateway and a stub model.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Page } from "playwright";
import { createNativeAppServer, type NativeAppServerHandle } from "../support/native-app-server";
import { launchSmokeBrowser } from "../support/smoke-browser";
import { getAppCopy } from "../../packages/butler-app/client/ui/src/app/copy";
import type { ArchiveListView, SessionView } from "../../packages/butler-app/client/ui/src/app/types";
import { LEGACY_FIRST_RUN_STORAGE_KEY, legacyFirstRunCompleteRecord } from "../../packages/butler-app/client/ui/src/app/onboarding";

const copy = getAppCopy("ko-KR");
const shots = process.env.BUTLER_CLEAR_CHAT_SHOTS;
assert(shots, "BUTLER_CLEAR_CHAT_SHOTS is required");
mkdirSync(shots, { recursive: true });
const before = Boolean(process.env.BUTLER_CLEAR_CHAT_BEFORE_UI);
const saved: string[] = [];

async function shot(page: Page, cell: string, screen: string) {
  const path = join(shots!, `${before ? "before-" : ""}${cell}-${screen}.png`);
  await page.screenshot({ path, animations: "disabled" });
  saved.push(path);
}
async function sidebar(page: Page) {
  const panel = page.locator('[data-test-class="app-sidebar"]');
  await panel.waitFor({ state: "attached" });
  const row = page.locator('[data-tree-item="s:general"]').first();
  if (await panel.getAttribute("data-collapsed") === "true") await page.getByRole("button", { name: copy.titlebar.showLeftPanel, exact: true }).click();
  await row.waitFor({ state: "visible" });
  return row;
}
async function rowMenu(page: Page) {
  const row = await sidebar(page);
  await row.locator('[data-test-class~="tree-row"]').first().click({ button: "right" });
  await page.getByRole("menuitem", { name: copy.space.reference, exact: true }).waitFor();
}
async function archives(page: Page) {
  await sidebar(page);
  await page.getByRole("button", { name: copy.space.menu, exact: true }).click();
  await page.getByRole("menuitem", { name: new RegExp(copy.space.archives) }).click();
}
async function seed(server: NativeAppServerHandle) {
  await server.api("/messages", { method: "POST", body: JSON.stringify({
    chat_id: "general", text: "비우기 전 대화입니다.", client_message_id: crypto.randomUUID(),
  }) });
  const end = Date.now() + 30_000;
  for (;;) {
    const view = await server.api<SessionView>("/session-view?session_id=general");
    if (view.messages.some(message => message.role === "assistant" && message.status === "delivered")) return;
    assert(Date.now() < end, "stub answer did not settle");
    await new Promise(done => setTimeout(done, 100));
  }
}
async function capture(width: number, theme: "light" | "dark") {
  const cell = `${width}-${theme}`;
  const dir = mkdtempSync(join(tmpdir(), "butler-general-clear-"));
  const server = await createNativeAppServer({ butlerData: join(dir, "data"),
    uiRoot: resolve(process.env.BUTLER_CLEAR_CHAT_BEFORE_UI ?? "packages/butler-app/client/ui/dist"),
    config: { user: { name: "Smoke", language: "ko" } }, stubReply: () => "보관할 답변입니다.",
  });
  const browser = await launchSmokeBrowser();
  try {
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme }) });
    await seed(server);
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
    await server.signIn(page);
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
      key: LEGACY_FIRST_RUN_STORAGE_KEY, value: legacyFirstRunCompleteRecord(),
    });
    await page.goto(server.url);

    const row = await sidebar(page);
    await row.locator('[data-test-class~="tree-row"]').first().click();
    await page.getByText("비우기 전 대화입니다.", { exact: true }).waitFor();
    await rowMenu(page);
    if (before) {
      assert.equal(await page.getByRole("menuitem", { name: copy.clearChat.title }).count(), 0);
      await shot(page, cell, "row-menu");
      await page.keyboard.press("Escape");
      await shot(page, cell, "general");
      await archives(page);
      await page.getByText(copy.interfaceDetails.archivesEmpty, { exact: true }).waitFor();
      await shot(page, cell, "archives");
      return;
    }
    const clearItem = page.getByRole("menuitem", { name: copy.clearChat.title, exact: true });
    await clearItem.waitFor();
    await page.waitForFunction(label => document.querySelector(`[role="menuitem"]:not([data-disabled])`) &&
      [...document.querySelectorAll('[role="menuitem"]')].some(item => item.textContent?.includes(label) && !item.hasAttribute("data-disabled")), copy.clearChat.title);
    await shot(page, cell, "row-menu");
    await clearItem.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText(copy.clearChat.description, { exact: false }).waitFor();
    await shot(page, cell, "confirm");
    await dialog.getByRole("button", { name: copy.clearChat.manageMemory, exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByText(copy.settings.pageSections.instructions, { exact: true }).first().waitFor();
    const unchanged = await server.api<SessionView>("/session-view?session_id=general");
    assert(unchanged.messages.length >= 2, "Manage memory must preserve history");
    await page.keyboard.press("Escape");
    await (await sidebar(page)).locator('[data-test-class~="tree-row"]').first().click();
    await rowMenu(page);
    await clearItem.click();
    await dialog.getByRole("button", { name: copy.clearChat.clear, exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByText("비우기 전 대화입니다.", { exact: true }).waitFor({ state: "hidden" });
    assert.equal((await server.api<SessionView>("/session-view?session_id=general")).messages.length, 0);
    await shot(page, cell, "empty-general");
    await archives(page);
    const archived = (await server.api<ArchiveListView>("/archives")).sessions[0];
    assert(archived?.title.startsWith("일반 · "));
    await page.getByRole("button", { name: archived.title, exact: true }).waitFor();
    await shot(page, cell, "archives");
    await page.getByRole("button", { name: archived.title, exact: true }).click();
    await page.getByText("비우기 전 대화입니다.", { exact: true }).waitFor();
    await page.locator('[data-test-class="titlebar-title"]').filter({ hasText: archived.title }).waitFor();
    assert.equal(await page.locator('[data-test-class="titlebar-title"]').innerText(), archived.title);
    await shot(page, cell, "opened-archive");
  } finally { await browser.close(); await server.stop(); rmSync(dir, { recursive: true, force: true }); }
}
for (const width of [1280, 375]) for (const theme of ["light", "dark"] as const) await capture(width, theme);
console.log(JSON.stringify({ ok: true, before, screenshots: saved }));
