// test-category: race
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright";

/** Exercise pointer, native Tab focus and Playwright's scroll-into-view separately.
 * Each trial starts from the same closed group; cleanup never changes its result.
 */
export async function probeThinkingReveal(page: Page, group: Locator, row: Locator, evidence: string, cell: string) {
  const results = [];
  for (const mode of ["immediate-click", "pointer", "keyboard-enter", "keyboard-space", "scroll-into-view"] as const) {
    const keyboard = mode === "keyboard-enter" || mode === "keyboard-space";
    const userInteraction = mode === "pointer" || keyboard;
    if (mode !== "immediate-click") await group.focus();
    if (keyboard) await page.keyboard.press("Enter");
    else if (mode === "pointer") {
      const rect = await group.boundingBox();
      assert(rect);
      await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    } else await group.click();
    const reveal = mode === "immediate-click" ? null : await row.evaluate(async (element, fraction) => {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const clip = element.closest('[data-state="open"]')!;
      const animations = clip.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity);
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = Number(animation.effect!.getComputedTiming().duration) * fraction;
      }
      return { animations: animations.length, height: clip.clientHeight, contentHeight: clip.scrollHeight };
    }, mode === "pointer" ? 0.75 : 0.1);
    if (reveal) assert(reveal.animations > 0 && reveal.height > 0 && reveal.height < reveal.contentHeight, "probe must run during reveal");
    const before = await geometry(page, row);
    if (mode === "immediate-click") await row.click();
    else if (keyboard) {
      for (let index = 0; index < 5 && !await row.evaluate(el => el === document.activeElement); index++) await page.keyboard.press("Tab");
      assert(await row.evaluate(el => el === document.activeElement), "Tab must reach the thinking row");
      await page.keyboard.press(mode === "keyboard-enter" ? "Enter" : "Space");
    } else if (mode === "pointer") {
      const rect = await row.boundingBox();
      assert(rect);
      await page.mouse.click(rect.x + rect.width - 8, rect.y + rect.height / 2);
    } else await row.scrollIntoViewIfNeeded();
    const after = await geometry(page, row);
    if (userInteraction) assert.equal(await row.getAttribute("aria-expanded"), "true", `${mode} opens the thinking body`);
    results.push({ mode, userInteraction, reveal, before, after });
    // Finish the paused reveal, then discard the trial's open/scroll state.
    // Real interactions are asserted after captures; CDP auto-scroll is evidence only.
    await page.evaluate(async () => {
      for (const animation of document.getAnimations()) {
        if (animation.playState === "paused") animation.finish();
      }
    });
    await group.evaluate(el => (el as HTMLElement).click());
    await page.evaluate(async () => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
      document.querySelector<HTMLElement>("[data-panel-layout]")!.scrollLeft = 0;
    });
  }
  writeFileSync(join(evidence, `reveal-scroll-${cell}.json`), JSON.stringify(results, null, 2) + "\n");
  return results.map(result => ({ mode: result.mode, userInteraction: result.userInteraction, scrollLeft: result.after.shell.scrollLeft }));
}

async function geometry(page: Page, row: Locator) {
  return row.evaluate(element => {
    const describe = (el: Element) => {
      const css = getComputedStyle(el);
      return { slot: el.getAttribute("data-slot"), className: el.className, scrollLeft: el.scrollLeft,
        width: el.clientWidth, scrollWidth: el.scrollWidth, overflowX: css.overflowX,
        transform: css.transform, visibility: css.visibility, rect: el.getBoundingClientRect().toJSON() };
    };
    const shell = document.querySelector("[data-panel-layout]")!;
    const ancestors = [];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) ancestors.push(describe(parent));
    return { shell: describe(shell), inspector: describe(shell.querySelector('[data-slot="adaptive-shell-inspector"]')!),
      row: describe(element), focused: element === document.activeElement, ancestors };
  });
}
