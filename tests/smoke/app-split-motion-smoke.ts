// test-category: race
// The right pane opening and closing beside the chat, through the real native App with a stub model and a browser
// bridge stub (the native view itself: browser-split-motion-electron). Covers: the chat card's edge and the pane
// travel together on the motion tokens, the conversation stays mounted, the bottom-pinned transcript stays pinned, a
// reader keeps their place, an interrupted motion starts from the frame on screen and ends at the right width, a handle
// drag is immediate, a reload or another conversation with the pane open does not animate, reduced motion does not travel.
import { strict as assert } from "node:assert";
import type { Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";
import { installPendingAskEvents, installSessionBrowser, replaySession } from "../support/session-info-fixtures.ts";
import type { SessionView } from "../../packages/butler-app/client/ui/src/app/types.ts";

const SCROLL = '[data-test-class~="conversation-scroll"]';
const TOGGLE = '[data-test-class="titlebar-browser-toggle"]';
const CHAT = '[data-slot="adaptive-shell-split-chat"]';
const PANE = '[data-slot="adaptive-shell-split-pane"]';
const SEPARATOR = '[data-slot="adaptive-shell-split"] > [role="separator"]';
const CHAT_WIDTH = 400;
/** A visible stall in this headless, software-composited run; normal frames here are 8-60 ms. */
const STALL_MS = 250;

const para = "브라우저를 옆에 열어 두고 대화를 이어 갈 때 문단이 줄바꿈을 다시 하게 됩니다. The transcript keeps its text and its lists exactly as written, and this sentence is long enough to wrap several times at either width.";
function longTranscript(view: SessionView): SessionView {
  const start = Date.now() - 60 * 60_000;
  const filler = Array.from({ length: 40 }, (_, index) => ({
    id: `split-motion-${index}`, chat_id: view.session_id, role: index % 2 ? "assistant" as const : "user" as const,
    text: index % 2 ? `## 검토 ${index}\n\n${para}\n\n- ${para}\n- 항목 둘\n\n${para}` : `${index}번째 항목도 확인해 줘. ${para}`,
    created_at: new Date(start + index * 60_000).toISOString(),
  }));
  return { ...view, messages: [...filler, ...view.messages] };
}

type Frame = { t: number; chat: number[] | null; pane: number[] | null; dist: number; running: number; same: boolean };
type Watched = { frames: Frame[]; longest: number };

/** Runs `script` (toggle clicks at the given delays) and samples every frame for `ms`. */
function watch(page: Page, clicksAt: number[], ms = 520): Promise<Watched> {
  return page.evaluate(({ scroll, toggle, chat, pane, clicksAt, ms }) => new Promise<Watched>((resolve) => {
    const frames: Frame[] = [];
    const rect = (selector: string) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return [box.left, box.right];
    };
    const scroller = document.querySelector<HTMLElement>(scroll)!;
    const start = performance.now();
    let last = start, longest = 0;
    const tick = (now: number) => {
      longest = Math.max(longest, now - last); last = now;
      const element = document.querySelector<HTMLElement>(scroll)!;
      frames.push({ t: Math.round(now - start), chat: rect(chat), pane: rect(pane), same: element === scroller,
        dist: Math.round(element.scrollHeight - element.scrollTop - element.clientHeight),
        running: document.querySelector(chat)?.getAnimations().filter((animation) => animation.playState === "running").length ?? 0 });
      if (now - start < ms) requestAnimationFrame(tick); else resolve({ frames, longest: Math.round(longest) });
    };
    requestAnimationFrame(tick);
    for (const at of clicksAt) setTimeout(() => document.querySelector<HTMLElement>(toggle)!.click(), at);
  }), { scroll: SCROLL, toggle: TOGGLE, chat: CHAT, pane: PANE, clicksAt, ms });
}

const edges = (run: Watched) => run.frames.flatMap((frame) => frame.chat ? [frame.chat[1]!] : []);

function assertTravels(run: Watched, from: number, to: number, label: string) {
  const seen = new Set(edges(run).filter((edge) => Math.abs(edge - from) > 2 && Math.abs(edge - to) > 2).map(Math.round));
  assert(seen.size >= 2, `${label}: the chat edge passes through frames between ${from} and ${to}: ${[...seen]}`);
  assert(run.frames.every((frame) => frame.same), `${label}: the conversation stays mounted`);
  assert(run.longest < STALL_MS, `${label}: no visible stall (${run.longest} ms)`);
  for (const frame of run.frames) {
    if (!frame.chat || !frame.pane) continue;
    const gap = frame.pane[0]! - frame.chat[1]!;
    assert(gap >= 0 && gap <= 12, `${label}: the pane follows the chat edge (gap ${gap} at ${frame.t} ms)`);
  }
}

const settled = (page: Page) => page.waitForFunction(({ chat, pane }) =>
  [chat, pane].every((selector) => !document.querySelector(selector)?.getAnimations().length), { chat: CHAT, pane: PANE });
const chatRect = (page: Page) => page.locator(CHAT).evaluate((node) => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width }; });

/** The first row showing under the top edge, and where it sits. */
const reading = (page: Page) => page.evaluate((scroll) => {
  const top = document.querySelector(scroll)!.getBoundingClientRect().top;
  const rows = [...document.querySelectorAll<HTMLElement>("[data-index]")].sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index));
  const row = rows.find((node) => node.getBoundingClientRect().bottom > top + 60)!;
  return { index: row.dataset.index, bottom: row.getBoundingClientRect().bottom };
}, SCROLL);

const server = await createNativeAppServer({ stubReply: () => "확인했습니다." });
const browser = await launchSmokeBrowser();
try {
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: "light", reduce_motion: false }) });
  const created = await Promise.all(["첫 대화", "둘째 대화"].map((title) => server.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title }) })));
  const first = created[0]!.session.id;
  const original = await server.api<SessionView>(`/session-view?session_id=${first}`);
  const transcript = longTranscript(original);
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: "no-preference" });
  await installSessionBrowser(page);
  await installPendingAskEvents(page);
  await replaySession(page, () => transcript);
  await page.addInitScript((id) => { if (!localStorage.getItem("butler:app-ui-state:v1")) localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({
    schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), active_session_id: id, left_open: true, right_open: false })); }, first);
  await server.signIn(page);
  await page.goto(server.url);
  await page.locator(TOGGLE).waitFor();
  await page.waitForFunction((scroll) => document.querySelector(scroll)!.scrollHeight > document.querySelector(scroll)!.clientHeight + 600, SCROLL);
  await page.waitForTimeout(500);
  const closed = await chatRect(page);
  const facts: Record<string, unknown> = { closed };

  // Open and close, pinned to the bottom.
  const open = await watch(page, [0]);
  await settled(page);
  const opened = await chatRect(page);
  assert.equal(opened.width, CHAT_WIDTH, "open: the chat ends at its width");
  assertTravels(open, closed.right, opened.right, "open");
  assert.equal(open.frames.at(-1)!.dist, 0, "open: the transcript stays at the bottom");
  const close = await watch(page, [0]);
  await page.locator(PANE).waitFor({ state: "detached" });
  await settled(page);
  assert.equal((await chatRect(page)).width, closed.width, "close: the chat takes the workspace back");
  assertTravels(close, opened.right, closed.right, "close");
  assert.equal(close.frames.at(-1)!.dist, 0, "close: the transcript stays at the bottom");
  assert.equal(await page.locator(CHAT).evaluate((node) => node.getAnimations().length), 0, "close: nothing stays held on the chat");
  facts.pinned = { openFrames: open.frames.length, openLongest: open.longest, closeFrames: close.frames.length, closeLongest: close.longest };

  // Interrupted: each toggle continues from the frame on screen, and the last state wins.
  for (const [label, clicks, width] of [["close while opening", [0, 70], closed.width], ["rapid toggling", [0, 40, 95, 150, 215], CHAT_WIDTH]] as const) {
    const run = await watch(page, [...clicks], 640);
    await settled(page);
    assert.equal((await chatRect(page)).width, width, `${label}: the final width is right`);
    const moved = edges(run);
    const jump = Math.max(...moved.slice(1).map((edge, index) => Math.abs(edge - moved[index]!)));
    // No frame teleports to an end state: a frame's step stays under the whole travel. The eased curve moves fast early.
    assert(jump < closed.right - opened.right - 40, `${label}: no jump (largest frame step ${jump})`);
    assert(run.frames.every((frame) => frame.same), `${label}: the conversation stays mounted`);
    facts[label] = { frames: run.frames.length, jump: Math.round(jump) };
  }
  // A toggled-open pane after the last run; the drag and restore below start from it.
  assert.equal(await page.locator(TOGGLE).getAttribute("aria-pressed"), "true");

  // A handle drag is immediate and nothing animates. A drag that starts mid-motion takes the width over at once.
  const box = (await page.locator(SEPARATOR).boundingBox())!;
  const y = box.y + box.height / 2, x = box.x + box.width / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (const dx of [40, 90, 120]) {
    await page.mouse.move(x + dx, y);
    await page.waitForFunction(({ chat, width }) => Math.round(document.querySelector(chat)!.getBoundingClientRect().width) === width, { chat: CHAT, width: CHAT_WIDTH + dx });
    assert.equal(await page.locator(CHAT).evaluate((node) => node.getAnimations().length), 0, "drag: the chat width does not animate");
  }
  await page.mouse.up();
  await page.locator(SEPARATOR).focus();
  await page.keyboard.press("Home");
  await page.waitForFunction((chat) => document.querySelector(chat)!.getBoundingClientRect().width === 340, CHAT);
  assert.equal(await page.locator(CHAT).evaluate((node) => node.getAnimations().length), 0, "keyboard resize: the chat width does not animate");
  await page.keyboard.press("End");
  await page.waitForFunction((chat) => document.querySelector(chat)!.getBoundingClientRect().width === 560, CHAT);
  await page.mouse.move(x, y);
  await page.locator(TOGGLE).click();
  await page.locator(PANE).waitFor({ state: "detached" });
  await settled(page);
  const midDrag = await page.evaluate(({ toggle, separator, chat }) => new Promise<number>((resolve) => {
    document.querySelector<HTMLElement>(toggle)!.click();
    setTimeout(() => {
      const handle = document.querySelector<HTMLElement>(separator)!;
      handle.focus();
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
      requestAnimationFrame(() => resolve(document.querySelector(chat)!.getAnimations().filter((animation) => animation.playState === "running").length));
    }, 60);
  }), { toggle: TOGGLE, separator: SEPARATOR, chat: CHAT });
  assert.equal(midDrag, 0, "a resize during the motion takes the width over at once");
  await page.waitForFunction((chat) => document.querySelector(chat)!.getBoundingClientRect().width === 340, CHAT);
  await page.locator(SEPARATOR).press("ArrowRight");
  await page.locator(SEPARATOR).press("ArrowRight");
  await page.locator(SEPARATOR).press("Shift+ArrowRight");
  await page.waitForFunction((chat) => document.querySelector(chat)!.getBoundingClientRect().width === 420, CHAT);

  // Restoring with the pane open places it at once: no motion from the first frame on.
  await page.addInitScript(({ chat, pane }) => {
    const seen: string[] = [];
    (window as unknown as { __splitMotion: string[] }).__splitMotion = seen;
    const tick = () => {
      for (const selector of [chat, pane]) if (document.querySelector(selector)?.getAnimations().some((animation) => animation.playState === "running")) seen.push(selector);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { chat: CHAT, pane: PANE });
  await page.reload();
  await page.locator(PANE).waitFor();
  await page.waitForTimeout(500);
  assert.deepEqual(await page.evaluate(() => (window as unknown as { __splitMotion: string[] }).__splitMotion), [], "reload: nothing moves");
  assert.equal((await chatRect(page)).width, 420, "reload: the chat keeps its width");

  // Another conversation: its own closed pane comes up at once, and so does the open one on the way back.
  await page.evaluate(() => { (window as unknown as { __splitMotion: string[] }).__splitMotion.length = 0; });
  await page.locator('[data-test-class="app-sidebar"]').getByText("둘째 대화", { exact: true }).click();
  await page.waitForFunction((pane) => !document.querySelector(pane), PANE);
  await page.locator('[data-test-class="app-sidebar"]').getByText("첫 대화", { exact: true }).click();
  await page.locator(PANE).waitFor();
  await page.waitForTimeout(300);
  assert.deepEqual(await page.evaluate(() => (window as unknown as { __splitMotion: string[] }).__splitMotion), [], "another conversation: nothing moves");

  // A reader above the bottom keeps their place through both directions.
  await page.locator(TOGGLE).click();
  await page.locator(PANE).waitFor({ state: "detached" });
  await settled(page);
  await page.mouse.move(900, 400);
  for (let step = 0; step < 15; step += 1) { await page.mouse.wheel(0, -100); await page.waitForTimeout(30); }
  await page.waitForTimeout(300);
  const placed = await reading(page);
  const distBefore = await page.locator(SCROLL).evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
  assert(distBefore > 300, `the reader is above the bottom (${distBefore})`);
  await page.locator(TOGGLE).click();
  await page.locator(PANE).waitFor();
  await settled(page);
  await page.waitForTimeout(300);
  const placedOpen = await reading(page);
  assert.equal(placedOpen.index, placed.index, "open: the reader's row is still the one at the top");
  await page.locator(TOGGLE).click();
  await page.locator(PANE).waitFor({ state: "detached" });
  await settled(page);
  await page.waitForTimeout(300);
  const placedClosed = await reading(page);
  assert.equal(placedClosed.index, placed.index, "close: the reader's row is still the one at the top");
  facts.reader = { before: placed, open: placedOpen, close: placedClosed };

  // The sidebar steps aside in the same motion when the page would be too narrow; both ends stay right.
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.waitForTimeout(200);
  const narrowClosed = await chatRect(page);
  await page.locator(TOGGLE).click();
  await page.locator(PANE).waitFor();
  await settled(page);
  assert.equal((await chatRect(page)).width, 420, "narrow open: the chat ends at its width");
  const paneEnd = await page.locator(PANE).evaluate((node) => node.getBoundingClientRect().right);
  assert(paneEnd <= 1100, `narrow open: the pane ends in the window (${paneEnd})`);
  assert.equal(await page.locator('[data-test-class="mac-window"]').getAttribute("data-left-open"), "false", "narrow open: the sidebar stepped aside");
  await page.locator(TOGGLE).click();
  await page.locator(PANE).waitFor({ state: "detached" });
  await settled(page);
  assert.equal((await chatRect(page)).width, narrowClosed.width, "narrow close: the chat takes the workspace back");
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.waitForTimeout(200);

  // Reduced motion: no travel. Open fades the pane in; close places everything at once.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedOpen = await watch(page, [0], 200);
  assert(reducedOpen.frames.every((frame) => frame.running === 0), "reduced motion: the chat does not animate");
  assert.equal(new Set(edges(reducedOpen).filter((edge) => edge !== closed.right)).size, 1, "reduced motion: the chat edge goes straight to its place");
  const fadeOnly = await page.locator(PANE).evaluate((node) => node.getAnimations().flatMap((animation) => (animation.effect as KeyframeEffect).getKeyframes()).every((frame) => !("transform" in frame)));
  assert(fadeOnly, "reduced motion: the pane does not travel");
  await settled(page);
  await page.locator(TOGGLE).click();
  await page.waitForFunction((pane) => !document.querySelector(pane), PANE);
  assert.equal((await chatRect(page)).width, closed.width, "reduced motion: close places the chat at once");
  console.log(JSON.stringify({ result: "BEHAVIOR_PASS", facts }));
} finally {
  await browser.close();
  await server.stop();
}
