// Korean IME composition and caret restore in the real composer: Chromium, Firefox, WebKit.
// Firefox runs Gecko's TextInputProcessor under the Android/Windows-TSF commit policy
// (an outside text change commits the composition), so any composer write during
// composition splits syllables exactly as users see it. Chromium uses CDP IME input.
import { strict as assert } from "node:assert";
import { webkit, type CDPSession, type Page } from "playwright";
import { createNativeAppServer, type NativeAppServerHandle } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";
import { launchMarionetteFirefox, type Marionette } from "../support/firefox-marionette.ts";
import { composeLikeWebKit, hangulAutomaton, hangulKeys, installFirefoxIme } from "../support/hangul-ime.ts";

type Driver = {
  name: string;
  run<T>(body: string, args?: unknown[]): Promise<T>;
  click(x: number, y: number): Promise<void>;
  press(key: string): Promise<void>;
  commit(): Promise<void>;
  type(text: string): Promise<void>;
  /** Select all, then Backspace. */
  clear(): Promise<void>;
  /** Enter adds a line; with the shortcut modifier it sends. */
  enter(withModifier: boolean): Promise<void>;
  undo(): Promise<void>;
  /** Text/selection changes the IME saw during composition that it did not cause (Firefox only). */
  external(): Promise<string[]>;
};

// Records, for every composition input, whether the editor text equals the text around the
// composition at compositionstart plus the composition string, and DOM selection writes made
// while composing. Capture listeners run before the editor's own handlers.
const PROBE = `
if (window.__imeProbe) return true;
const editor = () => document.querySelector('[contenteditable="true"]');
const split = () => {
  const el = editor(); const s = getSelection();
  if (!el || !s.rangeCount || !el.contains(s.anchorNode)) return null;
  const r = s.getRangeAt(0); const pre = document.createRange(); const post = document.createRange();
  pre.selectNodeContents(el); pre.setEnd(r.startContainer, r.startOffset);
  post.selectNodeContents(el); post.setStart(r.endContainer, r.endOffset);
  return [pre.toString(), post.toString()];
};
const probe = window.__imeProbe = { composing: false, around: null, violations: [], selectionWrites: [] };
addEventListener("compositionstart", e => { if (e.target === editor()) { probe.composing = true; probe.around = split(); } }, true);
addEventListener("compositionend", () => { probe.composing = false; }, true);
addEventListener("input", e => {
  if (e.target !== editor() || e.inputType !== "insertCompositionText" || !probe.around) return;
  const expected = probe.around[0] + (e.data ?? "") + probe.around[1];
  if (editor().textContent !== expected) probe.violations.push({ actual: editor().textContent, expected });
}, true);
for (const name of ["setBaseAndExtent", "addRange", "removeAllRanges", "collapse", "extend", "selectAllChildren"]) {
  const original = Selection.prototype[name];
  Selection.prototype[name] = function (...args) { if (probe.composing) probe.selectionWrites.push(name); return original.apply(this, args); };
}
return true;`;

const STATE = `
const el = document.querySelector('[contenteditable="true"]'); const s = getSelection();
let caret = null;
if (el && s.rangeCount && el.contains(s.focusNode)) { const r = document.createRange(); r.selectNodeContents(el); r.setEnd(s.focusNode, s.focusOffset); caret = r.toString().length; }
const probe = window.__imeProbe;
const out = { text: el?.innerText ?? null, caret, focused: document.activeElement === el,
  folded: !!document.querySelector('[data-slot="composer-compact-preview"]')?.getClientRects().length,
  violations: probe.violations.splice(0), selectionWrites: probe.selectionWrites.splice(0) };
return out;`;

type State = { text: string | null; caret: number | null; focused: boolean; folded: boolean; violations: unknown[]; selectionWrites: string[] };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const TARGET = "한글 테스트";

async function waitFor(driver: Driver, body: string, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await driver.run<boolean>(body))) {
    assert(Date.now() < deadline, `${driver.name}: timed out waiting for ${label}`);
    await sleep(50);
  }
}
const center = (driver: Driver, selector: string) => driver.run<{ x: number; y: number } | null>(
  `const e = document.querySelector(arguments[0]); if (!e || !e.getClientRects().length) return null;
   const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`, [selector]);
const editorFocused = "return document.activeElement?.getAttribute('contenteditable') === 'true';";

async function blur(driver: Driver): Promise<void> {
  const window = await driver.run<{ x: number; y: number }>("const r = document.querySelector('[data-test-class=mac-window]').getBoundingClientRect(); return { x: r.left + 700, y: r.top + 100 };");
  await driver.click(window.x, window.y);
  await waitFor(driver, "return document.activeElement?.getAttribute('contenteditable') !== 'true';", "blur");
  await sleep(200);
}

async function openComposer(driver: Driver): Promise<void> {
  const preview = await center(driver, '[data-slot="composer-compact-preview"]');
  if (preview) await driver.click(preview.x, preview.y);
  await waitFor(driver, editorFocused, "composer focus");
}

async function clearDraft(driver: Driver): Promise<void> {
  await openComposer(driver);
  await driver.clear();
  await waitFor(driver, "return document.querySelector('[contenteditable=true]').textContent === '';", "empty draft");
  // Let the browser report the deletion to the IME before composing starts.
  await sleep(200);
  await driver.run<State>(STATE);
}

async function typeKorean(driver: Driver, delayMs: number, text = TARGET, settleMs = 300): Promise<State> {
  for (const key of hangulKeys(text)) { await driver.press(key); await sleep(delayMs); }
  await driver.commit();
  await sleep(settleMs);
  return await driver.run<State>(STATE);
}

const JAMO = /[\u3131-\u318e]/u;

// One undo after composing removes whole syllables, never part of one.
async function undo(driver: Driver): Promise<void> {
  await clearDraft(driver);
  await driver.type("ab ");
  await sleep(200);
  await typeKorean(driver, 80, "한글");
  await driver.undo();
  await sleep(200);
  const text = (await driver.run<State>(STATE)).text ?? "";
  assert(!JAMO.test(text) && "ab 한글".startsWith(text) && text !== "ab 한글", `${driver.name} undo: ${JSON.stringify(text)}`);
}

// Composing over a selected word replaces it, in place.
async function overSelection(driver: Driver): Promise<void> {
  await clearDraft(driver);
  await driver.type("ab cd");
  await driver.run("const t = document.createTreeWalker(document.querySelector('[contenteditable=true]'), NodeFilter.SHOW_TEXT).nextNode(); getSelection().setBaseAndExtent(t, 3, t, 5); return true;");
  await sleep(300);
  await driver.external();
  await driver.run(STATE);
  const state = await typeKorean(driver, 40, "한글");
  const external = await driver.external();
  const seen = JSON.stringify({ ...state, external });
  assert.deepEqual(external, [], `${driver.name} over a selection: the IME saw outside changes ${seen}`);
  assert.deepEqual(state.violations, [], `${driver.name} over a selection: text changed while composing ${seen}`);
  assert.equal(state.text, "ab 한글", `${driver.name} over a selection: replaced by composed syllables ${seen}`);
}

// Send keys the IME consumes while composing do not send.
async function keysWhileComposing(driver: Driver, server: NativeAppServerHandle): Promise<void> {
  await clearDraft(driver);
  const calls = server.stubModelCalls.length;
  for (const key of hangulKeys("한")) { await driver.press(key); await sleep(40); }
  await driver.enter(true);
  await driver.enter(false);
  await sleep(500);
  assert.equal(server.stubModelCalls.length, calls, `${driver.name}: Enter while composing sent a message`);
  await driver.commit();
  await sleep(300);
}

// A new line starts with no text node to compose in.
async function afterLineBreak(driver: Driver): Promise<void> {
  await clearDraft(driver);
  await typeKorean(driver, 40, "한글");
  await driver.enter(false);
  await sleep(200);
  await driver.external();
  const state = await typeKorean(driver, 40, "테스트");
  const external = await driver.external();
  const seen = JSON.stringify({ ...state, external });
  assert.deepEqual(external, [], `${driver.name} after a line break: the IME saw outside changes ${seen}`);
  assert.equal(state.text, "한글\n테스트", `${driver.name} after a line break: composed syllables ${seen}`);
  assert.deepEqual(state.violations, [], `${driver.name} after a line break: text changed while composing ${seen}`);
}

// The send shortcut right after a commit, before the IME counts as idle, sends the
// composed text of an empty line and clears the composer.
async function send(driver: Driver, server: NativeAppServerHandle): Promise<void> {
  await clearDraft(driver);
  await typeKorean(driver, 40, "한글", 0);
  const calls = server.stubModelCalls.length;
  await driver.enter(true);
  const deadline = Date.now() + 15_000;
  while (server.stubModelCalls.length === calls) {
    assert(Date.now() < deadline, `${driver.name}: the send shortcut did not send`);
    await sleep(100);
  }
  const request = JSON.stringify(server.stubModelCalls.at(-1)!.messages);
  assert(request.includes("한글") && !JAMO.test(request), `${driver.name}: sent the composed text ${request.slice(-300)}`);
  await waitFor(driver, "return document.querySelector('[contenteditable=true]')?.textContent === '';", "composer cleared after send");
}

async function composition(driver: Driver, label: string, delayMs: number): Promise<void> {
  await clearDraft(driver);
  await driver.external();
  const state = await typeKorean(driver, delayMs);
  const external = await driver.external();
  const seen = JSON.stringify({ ...state, external });
  assert.deepEqual(external, [], `${driver.name} ${label}: the IME saw outside changes during composition ${seen}`);
  assert.deepEqual(state.violations, [], `${driver.name} ${label}: text outside the composition changed while composing ${seen}`);
  assert.deepEqual(state.selectionWrites, [], `${driver.name} ${label}: the composer moved the DOM selection while composing ${seen}`);
  assert.equal(state.text, TARGET, `${driver.name} ${label}: composed syllables ${seen}`);
  assert.equal(state.caret, TARGET.length, `${driver.name} ${label}: caret after the composed text`);
}

async function refocus(driver: Driver, label: string, target: () => Promise<{ x: number; y: number } | null>): Promise<void> {
  await clearDraft(driver);
  await typeKorean(driver, 40);
  const draft = (await driver.run<State>(STATE)).text!;
  await blur(driver);
  const point = await target();
  assert(point, `${driver.name} ${label}: refocus target is visible`);
  await driver.click(point.x, point.y);
  await waitFor(driver, editorFocused, `${label} focus`);
  await sleep(300);
  const state = await driver.run<State>(STATE);
  assert.equal(state.caret, draft.length, `${driver.name} ${label}: caret returns to the end ${JSON.stringify({ draft, ...state })}`);
  await driver.type("x");
  await sleep(100);
  assert.equal((await driver.run<State>(STATE)).text, `${draft}x`, `${driver.name} ${label}: typing continues at the end`);
}

// A card point that is neither the editor, the preview, nor a control.
const cardPadding = (driver: Driver) => () => driver.run<{ x: number; y: number } | null>(`
  const card = document.querySelector('[data-test-class="composer-card"]'); const r = card.getBoundingClientRect();
  for (const [x, y] of [[r.left + 6, r.top + r.height / 2], [r.left + r.width / 2, r.bottom - 4], [r.left + r.width / 2, r.top + 4]]) {
    const hit = document.elementFromPoint(x, y);
    if (hit && card.contains(hit) && !hit.closest("[contenteditable='true'],button,[data-slot='composer-compact-preview']")) return { x, y };
  }
  return null;`);

async function scenarios(driver: Driver, server: NativeAppServerHandle): Promise<void> {
  await waitFor(driver, "return !!document.querySelector('[data-slot=composer-compact-preview]');", "composer");
  await driver.run(PROBE);
  await composition(driver, "human speed", 80);
  await composition(driver, "fast typing", 20);
  await afterLineBreak(driver);
  await refocus(driver, "preview refocus", () => center(driver, '[data-slot="composer-compact-preview"]'));
  await refocus(driver, "card padding refocus", cardPadding(driver));
  await undo(driver);
  await overSelection(driver);
  await keysWhileComposing(driver, server);
  await send(driver, server);
  console.log(JSON.stringify({ browser: driver.name, ok: true, cases: 9 }));
}

async function chromiumDriver(page: Page, cdp: CDPSession): Promise<Driver> {
  const ime = hangulAutomaton();
  let composing = false;
  return {
    name: "chromium",
    run: (body, args = []) => page.evaluate(`(function () { ${body} }).apply(null, ${JSON.stringify(args)})`),
    click: (x, y) => page.mouse.click(x, y),
    async press(key) {
      const step = ime.press(key);
      if (step.literal) {
        if (composing) await cdp.send("Input.insertText", { text: step.commit });
        composing = false;
        await page.keyboard.press(step.literal === " " ? "Space" : step.literal);
        return;
      }
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Process", code: "KeyA", windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
      if (step.commit && composing) await cdp.send("Input.insertText", { text: step.commit });
      await cdp.send("Input.imeSetComposition", { text: step.compose, selectionStart: step.compose.length, selectionEnd: step.compose.length });
      composing = true;
    },
    async commit() { if (composing) await cdp.send("Input.insertText", { text: ime.text() }); composing = false; ime.reset(); },
    type: (text) => page.keyboard.type(text),
    async clear() { await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("Backspace"); },
    enter: (withModifier) => page.keyboard.press(withModifier ? "ControlOrMeta+Enter" : "Enter"),
    undo: () => page.keyboard.press("ControlOrMeta+z"),
    external: async () => [],
  };
}

async function runChromium(server: NativeAppServerHandle): Promise<void> {
  const browser = await launchSmokeBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await server.signIn(page);
    await page.goto(server.url);
    await scenarios(await chromiumDriver(page, await page.context().newCDPSession(page)), server);
  } finally { await browser.close(); }
}

async function runFirefox(server: NativeAppServerHandle): Promise<void> {
  const firefox = await launchMarionetteFirefox();
  try {
    const marionette: Marionette = firefox.marionette;
    await marionette.navigate(await server.connectUrl());
    await marionette.navigate(server.url);
    const ime = await installFirefoxIme(marionette);
    await scenarios({
      name: `firefox ${firefox.version}`,
      run: (body, args) => marionette.run("content", body, args),
      click: (x, y) => marionette.click(x, y),
      press: ime.press, commit: ime.commit, type: ime.type, clear: ime.clear, enter: ime.enter, undo: ime.undo, external: ime.external,
    }, server);
  } finally { await firefox.close(); }
}

// WebKit has no IME automation: replay its event order for a commit on an empty line and in text.
async function runWebKit(server: NativeAppServerHandle): Promise<void> {
  const browser = await webkit.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await server.signIn(page);
    await page.goto(server.url);
    await page.locator('[data-slot="composer-compact-preview"]').click();
    await page.waitForFunction(() => document.activeElement?.getAttribute("contenteditable") === "true");
    const text = () => page.evaluate(() => document.querySelector("[contenteditable=true]")!.textContent);
    await composeLikeWebKit(page, ["ㅎ", "하", "한"]);
    await sleep(300);
    assert.equal(await text(), "한", "webkit: commit on an empty line keeps the text");
    await page.keyboard.type("ab");
    await composeLikeWebKit(page, ["ㄱ", "그", "글"]);
    await sleep(300);
    assert.equal(await text(), "한ab글", "webkit: commit in text keeps the text");
    console.log(JSON.stringify({ browser: `webkit ${browser.version()} (replayed events)`, ok: true, cases: 2 }));
  } finally { await browser.close(); }
}

const server = await createNativeAppServer({ config: { user: { name: "Smoke", language: "en" } } });
try {
  const only = process.env.BUTLER_SMOKE_BROWSER;
  assert(!only || ["chromium", "firefox", "webkit"].includes(only), `Unknown smoke browser: ${only}`);
  if (!only || only === "chromium") await runChromium(server);
  if (!only || only === "firefox") await runFirefox(server);
  if (!only || only === "webkit") await runWebKit(server);
} finally {
  await server.stop();
}
