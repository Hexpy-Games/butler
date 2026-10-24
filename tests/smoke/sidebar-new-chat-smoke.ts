// Sidebar new-chat entry points: the Space header's new-chat button (beside the
// folder menu), "새 대화" first in project and group menus, a group draft that
// names its target in the titlebar, the session landing in that group once the
// first message is sent, and the default channel labelled "대화".
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Locator, Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";

const output = process.env.BUTLER_SMOKE_SCREENSHOTS;
assert(output, "Set BUTLER_SMOKE_SCREENSHOTS to a temporary screenshot directory");
mkdirSync(output, { recursive: true });
const server = await createNativeAppServer({ uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist") });
const browser = await launchSmokeBrowser();
const screenshots: string[] = [];

interface SpaceView { revision: number; nodes: Array<{ key: string; parentKey: string | null; position: number }> }
const space = async () => (await server.api<{ space: SpaceView }>("/navigation")).space;
async function group(title: string, parentKey: string | null): Promise<string> {
  const created = await server.api<{ groupId: string }>("/space/groups", { method: "POST",
    body: JSON.stringify({ expectedRevision: (await space()).revision, title, parentKey }) });
  return created.groupId;
}
const children = (view: SpaceView, parent: string) =>
  view.nodes.filter(node => node.parentKey === parent).sort((a, b) => a.position - b.position).map(node => node.key);

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every(animation =>
    // Scroll-driven animations follow scroll position, not time, and never finish.
    animation.timeline !== document.timeline || animation.effect?.getTiming().iterations === Infinity ||
      animation.playState !== "running"));
}
async function shot(page: Page, name: string) {
  await settle(page);
  const path = join(output!, `${name}.png`);
  await page.screenshot({ path });
  screenshots.push(path);
}

const sidebar = (page: Page) => page.locator('[data-test-class="app-sidebar"]');
const folderButton = (page: Page) => sidebar(page).getByRole("button", { name: "스페이스 메뉴", exact: true });
const newChatButton = (page: Page) => folderButton(page).locator("xpath=preceding-sibling::button[1]");
// The nearest tree row around the title (a group row also contains its children).
const row = (page: Page, title: string) => sidebar(page).getByText(title, { exact: true }).first()
  .locator('xpath=ancestor::*[contains(concat(" ", @data-test-class, " "), " tree-row ")][1]');

async function open(page: Page, width: number, theme: string) {
  await page.setViewportSize({ width, height: 900 });
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme }) });
  await page.goto(server.url);
  await page.locator('[data-test-class="composer-card"]').waitFor();
  const show = page.getByRole("button", { name: "사이드바 보기", exact: true });
  if (await show.isVisible()) await show.click();
  await folderButton(page).waitFor();
}

async function checkHeader(page: Page, prefix: string) {
  assert.equal(await newChatButton(page).getAttribute("aria-label"), "새 대화");
  const [chat, folder] = [await newChatButton(page).boundingBox(), await folderButton(page).boundingBox()];
  assert(chat && folder && chat.width === folder.width && chat.height === folder.height, "header buttons share one size");
  assert(chat.x + chat.width <= folder.x, "new-chat button sits left of the folder menu");
  assert(await sidebar(page).getByText("대화", { exact: true }).first().isVisible(), "default channel reads 대화");
  assert.equal(await sidebar(page).getByText("일반", { exact: true }).count(), 0);
  await page.mouse.move(0, 0);
  await shot(page, `${prefix}-header`);
  await newChatButton(page).hover();
  await page.getByRole("tooltip", { name: "새 대화", exact: true }).waitFor();
  await shot(page, `${prefix}-hover-new-chat`);
  await folderButton(page).hover();
  await shot(page, `${prefix}-hover-folder`);
}

async function menuFirst(page: Page, target: Locator, viaContext: boolean) {
  if (viaContext) await target.click({ button: "right" });
  else { await target.hover(); await target.locator('button[aria-haspopup="menu"]').first().click(); }
  await page.getByRole("menu").waitFor();
  const items = await page.getByRole("menuitem").allTextContents();
  assert.equal(items[0]?.trim(), "새 대화", `menu starts with 새 대화: ${JSON.stringify(items)}`);
}

async function sendInDraft(page: Page, text: string, location: string, parent: string) {
  await page.locator('[data-test-class="titlebar-title"]').filter({ hasText: /새 (프로젝트 )?대화/u }).waitFor();
  assert.equal((await page.locator('[data-test-class="titlebar-subtitle"]').innerText()).trim(), location);
  const before = children(await space(), parent);
  const preview = page.locator('[data-slot="composer-compact-preview"]');
  if (await preview.isVisible()) await preview.click();
  await page.locator('[data-test-class="composer-card"] [contenteditable="true"]').focus();
  await page.keyboard.type(text);
  await page.locator('[data-test-class~="composer-send-button"]').click();
  let placed: string[] = before;
  for (let tries = 0; tries < 100 && placed.length === before.length; tries += 1) {
    await page.waitForTimeout(100);
    placed = children(await space(), parent);
  }
  assert.equal(placed.length, before.length + 1, `a session lands in ${parent}`);
  assert(!before.includes(placed[0]!), "the new session is the group's first child");
  return placed[0]!.slice(2);
}

try {
  const design = await group("디자인 리뷰", null);
  const project = (await server.api<{ project: { id: string } }>("/projects", { method: "POST",
    body: JSON.stringify({ source: "scratch", display_name: "버틀러 앱" }) })).project.id;
  const release = await group("출시 준비", `p:${project}`);
  await server.api("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: "여행 계획" }) });
  await server.api("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: "회의 메모", group_id: design }) });

  const page = await browser.newPage({ deviceScaleFactor: 2, reducedMotion: "reduce" });
  await server.signIn(page);
  for (const width of [1280, 375]) for (const theme of ["light", "dark"]) {
    await open(page, width, theme);
    await checkHeader(page, `after-${width}-${theme}`);
  }

  // English names the action "New chat" in the header button and the top-left entry alike.
  await page.setViewportSize({ width: 1280, height: 900 });
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en" }) });
  await page.goto(server.url);
  const english = sidebar(page).getByRole("button", { name: "Space menu", exact: true });
  await english.waitFor();
  assert.equal(await english.locator("xpath=preceding-sibling::button[1]").getAttribute("aria-label"), "New chat");
  assert.deepEqual((await page.getByRole("navigation", { name: "Start and search conversations", exact: true })
    .locator('[data-slot="nav-row-label"]').allTextContents()).slice(0, 1), ["New chat"]);
  assert(await sidebar(page).getByText("Chats", { exact: true }).first().isVisible(), "default channel reads Chats");

  await open(page, 1280, "light");
  await newChatButton(page).click();
  const current = page.getByRole("navigation", { name: "대화 시작과 검색", exact: true }).locator('[aria-current="page"]');
  assert.equal((await current.innerText()).trim(), "새 대화", "the header button opens the same draft as the top-left 새 대화");
  for (const theme of ["light", "dark"]) {
    await open(page, 1280, theme);
    await menuFirst(page, row(page, "버틀러 앱"), true);
    await shot(page, `after-1280-${theme}-project-menu`);
    await page.keyboard.press("Escape");
    await menuFirst(page, row(page, "디자인 리뷰"), false);
    await shot(page, `after-1280-${theme}-group-menu`);
    await page.keyboard.press("Escape");
  }

  await open(page, 1280, "light");
  await menuFirst(page, row(page, "디자인 리뷰"), true);
  await page.getByRole("menuitem", { name: "새 대화", exact: true }).click();
  await shot(page, "after-1280-light-group-draft");
  const chat = await sendInDraft(page, "그룹에서 시작한 대화", "디자인 리뷰", `g:${design}`);
  await sidebar(page).locator('[data-test-class~="tree-row"][aria-current="page"]').waitFor();
  await shot(page, "after-1280-light-group-chat-created");

  await menuFirst(page, row(page, "출시 준비"), true);
  await page.getByRole("menuitem", { name: "새 대화", exact: true }).click();
  const projectChat = await sendInDraft(page, "출시 체크리스트", "버틀러 앱 › 출시 준비", `g:${release}`);
  const sessions = await server.api<{ sessions: Array<{ id: string; project_id?: string }> }>(`/project-sessions?project_id=${project}`);
  assert(sessions.sessions.some(session => session.id === projectChat), "the project-group chat belongs to the project");
  await shot(page, "after-1280-light-project-group-chat-created");

  writeFileSync(join(output, "screenshots.txt"), `${screenshots.join("\n")}\n`);
  console.log(JSON.stringify({ ok: true, screenshots: screenshots.length, chat, projectChat,
    verified: ["header buttons", "default channel label", "English New chat labels", "project menu", "group menu", "group draft location", "group placement", "project group placement"] }));
} finally {
  await browser.close(); await server.stop();
}
