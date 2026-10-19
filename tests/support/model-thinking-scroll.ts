// test-category: race
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright";

export async function assertThinkingPinned(page: Page, label: string) {
  await page.waitForFunction(() => {
    const scroll = document.querySelector('[data-test-class~="conversation-scroll"]')!;
    return scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 2;
  });
  assert.equal(await page.locator('[data-test-class="scroll-to-bottom-button"]').count(), 0, `${label}: no jump pill at the bottom`);
}

/** Exercise pointer, native Tab focus and Playwright's scroll-into-view separately.
 * Each trial starts from the same closed group; cleanup never changes its result.
 */
export async function probeThinkingReveal(page: Page, group: Locator, row: Locator, evidence: string, cell: string, stream: () => Promise<void>) {
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
    if (userInteraction) {
      await assertThinkingPinned(page, `${cell} ${mode} expansion`);
      await stream();
      await assertThinkingPinned(page, `${cell} ${mode} streaming`);
    }
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

/** Cover native reverse Tab and focusin preceding the browser's reveal scroll. */
export async function assertStreamingFocusReleased(page: Page, target: Locator,
  stream: () => Promise<void>, evidence: string, cell: string) {
  for (const mode of ["native-shift-tab", "focus-before-scroll"]) {
    await page.keyboard.press("ArrowLeft");
    await assertThinkingPinned(page, `${cell} before ${mode}`);
    const outside = await target.evaluate(element => {
      const scroll = element.closest('[data-test-class~="conversation-scroll"]')!;
      const outside = element.getBoundingClientRect().bottom < scroll.getBoundingClientRect().top;
      const anchor = document.createElement("span");
      anchor.tabIndex = -1;
      // The setup anchor must not itself release follow or trigger fade reveal.
      anchor.addEventListener("focusin", event => event.stopPropagation());
      element.after(anchor);
      anchor.focus({ preventScroll: true });
      anchor.addEventListener("blur", () => anchor.remove(), { once: true });
      return outside;
    });
    assert(outside, "reverse Tab target must start above the viewport");
    await assertThinkingPinned(page, `${cell} ${mode} setup retains follow`);
    await page.screenshot({ path: join(evidence, `focus-before-${mode}-${cell}.png`) });
    if (mode === "native-shift-tab") await page.keyboard.press("Shift+Tab");
    else await target.evaluate(element => {
      // Explicitly hold native reveal until after focusin to pin the ordering race.
      (element as HTMLElement).focus({ preventScroll: true });
      element.scrollIntoView({ block: "nearest" });
    });
    assert(await target.evaluate(element => element === document.activeElement), `${mode} reaches the offscreen control`);
    await page.locator('[data-test-class="scroll-to-bottom-button"]').waitFor();
    await stream();
    await page.waitForTimeout(200);
    assert(await target.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const viewport = element.closest('[data-test-class~="conversation-scroll"]')!.getBoundingClientRect();
      return element === document.activeElement && bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
    }), `${mode}: streamed chunks must keep the focused control visible`);
    assert.equal(await page.locator('[data-test-class="scroll-to-bottom-button"]').count(), 1, "follow remains released after streaming");
    await page.screenshot({ path: join(evidence, `focus-after-${mode}-${cell}.png`) });
    await page.locator('[data-test-class="scroll-to-bottom-button"]').click();
    await assertThinkingPinned(page, `${cell} resumed`);
  }
}

/** Hold an existing product rAF pin until native Tab's keydown. The key handler
 * commits the next chunk, runs that pin, then leaves browser Tab navigation intact.
 */
async function armPinTab(target: Locator, count: number, reverse: boolean) {
  await target.evaluate((element, input) => {
    const scroll = element.closest<HTMLElement>('[data-test-class~="conversation-scroll"]')!;
    const anchor = document.createElement("span");
    anchor.tabIndex = -1;
    anchor.style.position = "fixed";
    anchor.addEventListener("focusin", event => event.stopPropagation());
    if (input.reverse) element.after(anchor); else element.before(anchor);
    anchor.focus({ preventScroll: true });
    const original = scroll.scrollTo.bind(scroll);
    const raf = window.requestAnimationFrame;
    const state = { ready: false, pin: 0, focused: false, focusScrollEvents: -1, scrollEvents: 0, outside: false, staleOutside: false, outsideBy: 0, pillSeen: false };
    Object.assign(window, { pinFocusGap: state });
    const pills = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element && (node.matches('[data-test-class="scroll-to-bottom-button"]') || node.querySelector('[data-test-class="scroll-to-bottom-button"]'))) state.pillSeen = true;
      }
    });
    element.addEventListener("blur", () => pills.disconnect(), { once: true });
    let pin: FrameRequestCallback;
    scroll.scrollTo = function (options?: ScrollToOptions | number, y?: number) {
      if (typeof options === "number") original(options, y ?? 0); else original(options);
      scroll.scrollTo = original;
      // The hook schedules its rAF immediately after this initial bottom pin.
      window.requestAnimationFrame = callback => {
        window.requestAnimationFrame = raf;
        pin = callback;
        state.ready = true;
        return raf(() => {});
      };
    };
    const onScroll = () => { state.scrollEvents++; };
    scroll.addEventListener("scroll", onScroll);
    element.addEventListener("focusin", () => {
      state.focused = true;
      state.focusScrollEvents = state.scrollEvents;
      scroll.removeEventListener("scroll", onScroll);
      anchor.remove();
    }, { once: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      window.removeEventListener("keydown", onKey);
      const { flushSync, receiveModelThinking } = window.butlerThinkingHarness;
      flushSync(() => receiveModelThinking({ type: "turn.thinking", payload: {
        turn_id: "thinking-turn", round_id: "second", line: "Checking the results",
        summary: "Streaming paragraph.\n\n".repeat(input.count),
      } }));
      pills.observe(document.body, { childList: true, subtree: true });
      const previous = scroll.scrollTop;
      pin(performance.now());
      state.pin = scroll.scrollTop - previous;
      state.scrollEvents = 0;
      const bounds = element.getBoundingClientRect(), viewport = scroll.getBoundingClientRect();
      state.outside = bounds.bottom < viewport.top;
      state.outsideBy = viewport.top - bounds.bottom;
      state.staleOutside = bounds.top + state.pin < viewport.top || bounds.bottom + state.pin > viewport.bottom;
    };
    window.addEventListener("keydown", onKey);
  }, { count, reverse });
}

export async function assertPinFocusGap(page: Page, evidence: string, cell: string) {
  const messages = await page.evaluate(() => {
    const state = window.butlerThinkingHarness.useButlerStore.getState();
    const original = state.messages;
    state.setMessages([...Array.from({ length: 20 }, (_, index) => ({ ...original[0], id: `earlier-${index}`, turn_id: `earlier-turn-${index}`, text: "Earlier conversation." })), ...original]);
    return original;
  });
  const receive = (count: number) => page.evaluate(lines => {
    window.butlerThinkingHarness.receiveModelThinking({ type: "turn.thinking", payload: {
      turn_id: "thinking-turn", round_id: "second", line: "Checking the results",
      summary: "Streaming paragraph.\n\n".repeat(lines),
    } });
  }, count);
  const contentArrived = (count: number) => page.waitForFunction(lines => document.querySelector('[data-test-class="thinking-details"]')?.textContent?.match(/Streaming paragraph\./gu)?.length === lines, count);
  await page.evaluate(() => window.butlerThinkingHarness.receiveModelThinking({ type: "turn.thinking", payload: {
    turn_id: "thinking-turn", round_id: "next", line: "Next thinking row", summary: "Next summary.",
  } }));
  const row = page.getByRole("button", { name: "Checking the results", exact: true });
  const next = page.getByRole("button", { name: "Next thinking row", exact: true });
  await next.waitFor();
  for (const reverse of [false, true]) {
    await receive(5);
    await contentArrived(5);
    await page.waitForTimeout(200); // Settle only setup, before arming the chunk.
    await assertThinkingPinned(page, `${cell} gap setup`);
    const target = reverse ? row : next;
    const sizing = await row.evaluate(element => {
      const scroll = element.closest('[data-test-class~="conversation-scroll"]')!;
      const body = scroll.querySelector('[data-test-class="thinking-details"]')!;
      return { room: element.getBoundingClientRect().bottom - scroll.getBoundingClientRect().top, paragraph: body.clientHeight / 5 };
    });
    const count = reverse ? 5 + Math.ceil((sizing.room + 80) / sizing.paragraph) : 25;
    await armPinTab(target, count, reverse);
    await receive(6); // Prime the existing product rAF; the tested chunk is in keydown.
    await page.waitForFunction(() => (window as unknown as { pinFocusGap: { ready: boolean } }).pinFocusGap.ready);
    await page.keyboard.press(reverse ? "Shift+Tab" : "Tab");
    const gap = await page.evaluate(() => (window as unknown as { pinFocusGap: { pin: number; focused: boolean; focusScrollEvents: number; outside: boolean; staleOutside: boolean; outsideBy: number; pillSeen: boolean } }).pinFocusGap);
    assert(gap.pin > 0, "the streamed chunk must grow and programmatically pin");
    assert(gap.focused, "native Tab reaches the thinking control");
    assert.equal(gap.focusScrollEvents, 0, "native focus must precede the pin's scroll event");
    assert.equal(gap.outside, reverse, "reverse target starts just above the viewport; forward target stays visible");
    assert.equal(gap.staleOutside, !reverse, "stale pin growth must invert the focus decision");
    writeFileSync(join(evidence, `pin-gap-${reverse ? "reverse" : "forward"}-${cell}.json`), JSON.stringify(gap) + "\n");
    if (reverse) await page.locator('[data-test-class="scroll-to-bottom-button"]').waitFor();
    else {
      await assertThinkingPinned(page, `${cell} native Tab after pin`);
      assert.equal(gap.pillSeen, false, "visible Tab must never flash a jump pill");
    }
    for (const lines of [count + 3, count + 5]) {
      await receive(lines);
      await contentArrived(lines);
      assert(await target.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const viewport = element.closest('[data-test-class~="conversation-scroll"]')!.getBoundingClientRect();
        return document.activeElement === element && bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
      }), "further chunks keep the control focused and visible");
      if (reverse) assert.equal(await page.locator('[data-test-class="scroll-to-bottom-button"]').count(), 1);
      else {
        await assertThinkingPinned(page, `${cell} native Tab keeps following`);
        assert.equal(await page.evaluate(() => (window as unknown as { pinFocusGap: { pillSeen: boolean } }).pinFocusGap.pillSeen), false, "visible Tab never releases follow");
      }
    }
    await page.screenshot({ path: join(evidence, `pin-gap-${reverse ? "reverse" : "forward"}-${cell}.png`) });
    if (reverse) await page.locator('[data-test-class="scroll-to-bottom-button"]').click();
  }
  await page.evaluate(original => {
    window.butlerThinkingHarness.useButlerStore.getState().setMessages(original);
    window.butlerThinkingHarness.useModelThinking.setState(state => ({ summaries: {
      ...state.summaries, "thinking-turn": state.summaries["thinking-turn"].filter(summary => summary.round !== "next"),
    } }));
  }, messages);
}
