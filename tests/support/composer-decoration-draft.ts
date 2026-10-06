import { strict as assert } from "node:assert";
import type { Page } from "playwright";

/** Real editor scroll and folded toolbar geometry; no pixel inspection. */
export async function verifyDecoratedDraft(page: Page, key: string, screenshot: string) {
  const editor = page.locator('[contenteditable="true"]');
  const draft = Array.from({ length: 80 }, (_, i) => `Draft line ${i + 1}: 벚꽃 Cherry blossom`).join("\n");
  await editor.fill(draft);
  assert.equal(await editor.innerText(), draft, `${key}: complete draft filled`);
  await editor.press("ControlOrMeta+End");
  await editor.press("ControlOrMeta+ArrowDown");
  await editor.press("x");
  await page.waitForFunction(() => document.querySelector("[data-draft-scrolled]")?.getAttribute("data-draft-scrolled") === "true");
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await page.waitForFunction(() => document.getAnimations().every(a =>
    a.effect?.getTiming().iterations === Infinity || a.playState !== "running"));
  const scrolled = await editor.evaluate(element => {
    const range = window.getSelection()!.getRangeAt(0).cloneRange(); range.collapse(false);
    const caret = range.getBoundingClientRect(); const box = element.getBoundingClientRect();
    return { caretTop: caret.top, caretBottom: caret.bottom, top: box.top, bottom: box.bottom,
      clip: getComputedStyle(element).clipPath, offset: element.scrollTop, text: (element as HTMLElement).innerText };
  });
  assert(scrolled.offset > 0 && scrolled.clip.startsWith("inset("), `${key}: scrolled draft clipped`);
  assert(scrolled.caretTop >= scrolled.top && scrolled.caretBottom <= scrolled.bottom, `${key}: caret stays visible`);
  for (let i = 1; i <= 80; i++) assert(scrolled.text.includes(`Draft line ${i}:`), `${key}: draft line ${i} retained`);
  await page.screenshot({ path: `${screenshot}-draft-scroll.png` });
  // Move the caret to the first line before scrolling; the browser otherwise
  // restores the focused end caret, as it does for programmatic scrollTo(0).
  await editor.press("ControlOrMeta+ArrowUp");
  await editor.hover();
  await page.mouse.wheel(0, -10000);
  await page.waitForFunction(() => document.querySelector("[data-draft-scrolled]")?.getAttribute("data-draft-scrolled") === "false");
  const top = await editor.evaluate(element => ({ offset: element.scrollTop, clip: getComputedStyle(element).clipPath }));
  assert.equal(top.offset, 0, `${key}: wheel reaches top`);
  assert.equal(top.clip, "none", `${key}: no clip at top`);
  await editor.fill("벚꽃 Cherry blossom long folded draft ".repeat(20));
  // Clicking outside the card folds the composer without changing the draft.
  await page.locator('[data-test-class="mac-window"]').click({
    position: { x: page.viewportSize()!.width / 2, y: 100 },
  });
  const preview = page.locator('[data-slot="composer-compact-preview"]');
  await preview.waitFor({ state: "visible" });
  const folded = await preview.evaluate(element => {
    const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
    const toolbar = element.closest('[data-test-class="composer-toolbar"]')!;
    const buttons = [...toolbar.querySelectorAll("button")].filter(button => button !== element && button.getClientRects().length > 0);
    return { overflow: element.scrollWidth > element.clientWidth, ellipsis: style.textOverflow, whitespace: style.whiteSpace,
      right: rect.right, toolbarRight: toolbar.getBoundingClientRect().right,
      overlaps: buttons.some(button => { const box = button.getBoundingClientRect(); return rect.left < box.right && rect.right > box.left; }) };
  });
  assert(folded.overflow && folded.ellipsis === "ellipsis" && folded.whitespace === "nowrap", `${key}: folded ellipsis`);
  assert(!folded.overlaps && folded.right <= folded.toolbarRight, `${key}: preview stays inside toolbar`);
  await page.screenshot({ path: `${screenshot}-folded.png` });
  await preview.click(); await editor.fill("");
}
