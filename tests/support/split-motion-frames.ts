// test-category: race
// Frame-by-frame reads of the right pane's motion in the harness (app-split-motion-smoke).
import { strict as assert } from "node:assert";
import type { Page } from "playwright";

export const SCROLL = '[data-test-class~="conversation-scroll"]';
export const TOGGLE = '[data-test-class="titlebar-browser-toggle"]';
export const CHAT = '[data-slot="adaptive-shell-split-chat"]';
export const PANE = '[data-slot="adaptive-shell-split-pane"]';
export const TITLE = '[data-slot="titlebar-chat-group"]';
export const SEPARATOR = '[data-slot="adaptive-shell-split"] > [role="separator"]';

export type Frame = { t: number; chat: number[] | null; pane: number[] | null; title: number | null; dist: number; running: number; same: boolean; paneProps: string[] };
export type ClickRead = { at: number; before: number; after: number; pressed: Array<string | null> };
export type Watched = { frames: Frame[]; longest: number; clicks: ClickRead[] };

/** Clicks the toggle at the given delays and samples every frame for `ms`; each click also reads the chat edge on both sides of its commit. */
export function watch(page: Page, clicksAt: number[], ms = 520): Promise<Watched> {
  return page.evaluate(async ({ scroll, toggle, chat, pane, title, clicksAt, ms }) => {
    const frames: Frame[] = [], clicks: ClickRead[] = [];
    const rect = (selector: string) => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return box ? [box.left, box.right] : null;
    };
    const scroller = document.querySelector<HTMLElement>(scroll)!;
    const button = document.querySelector<HTMLElement>(toggle)!;
    const start = performance.now();
    let last = start, longest = 0;
    const click = (at: number) => setTimeout(async () => {
      const before = rect(chat)?.[1] ?? 0, pressed = button.getAttribute("aria-pressed");
      button.click();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      clicks.push({ at, before, after: rect(chat)?.[1] ?? 0, pressed: [pressed, button.getAttribute("aria-pressed")] });
    }, at);
    for (const at of clicksAt) click(at);
    await new Promise<void>((done) => {
      const tick = (now: number) => {
        longest = Math.max(longest, now - last); last = now;
        const element = document.querySelector<HTMLElement>(scroll)!;
        const animated = document.querySelector(pane)?.getAnimations() ?? [];
        frames.push({ t: Math.round(now - start), chat: rect(chat), pane: rect(pane), title: rect(title)?.[1] ?? null, same: element === scroller,
          dist: Math.round(element.scrollHeight - element.scrollTop - element.clientHeight),
          running: document.querySelector(chat)?.getAnimations().filter((animation) => animation.playState === "running").length ?? 0,
          paneProps: animated.flatMap((animation) => (animation.effect as KeyframeEffect).getKeyframes().flatMap((frame) => Object.keys(frame))) });
        if (now - start < ms) requestAnimationFrame(tick); else done();
      };
      requestAnimationFrame(tick);
    });
    return { frames, longest: Math.round(longest), clicks };
  }, { scroll: SCROLL, toggle: TOGGLE, chat: CHAT, pane: PANE, title: TITLE, clicksAt, ms });
}

export const edges = (run: Watched) => run.frames.flatMap((frame) => frame.chat ? [frame.chat[1]!] : []);

export const settled = (page: Page) => page.waitForFunction(({ chat, pane }) =>
  [chat, pane].every((selector) => !document.querySelector(selector)?.getAnimations().length), { chat: CHAT, pane: PANE });
export const chatRect = (page: Page) => page.locator(CHAT).evaluate((node) => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width }; });

/** The rest geometry the motion runs between: the chat's end, the title group's end and the gap to the pane. */
export type Rest = { chat: number; title: number };
export const readRest = (page: Page) => page.evaluate(({ chat, title }): Rest => ({
  chat: document.querySelector(chat)!.getBoundingClientRect().right, title: document.querySelector(title)!.getBoundingClientRect().right,
}), { chat: CHAT, title: TITLE });

/** Every frame between two rests: the chat edge travels, the pane keeps the resting gap, the title group ends with the chat. */
export function assertTravels(run: Watched, from: Rest, to: Rest, gap: number, stallMs: number, label: string) {
  const seen = new Set(edges(run).filter((edge) => Math.abs(edge - from.chat) > 2 && Math.abs(edge - to.chat) > 2).map(Math.round));
  assert(seen.size >= 2, `${label}: the chat edge passes through frames between ${from.chat} and ${to.chat}: ${[...seen]}`);
  assert(run.frames.every((frame) => frame.same), `${label}: the conversation stays mounted`);
  assert(run.longest < stallMs, `${label}: no visible stall (${run.longest} ms)`);
  for (const frame of run.frames) {
    if (!frame.chat) continue;
    if (frame.pane) assert(Math.abs(frame.pane[0]! - frame.chat[1]! - gap) <= 1, `${label}: the pane keeps the resting gap ${gap} (${frame.pane[0]! - frame.chat[1]!} at ${frame.t} ms)`);
    const progress = (frame.chat[1]! - from.chat) / (to.chat - from.chat);
    const title = from.title + progress * (to.title - from.title);
    assert(Math.abs(frame.title! - title) <= 2, `${label}: the title group ends with the chat (${frame.title} against ${Math.round(title)} at ${frame.t} ms)`);
  }
}

/** A later click continues from the frame on screen: the chat edge does not move in that click's commit. */
export function assertContinues(run: Watched, label: string) {
  assert(run.clicks.length > 1, `${label}: more than one click`);
  for (const click of run.clicks) {
    assert.notEqual(click.pressed[0], click.pressed[1], `${label}: the read after the click at ${click.at} ms follows its commit`);
    assert(Math.abs(click.after - click.before) <= 1, `${label}: the click at ${click.at} ms starts from the frame on screen (${click.before} -> ${click.after})`);
  }
}

/** The paragraph under the middle of the transcript, by its opening words. */
export const readingText = (page: Page) => page.evaluate((scroll) => {
  const box = document.querySelector(scroll)!.getBoundingClientRect();
  const y = box.top + box.height / 2;
  const rows = [...document.querySelectorAll<HTMLElement>("[data-index] p")];
  const row = rows.find((node) => { const r = node.getBoundingClientRect(); return r.top <= y && r.bottom >= y; }) ?? rows.find((node) => node.getBoundingClientRect().top >= y);
  return row ? { text: row.textContent!.slice(0, 16), top: row.getBoundingClientRect().top - box.top } : null;
}, SCROLL);

/** Where that paragraph sits in the transcript's viewport now; null when it is not on screen. */
export const placeOf = (page: Page, text: string) => page.evaluate(({ scroll, text }) => {
  const box = document.querySelector(scroll)!.getBoundingClientRect();
  const node = [...document.querySelectorAll<HTMLElement>("[data-index] p")].find((row) => row.textContent!.startsWith(text));
  if (!node) return null;
  const r = node.getBoundingClientRect();
  return r.bottom > box.top && r.top < box.bottom ? r.top - box.top : null;
}, { scroll: SCROLL, text });

/** Watches a pane while it leaves: frames with the pane on the move, and those without `content` on it. */
export function watchLeavingPane(page: Page, content: string) {
  return page.evaluate(({ pane, content }) => new Promise<{ total: number; missing: number }>((resolve) => {
    let total = 0, missing = 0, seen = false;
    const start = performance.now();
    const tick = () => {
      const leaving = document.querySelector(`[data-slot="adaptive-shell-split"][data-pane-leaving] > ${pane}`);
      if (leaving) {
        seen = true; total += 1;
        const node = leaving.querySelector(content);
        if (!node || !node.getBoundingClientRect().height) missing += 1;
      }
      if ((seen && !leaving) || performance.now() - start > 5000) resolve({ total, missing }); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), { pane: PANE, content });
}
