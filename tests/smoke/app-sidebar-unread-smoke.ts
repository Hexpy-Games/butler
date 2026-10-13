// Sidebar unread dot through the real native gateway and the built App UI:
// a reply in a background chat shows the dot, opening the chat clears it,
// reading on a second client clears it on the first (live `session.read`),
// and the read survives a gateway restart. Captures the sidebar with unread,
// running, pinned and folded-group states in both themes, desktop and mobile.
import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { createNativeAppServer, type NativeAppServerHandle, type StubModelRequest } from "../support/native-app-server.ts";
import { smokeBrowserArgs } from "../support/smoke-browser.ts";
import type { NavigationView, SessionSummary } from "../../packages/butler-app/client/ui/src/app/types.ts";

const UNREAD = "읽지 않음";
const HOLD = "[keep running]";
const output = process.env.BUTLER_SMOKE_SCREENSHOTS;
if (output) mkdirSync(output, { recursive: true });
const uiRoot = resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist");
const data = mkdtempSync(join(tmpdir(), "butler-unread-smoke-"));
const hold: { release?: () => void } = {};
const stubReply = async (call: StubModelRequest) => {
  if (Array.isArray(call.body.tools) && JSON.stringify(call.messages).includes(HOLD) && !hold.release) {
    await new Promise<void>((done) => { hold.release = done; });
  }
  return "Here is the summary you asked for.";
};
const start = () => createNativeAppServer({ uiRoot, butlerData: data, stubReply, config: { user: { name: "Smoke", language: "ko" } } });

type Chats = Record<"open" | "background" | "second" | "pinned" | "grouped" | "running", string>;

async function chat(server: NativeAppServerHandle, title: string): Promise<string> {
  const created = await server.api<{ session: SessionSummary }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title }) });
  return created.session.id;
}

async function say(server: NativeAppServerHandle, id: string, text: string): Promise<void> {
  await server.api("/messages", { method: "POST", body: JSON.stringify({ chat_id: id, text, client_message_id: crypto.randomUUID() }) });
}

async function summary(server: NativeAppServerHandle, id: string): Promise<SessionSummary> {
  const navigation = await server.api<NavigationView>("/navigation");
  const found = navigation.chats.find((session) => session.id === id);
  assert(found, `${id} is in navigation`);
  return found;
}

async function waitUnread(server: NativeAppServerHandle, id: string, unread: boolean): Promise<void> {
  const deadline = Date.now() + 60_000;
  while ((await summary(server, id)).unread !== unread) {
    assert(Date.now() < deadline, `${id} unread=${unread} within 60 s`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

async function space(server: NativeAppServerHandle, path: string, body: Record<string, unknown>) {
  const { space: view } = await server.api<NavigationView>("/navigation");
  return await server.api<{ groupId?: string; space: NavigationView["space"] }>(path, {
    method: "POST", body: JSON.stringify({ ...body, expectedRevision: view.revision }),
  });
}

async function seed(server: NativeAppServerHandle): Promise<Chats> {
  const chats: Chats = {
    open: await chat(server, "Planning notes"),
    background: await chat(server, "Background reply"),
    second: await chat(server, "Second device"),
    pinned: await chat(server, "Pinned digest"),
    grouped: await chat(server, "Grouped follow-up"),
    running: await chat(server, "Long task"),
  };
  for (const id of [chats.background, chats.pinned, chats.grouped]) await say(server, id, "Summarize the week.");
  for (const id of [chats.background, chats.pinned, chats.grouped]) await waitUnread(server, id, true);
  await space(server, "/space/pins", { nodeKey: `s:${chats.pinned}`, pinned: true });
  const group = await space(server, "/space/groups", { title: "Research", parentKey: null });
  const groupKey = group.space.nodes.find((node) => node.entityId === group.groupId)!.key;
  await space(server, "/space/moves", { sourceKey: `s:${chats.grouped}`, targetKey: groupKey, position: "inside" });
  await say(server, chats.running, `Keep working ${HOLD}`);
  return chats;
}

const row = (page: Page, title: string) =>
  page.locator(`[data-test-class="app-sidebar"] [data-test-class="tree-row"][aria-label="${title}"]`).last();
const dot = (page: Page, title: string) => row(page, title).locator('[data-slot="unread-dot"]');
const groupRow = (page: Page) =>
  page.locator('[data-test-class="app-sidebar"] [data-test-class="tree-row"][aria-expanded]', { hasText: "Research" });

async function open(browser: Browser, server: NativeAppServerHandle, width: number, title: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: 820 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("pageerror", error.message));
  await server.signIn(page);
  await page.goto(server.url);
  await showSidebar(page);
  await row(page, title).click();
  await rest(page);
  // Phones close the sidebar drawer when a chat opens; reopen it to see the rows.
  if (width < 640) {
    await page.locator('[data-test-class="app-sidebar"][data-collapsed="true"]').waitFor({ state: "attached" });
    await settle(page);
    await showSidebar(page);
    await settle(page);
  }
  return page;
}

async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((animation) =>
    animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
}

/** Hovering a row swaps its trailing marks for the row menu; park the pointer off the sidebar. */
async function rest(page: Page): Promise<void> {
  const viewport = page.viewportSize()!;
  await page.mouse.move(viewport.width - 8, viewport.height - 8);
}

async function showSidebar(page: Page): Promise<void> {
  const target = row(page, "Planning notes");
  const toggle = page.getByRole("button", { name: /^(사이드바 보기|Show sidebar)$/u }).first();
  for (const deadline = Date.now() + 30_000; !await target.isVisible(); await page.waitForTimeout(200)) {
    assert(Date.now() < deadline, "the sidebar opens");
    if (await toggle.isVisible()) await toggle.click();
  }
}

async function capture(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every((animation) =>
    animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
  // Stopped animations show the Spinner's static arc instead of a random frame.
  if (output) await page.screenshot({ path: join(output, `${name}.png`), animations: "disabled" });
}

async function captureMatrix(browser: Browser, server: NativeAppServerHandle): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme }) });
    for (const width of [1280, 390]) {
      const page = await open(browser, server, width, "Planning notes");
      await groupRow(page).click();
      await rest(page);
      await groupRow(page).locator('[data-slot="unread-dot"]').waitFor();
      assert.equal(await groupRow(page).getAttribute("aria-description"), UNREAD, "folded group names its unread chat");
      await row(page, "Long task").locator('[data-slot="spinner"]').waitFor();
      assert.equal(await dot(page, "Long task").count(), 0, "running shows the spinner, not the dot");
      await dot(page, "Pinned digest").waitFor();
      await dot(page, "Background reply").waitFor();
      assert.equal(await dot(page, "Background reply").getAttribute("aria-label"), UNREAD);
      assert.equal(await row(page, "Background reply").getAttribute("aria-description"), UNREAD);
      assert.equal(await dot(page, "Planning notes").count(), 0, "a chat without replies is read");
      await capture(page, `sidebar-${width >= 640 ? "desktop" : "mobile"}-${theme}`);
      await page.context().close();
    }
  }
}

async function readFlow(browser: Browser, server: NativeAppServerHandle, chats: Chats): Promise<void> {
  const first = await open(browser, server, 1280, "Planning notes");
  await dot(first, "Background reply").waitFor();
  await row(first, "Background reply").click();
  await rest(first);
  await dot(first, "Background reply").waitFor({ state: "detached" });
  await waitUnread(server, chats.background, false);
  const second = await open(browser, server, 1280, "Planning notes");
  await say(server, chats.second, "Any news?");
  await waitUnread(server, chats.second, true);
  await dot(first, "Second device").waitFor();
  await dot(second, "Second device").waitFor();
  await row(second, "Second device").click();
  await rest(second);
  await dot(first, "Second device").waitFor({ state: "detached", timeout: 5_000 });
  await waitUnread(server, chats.second, false);
  await capture(first, "read-on-second-client");
  await first.context().close();
  await second.context().close();
}

const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });
let server = await start();
try {
  const chats = await seed(server);
  await captureMatrix(browser, server);
  await readFlow(browser, server, chats);
  hold.release?.();
  await waitUnread(server, chats.running, true);
  await server.stop();
  server = await start();
  const page = await open(browser, server, 1280, "Planning notes");
  await dot(page, "Grouped follow-up").or(groupRow(page).locator('[data-slot="unread-dot"]')).first().waitFor();
  for (const title of ["Background reply", "Second device"]) assert.equal(await dot(page, title).count(), 0, `${title} stays read after restart`);
  await dot(page, "Long task").waitFor();
  await capture(page, "after-restart");
  await page.context().close();
  await server.stop();
  const db = new Database(join(data, "app-server/butler-client.sqlite"), { readonly: true });
  const reads = db.query("SELECT COUNT(*) AS n FROM events WHERE type='session.read'").get() as { n: number };
  db.close();
  assert.equal(reads.n, 2, "one write per read: opening two chats wrote two read events");
  console.log(JSON.stringify({ ok: true, captures: output ?? null, readEvents: reads.n }));
} finally {
  await browser.close();
  await server.stop().catch(() => undefined);
  rmSync(data, { recursive: true, force: true });
}
