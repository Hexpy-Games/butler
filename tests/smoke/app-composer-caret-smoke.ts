import { launchSmokeBrowser } from "../support/smoke-browser.ts";
// Real composer focus/selection through browser input; no provider calls needed.
import { strict as assert } from "node:assert";
import { createNativeAppServer } from "../support/native-app-server.ts";

const server = await createNativeAppServer({ config: { user: { name: "Smoke", language: "en" } } });
const browser = await launchSmokeBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await server.signIn(page);
  await page.goto(server.url);
  await page.locator('[data-slot="composer-compact-preview"]').click();
  const editor = page.locator('[contenteditable="true"]');
  const card = page.locator('[data-test-class="composer-card"]');
  const blur = () => page.locator('[data-test-class="mac-window"]').click({ position: { x: 700, y: 100 } });
  const padding = async () => {
    if (await page.locator('[data-slot="composer-compact-preview"]').isVisible()) {
      await page.locator('[data-slot="composer-compact-preview"]').click();
    } else await card.click({ position: { x: 4, y: 4 } });
    await page.waitForFunction(() => document.activeElement?.getAttribute("contenteditable") === "true");
  };
  await editor.fill("안녕하세요 hello");
  await editor.press("End");
  await blur();
  await padding();
  await page.keyboard.type("X");
  assert.equal(await editor.innerText(), "안녕하세요 helloX", "padding re-focus preserves end");
  // Save a middle caret, then restore it by clicking the chrome rather than text.
  await editor.press("Home");
  await editor.press("ArrowRight");
  await blur();
  await padding();
  await page.keyboard.type("X");
  assert.equal(await editor.innerText(), "안X녕하세요 helloX", "padding restores previous caret");
  await editor.fill("안녕하세요 hello\n두 번째 줄");
  await editor.press("Home");
  await blur();
  await page.keyboard.press("ControlOrMeta+Shift+E");
  await page.keyboard.type("X");
  assert.equal(await editor.innerText(), "안녕하세요 hello\n두 번째 줄X", "shortcut focuses multiline draft at end");
  // Chromium CDP drives real composition events and Lexical's IME handling.
  const cdp = await page.context().newCDPSession(page);
  await editor.evaluate(element => {
    (window as unknown as { compositionEvents: string[] }).compositionEvents = [];
    for (const name of ["compositionstart", "compositionupdate", "compositionend"]) {
      element.addEventListener(name, event => (window as unknown as { compositionEvents: string[] }).compositionEvents.push(`${name}:${(event as CompositionEvent).data}`));
    }
  });
  for (const text of ["ㅎ", "하", "한"]) {
    await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
    const caret = await editor.evaluate(element => {
      const selection = window.getSelection()!;
      const node = selection.focusNode!;
      const end = (node.textContent ?? "").replace(/\u200b$/u, "").length;
      const glyph = document.createRange();
      glyph.setStart(node, end - 1); glyph.setEnd(node, end);
      const rect = glyph.getBoundingClientRect();
      const caret = selection.getRangeAt(0).cloneRange(); caret.collapse(false);
      return { offset: selection.focusOffset, end, delta: caret.getBoundingClientRect().left - rect.right };
    });
    assert.equal(caret.offset, caret.end, `selection follows ${text}`);
    assert(Math.abs(caret.delta) < 1, `caret follows composing glyph ${text}: ${JSON.stringify(caret)}`);
  }
  await page.keyboard.press("ControlOrMeta+Shift+E");
  await cdp.send("Input.insertText", { text: "한" });
  assert.equal(await editor.innerText(), "안녕하세요 hello\n두 번째 줄X한", "shortcut does not disturb Korean composition");
  const compositionEvents = await page.evaluate(() => (window as unknown as { compositionEvents: string[] }).compositionEvents);
  assert(compositionEvents.some(event => event.startsWith("compositionstart:")));
  assert(compositionEvents.includes("compositionupdate:한"));
  assert(compositionEvents.includes("compositionend:한"));
  await cdp.detach();
  await editor.fill("안녕하세요 hello");
  await blur();
  await padding();
  await page.evaluate(() => document.fonts.ready);
  // Hit-test the focused editor after reopening, using its current font metrics.
  const point = await editor.evaluate(element => {
    const range = document.createRange();
    const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
    range.setStart(text, 6); range.setEnd(text, 7);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + 1, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(point.x, point.y);
  const offset = await editor.evaluate(element => {
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(element);
    range.setEnd(selection.focusNode!, selection.focusOffset);
    return range.toString().length;
  });
  assert(offset > 0 && offset < 11, "text click places a middle caret");
  await page.keyboard.type("X");
  assert.equal(await editor.innerText(), `안녕하세요 hello`.slice(0, offset) + "X" + `안녕하세요 hello`.slice(offset));
  await editor.press("Home");
  await page.keyboard.press("ControlOrMeta+K");
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement?.getAttribute("contenteditable") === "true");
  await page.keyboard.type("Y");
  assert((await editor.innerText()).endsWith("Y"), "closing a panel returns focus at end");
  await editor.press("Home");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.keyboard.type("Z");
  assert((await editor.innerText()).endsWith("YZ"), "window activation places caret at end");
  // Folded preview: a long draft truncates with an ellipsis inside the toolbar; + and send keep their boxes.
  const preview = page.locator('[data-slot="composer-compact-preview"]');
  const fold = async () => {
    await page.locator('[data-test-class="new-chat-empty-state"] h2').click();
    await preview.waitFor({ state: "visible" });
  };
  const toolbarGeometry = () => page.evaluate(() => {
    const toolbar = document.querySelector<HTMLElement>('[data-test-class="composer-toolbar"]')!;
    const compact = toolbar.querySelector<HTMLElement>('[data-slot="composer-compact-preview"]')!;
    const box = (element: Element) => {
      const { left, right, top, width, height } = element.getBoundingClientRect();
      return { left, right, top, width, height };
    };
    const buttons = [...toolbar.querySelectorAll<HTMLElement>("button")].filter((button) => button !== compact && button.getClientRects().length > 0);
    const style = getComputedStyle(compact);
    const next = buttons.find((button) => button.getBoundingClientRect().left >= compact.getBoundingClientRect().right - 0.5);
    return {
      toolbar: box(toolbar), contentRight: toolbar.getBoundingClientRect().right - parseFloat(getComputedStyle(toolbar).paddingRight),
      preview: box(compact), nextLeft: next ? next.getBoundingClientRect().left : null, buttons: buttons.map(box),
      overflowing: compact.scrollWidth > compact.clientWidth + 1,
      ellipsis: style.textOverflow === "ellipsis" && style.overflowX === "hidden" && style.whiteSpace === "nowrap",
    };
  });
  const drafts = {
    ko: "주간 디자인 리뷰 메모를 정리하고 남은 작업을 담당자별로 나눈 다음 다음 주 일정에 맞춰 우선순위를 다시 매겨 주세요. 길게 이어지는 초안입니다.",
    en: "Summarize the weekly design review notes, split the remaining work by owner and re-rank it against next week's schedule. A long draft.",
  };
  const ellipsis: Record<string, unknown> = {};
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 800 });
    await padding();
    await editor.fill("");
    await fold();
    const empty = await toolbarGeometry();
    for (const [language, draft] of Object.entries(drafts)) {
      await padding();
      await editor.fill(draft);
      await fold();
      const folded = await toolbarGeometry();
      const key = `${width}-${language}`;
      ellipsis[key] = { previewRight: folded.preview.right, nextLeft: folded.nextLeft, contentRight: folded.contentRight, overflowing: folded.overflowing };
      assert(folded.preview.right <= (folded.nextLeft ?? folded.contentRight) + 0.5, `${key}: preview stays inside the toolbar's free space ${JSON.stringify(folded)}`);
      assert(folded.preview.right <= folded.contentRight + 0.5, `${key}: preview never passes the card edge`);
      assert(folded.overflowing && folded.ellipsis, `${key}: the long draft truncates with an ellipsis`);
      assert.equal(folded.preview.height, empty.preview.height, `${key}: preview keeps one line`);
      assert.deepEqual(folded.buttons.map(({ width, height }) => [width, height]), empty.buttons.map(({ width, height }) => [width, height]), `${key}: + and send keep their size`);
      assert.deepEqual(folded.toolbar, empty.toolbar, `${key}: the toolbar does not move`);
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  console.log(JSON.stringify({ ok: true, cases: 8, ellipsis, modelCalls: server.stubModelCalls.length }));
} finally {
  await browser.close();
  await server.stop();
}
