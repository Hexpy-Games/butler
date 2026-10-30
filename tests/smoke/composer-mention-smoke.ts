// The composer `@` mention menu against an isolated native gateway (temp BUTLER_DATA, free
// port, stub model): bare `@` order, typed ranking with bold matches, no match closes and
// Backspace reopens, ↑/↓ Enter Tab Esc and click, session and project chips, Korean IME
// (Enter right after a commit, a click mid-composition), and the references reaching the
// sent request and the model prompt.
// BUTLER_MENTION_SHOTS=<dir> also captures light/dark, ko/en, 1440/390 crops at 2x.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Browser, CDPSession, Locator, Page, Request } from "playwright";
import { createNativeAppServer, type NativeAppServerHandle } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";
import { MENTION_TITLES, mentionRecency, seedMentions, type MentionLocale, type MentionSeed } from "../support/composer-mention-fixtures.ts";

const shots = process.env.BUTLER_MENTION_SHOTS;
const dirs: string[] = [];
const servers: NativeAppServerHandle[] = [];
const MENU = '[data-test-class~="composer-mention-menu"]';

async function start(locale: MentionLocale) {
  const dir = mkdtempSync(join(tmpdir(), "butler-mention-"));
  dirs.push(dir);
  const server = await createNativeAppServer({
    butlerData: join(dir, "data"), uiRoot: resolve("packages/butler-app/client/ui/dist"),
    config: { user: { name: "Smoke", language: locale } }, stubReply: () => (locale === "ko" ? "확인했습니다." : "Checked."),
  });
  servers.push(server);
  return { server, seed: await seedMentions(server, locale) };
}

async function openApp(browser: Browser, server: NativeAppServerHandle, seed: MentionSeed, viewport: { width: number; height: number }, theme: "light" | "dark") {
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: theme }) });
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: "reduce" });
  await server.signIn(page);
  await page.goto(server.url);
  await page.locator('[data-test-class~="composer-card"]').waitFor();
  const show = page.getByRole("button", { name: /^(사이드바 보기|Show sidebar)$/u });
  if (await show.isVisible()) await show.click();
  const row = page.locator(`[data-tree-item="s:${seed.sessions.current}"] [data-test-class~="tree-row"]`).first();
  await row.click();
  await page.locator(`[data-tree-item="s:${seed.sessions.current}"] [aria-current="page"]`).first().waitFor({ state: "attached" });
  if (viewport.width < 640) {
    const hide = page.locator('[data-test-class~="chrome-floating-toggle-layer"]').getByRole("button", { name: /^(사이드바 숨기기|Hide sidebar)$/u });
    if (await hide.isVisible()) await hide.click();
  }
  await editorOf(page).waitFor();
  return page;
}

const editorOf = (page: Page) => page.locator('[data-test-class~="composer-card"] [contenteditable="true"]');

async function clear(page: Page) {
  const editor = editorOf(page);
  // A folded composer opens from its one-line preview.
  const preview = page.locator('[data-slot="composer-compact-preview"]');
  if (await preview.isVisible()) await preview.click();
  else await editor.click();
  await page.waitForFunction(() => document.activeElement?.getAttribute("contenteditable") === "true");
  await editor.press("ControlOrMeta+A");
  await editor.press("Backspace");
  await page.waitForFunction(() => document.querySelector('[data-test-class~="composer-card"] [contenteditable="true"]')?.textContent === "");
}

type Row = { title: string; meta: string; selected: boolean; marks: string[]; metaMarks: string[]; id: string };
async function rows(page: Page): Promise<Row[]> {
  await page.locator(MENU).waitFor();
  return page.locator(`${MENU} [role="option"]`).evaluateAll((options) => options.map((option) => {
    const [title, meta] = [...option.querySelectorAll(":scope > span:last-child > span")];
    return { title: title?.textContent ?? "", meta: meta?.textContent ?? "", selected: option.getAttribute("aria-selected") === "true", id: option.id,
      marks: [...(title?.querySelectorAll("mark") ?? [])].map((mark) => mark.textContent ?? ""),
      metaMarks: [...(meta?.querySelectorAll("mark") ?? [])].map((mark) => mark.textContent ?? "") };
  }));
}

const menuClosed = (page: Page) => page.locator(MENU).waitFor({ state: "detached" });
const chips = (scope: Locator) => scope.locator('[data-lexical-decorator="true"]');

async function bare(page: Page, server: NativeAppServerHandle, seed: MentionSeed) {
  await clear(page);
  await page.keyboard.type("@");
  const shown = await rows(page);
  assert.equal(shown.length, 7, "a bare @ lists seven items");
  assert.deepEqual(shown.map((row) => row.selected), [true, false, false, false, false, false, false], "the first row is highlighted");
  const recency = await mentionRecency(server, seed.titles.generalTitle);
  const byTitle = new Map([...recency.values()].map((item) => [item.title, item.recent]));
  assert(!shown.some((row) => row.title === seed.titles.current), "the current conversation is excluded");
  assert(shown.some((row) => row.title === seed.titles.generalTitle), "the general conversation shows as its localized name");
  const times = shown.map((row) => byTitle.get(row.title) ?? assert.fail(`unknown row ${row.title}`));
  assert.deepEqual([...times].sort().reverse(), times, `newest first: ${JSON.stringify(shown.map((row) => row.title))}`);
  const hidden = [...recency.values()].filter((item) => item.title !== seed.titles.current && !shown.some((row) => row.title === item.title));
  assert(hidden.every((item) => item.recent <= times.at(-1)!), "nothing newer is left out");
  assert(shown.every((row) => row.marks.length === 0), "no bold without a query");
}

async function typed(page: Page, seed: MentionSeed) {
  const { titles } = seed;
  await page.keyboard.type(titles.query);
  const shown = await rows(page);
  const recency = await mentionRecency(servers.at(-1)!, titles.generalTitle);
  const recent = (title: string) => [...recency.values()].find((item) => item.title === title)!.recent;
  const prefix = [titles.design, titles.projects.research].sort((a, b) => (recent(a) < recent(b) ? 1 : -1));
  assert.deepEqual(shown.map((row) => row.title), [...prefix, titles.composer, titles.landing, titles.interview],
    "title prefix, then a word, then inside the title, then only the project name; ties newest first");
  for (const row of shown.slice(0, 4)) assert.deepEqual(row.marks.map((mark) => mark.toLocaleLowerCase()), [titles.query], `bold match in ${row.title}`);
  assert.deepEqual(shown[4]!.metaMarks, [titles.projects.research.slice(0, titles.query.length)], "the project name match is bold");
  assert(shown[0]!.selected, "the first match is highlighted");
  return shown;
}

async function noMatchThenBackspace(page: Page, seed: MentionSeed) {
  await page.keyboard.type("zq");
  await menuClosed(page);
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(100);
  assert.equal(await page.locator(MENU).count(), 0, "still no match");
  await page.keyboard.press("Backspace");
  assert.equal((await rows(page)).length, 5, "deleting back to a match reopens the menu");
  assert.equal(await editorOf(page).textContent(), `@${seed.titles.query}`);
}

async function keys(page: Page, seed: MentionSeed) {
  const editor = editorOf(page);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  let shown = await rows(page);
  assert.equal(shown.findIndex((row) => row.selected), 2, "↓ twice highlights the third row");
  assert.equal(await editor.getAttribute("aria-activedescendant"), shown[2]!.id);
  await page.keyboard.press("ArrowUp");
  shown = await rows(page);
  assert.equal(shown.findIndex((row) => row.selected), 1, "↑ moves back");
  await page.keyboard.press("Escape");
  await menuClosed(page);
  assert.equal(await editor.textContent(), `@${seed.titles.query}`, "Escape leaves the typed text");
  assert.equal(await editor.getAttribute("aria-activedescendant"), null);
}

async function insertChips(page: Page, server: NativeAppServerHandle, seed: MentionSeed) {
  const { titles } = seed;
  const editor = editorOf(page);
  const calls = server.stubModelCalls.length;
  await clear(page);
  await page.keyboard.type(`@${titles.query}`);
  const first = (await rows(page))[0]!.title;
  await page.keyboard.press("Enter");
  await menuClosed(page);
  assert.equal(server.stubModelCalls.length, calls, "Enter in the menu does not send");
  assert.deepEqual(await chips(editor).allTextContents(), [first], "Enter inserts the highlighted conversation");
  assert(!(await editor.textContent())!.includes(`@${titles.query}`), "the typed @word is replaced");
  await page.keyboard.type(`@${titles.projectQuery}`);
  assert.equal((await rows(page))[0]!.title, titles.projects.research);
  await page.keyboard.press("Tab");
  await menuClosed(page);
  assert.deepEqual(await chips(editor).allTextContents(), [first, titles.projects.research], "Tab inserts the project chip");
  await page.keyboard.type(`@${titles.landingQuery}`);
  await page.locator(`${MENU} [role="option"]`).filter({ hasText: titles.landing }).click();
  await menuClosed(page);
  assert.deepEqual(await chips(editor).allTextContents(), [first, titles.projects.research, titles.landing], "a click inserts");
  return first;
}

/** Composes Hangul syllables through Chromium's IME path (as app-composer-ime-smoke does), uncommitted. */
async function compose(cdp: CDPSession, steps: string[]) {
  for (const step of steps) {
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Process", code: "KeyA", windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
    await cdp.send("Input.imeSetComposition", { text: step, selectionStart: step.length, selectionEnd: step.length });
  }
}

const JAMO = /[\u3131-\u318e]/u;

/** `@프`: Enter right after the IME commits, and a click on a row while it still composes. */
async function ime(page: Page, server: NativeAppServerHandle, seed: MentionSeed) {
  const { titles } = seed;
  const editor = editorOf(page);
  const cdp = await page.context().newCDPSession(page);
  const calls = server.stubModelCalls.length;
  const recency = await mentionRecency(server, titles.generalTitle);
  const recent = (title: string) => [...recency.values()].find((item) => item.title === title)!.recent;
  const expected = [titles.prompt, titles.projects.prototype].sort((a, b) => (recent(a) < recent(b) ? 1 : -1));

  await clear(page);
  await page.keyboard.type("@");
  await compose(cdp, ["ㅍ", titles.imeQuery]);
  // The commit and Enter go out back to back: Enter lands before the menu can re-render the committed syllable.
  const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await Promise.all([
    cdp.send("Input.insertText", { text: titles.imeQuery }),
    cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...enter, text: "\r" }),
    cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...enter }),
  ]);
  await menuClosed(page);
  assert.deepEqual(await chips(editor).allTextContents(), [expected[0]], "Enter right after the commit inserts the match for the committed syllable");
  const afterEnter = (await editor.textContent()) ?? "";
  assert.equal(afterEnter.trim(), expected[0], `the @word is replaced whole: ${JSON.stringify(afterEnter)}`);
  assert(!JAMO.test(afterEnter), "no split Hangul");
  assert.equal(server.stubModelCalls.length, calls, "Enter in the menu does not send");

  await clear(page);
  await page.keyboard.type("@");
  await compose(cdp, ["ㅍ", titles.imeQuery]);
  const shown = await rows(page);
  assert.deepEqual(shown.map((row) => row.title), expected, "a composing syllable is already the query");
  const project = shown.find((row) => row.title === titles.projects.prototype)!;
  assert.deepEqual(project.marks, [titles.imeQuery], "the matched title is bold");
  assert.deepEqual(project.metaMarks, [], "the Project label is never bold");
  await page.locator(`${MENU} [role="option"]`).filter({ hasText: titles.projects.prototype }).click();
  await page.waitForFunction((title) => [...document.querySelectorAll('[data-test-class~="composer-card"] [data-lexical-decorator="true"]')]
    .some((chip) => chip.textContent === title), titles.projects.prototype, { timeout: 5_000 });
  const afterClick = (await editor.textContent()) ?? "";
  assert.deepEqual(await chips(editor).allTextContents(), [titles.projects.prototype], "a click mid-composition inserts the clicked row");
  assert.equal(afterClick.trim(), titles.projects.prototype, `the @word is replaced whole: ${JSON.stringify(afterClick)}`);
  assert(!JAMO.test(afterClick), "no split Hangul");
  await cdp.detach();
}

async function send(page: Page, server: NativeAppServerHandle, seed: MentionSeed, first: string) {
  const sent = page.waitForRequest((request: Request) => request.method() === "POST" && new URL(request.url()).pathname === "/messages");
  await page.locator('[data-test-class~="composer-send-button"]').click();
  const body = (await sent).postDataJSON() as { content_parts: { parts: Array<Record<string, string>> } };
  const refs = body.content_parts.parts.filter((part) => part.type !== "text");
  const firstId = first === seed.titles.design ? seed.sessions.design : first === seed.titles.projects.research ? seed.projects.research : "";
  assert.deepEqual(refs.map((part) => [part.type, part.sessionId ?? part.projectId, part.titleSnapshot]), [
    [first === seed.titles.design ? "session_ref" : "project_ref", firstId, first],
    ["project_ref", seed.projects.research, seed.titles.projects.research],
    ["session_ref", seed.sessions.landing, seed.titles.landing],
  ], "the request carries the session and project references");
  const deadline = Date.now() + 60_000;
  let prompt = "";
  while (!prompt.includes(seed.projects.research)) {
    assert(Date.now() < deadline, "the model request carries the project reference");
    prompt = server.stubModelCalls.map((call) => JSON.stringify(call.messages)).find((text) => text.includes("Explicit user-selected project references")) ?? "";
    await page.waitForTimeout(200);
  }
  assert(prompt.includes("Explicit user-selected conversation references"), "conversation references reach the model too");
  const message = page.locator('[data-test-class="user-message-text"]').last();
  await message.getByText(seed.titles.projects.research, { exact: true }).waitFor();
  await message.getByRole("button", { name: seed.titles.projects.research }).waitFor();
}

async function crop(page: Page, name: string) {
  if (!shots) return;
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  const boxes = [await page.locator('[data-test-class~="composer-card"]').boundingBox(), await page.locator(MENU).boundingBox().catch(() => null)]
    .filter((box): box is NonNullable<typeof box> => Boolean(box));
  const x = Math.max(0, Math.min(...boxes.map((box) => box.x)) - 16), y = Math.max(0, Math.min(...boxes.map((box) => box.y)) - 16);
  const right = Math.min(page.viewportSize()!.width, Math.max(...boxes.map((box) => box.x + box.width)) + 16);
  const bottom = Math.min(page.viewportSize()!.height, Math.max(...boxes.map((box) => box.y + box.height)) + 16);
  await page.screenshot({ path: join(shots, `${name}.png`), clip: { x, y, width: right - x, height: bottom - y } });
}

async function screenshots(browser: Browser, locale: MentionLocale, server: NativeAppServerHandle, seed: MentionSeed) {
  for (const theme of ["light", "dark"] as const) {
    for (const [device, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
      const page = await openApp(browser, server, seed, viewport, theme);
      const tag = `${locale}-${theme}-${device}`;
      await clear(page);
      await page.keyboard.type("@");
      await rows(page);
      await crop(page, `bare-at-${tag}`);
      await page.keyboard.type(MENTION_TITLES[locale].query);
      await rows(page);
      await crop(page, `typed-${tag}`);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await crop(page, `keyboard-highlight-${tag}`);
      await page.keyboard.press("Enter");
      await menuClosed(page);
      await page.keyboard.type(locale === "ko" ? "내용을 요약해 줘" : "summarize it");
      await crop(page, `chip-inserted-${tag}`);
      await page.goto(`${server.url}?visual=design-system&page=blocks/SuggestionList&theme=${theme}&locale=${locale === "ko" ? "ko" : "en"}&width=${viewport.width < 640 ? 390 : "app"}`);
      const story = page.locator('[data-ds-story^="App items: the composer"]').first();
      await story.waitFor();
      await story.scrollIntoViewIfNeeded();
      await page.evaluate(() => document.fonts.ready);
      await story.screenshot({ path: join(shots!, `ds-view-${tag}.png`) });
      await page.close();
    }
  }
}

const browser = await launchSmokeBrowser();
try {
  const ko = await start("ko");
  const page = await openApp(browser, ko.server, ko.seed, { width: 1280, height: 860 }, "light");
  await bare(page, ko.server, ko.seed);
  await typed(page, ko.seed);
  await noMatchThenBackspace(page, ko.seed);
  await keys(page, ko.seed);
  await ime(page, ko.server, ko.seed);
  const first = await insertChips(page, ko.server, ko.seed);
  await send(page, ko.server, ko.seed, first);
  await page.close();
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await screenshots(browser, "ko", ko.server, ko.seed);
    const en = await start("en");
    await screenshots(browser, "en", en.server, en.seed);
  }
  console.log(JSON.stringify({ ok: true, service: "composer-mention-smoke", checks: [
    "bare-at-recent-order", "typed-ranking-bold", "no-match-closes-backspace-reopens", "arrows-escape",
    "enter-session-chip", "tab-project-chip", "click-inserts", "ime-enter-after-commit", "ime-click-mid-composition",
    "project-label-not-bold", "archived-project-excluded", "references-reach-request-and-prompt",
  ] }));
} finally {
  await browser.close();
  for (const server of servers) await server.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}
