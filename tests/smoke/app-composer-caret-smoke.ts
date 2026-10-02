// Real composer focus/selection through browser input; no provider calls needed.
import { strict as assert } from "node:assert";
import { chromium } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";

const server = await createNativeAppServer({ config: { user: { name: "Smoke", language: "en" } } });
const browser = await chromium.launch({ headless: true });
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
  await cdp.send("Input.imeSetComposition", { text: "한", selectionStart: 1, selectionEnd: 1 });
  await page.keyboard.press("ControlOrMeta+Shift+E");
  await cdp.send("Input.insertText", { text: "한" });
  assert.equal(await editor.innerText(), "안녕하세요 hello\n두 번째 줄X한", "shortcut does not disturb Korean composition");
  await cdp.detach();
  await editor.fill("안녕하세요 hello");
  await blur();
  await padding();
  // Collapse/reopen moves the card; locate text after the real expansion settles.
  await page.waitForFunction(() => document.getAnimations().every((animation) =>
    animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
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
  console.log(JSON.stringify({ ok: true, cases: 7, modelCalls: server.stubModelCalls.length }));
} finally {
  await browser.close();
  await server.stop();
}
