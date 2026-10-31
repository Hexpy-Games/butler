// test-category: race
// The right pane opening and closing beside the chat, through the real native App with a stub model and a browser
// bridge stub (the native view itself: browser-split-motion-electron). Covers: the chat card's edge, the pane and the
// title group travel together on the motion tokens, the conversation stays mounted, the bottom-pinned transcript stays
// pinned, a reader keeps the line they are reading, scrolling up after a toggle does not push it, an interrupted motion
// starts from the frame on screen and ends at the right width, a handle drag is immediate, a drag does not outlive the
// pane, a reload or another conversation with the pane open does not animate, reduced motion does not travel.
import { strict as assert } from "node:assert";
import type { Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";
import { installPendingAskEvents, installSessionBrowser, replaySession } from "../support/session-info-fixtures.ts";
import { assertContinues, assertTravels, CHAT, chatRect, edges, PANE, placeOf, readingText, readRest, SCROLL, SEPARATOR, settled, TOGGLE, watch } from "../support/split-motion-frames.ts";
import { verifyNativeHold } from "../support/split-motion-native.ts";
import type { SessionView } from "../../packages/butler-app/client/ui/src/app/types.ts";

const CHAT_WIDTH = 400;
const TALL_MARK = "문단 ";
/** A visible stall in this headless, software-composited run; normal frames here are 8-60 ms. */
const STALL_MS = 250;

const para = "브라우저를 옆에 열어 두고 대화를 이어 갈 때 문단이 줄바꿈을 다시 하게 됩니다. The transcript keeps its text and its lists exactly as written, and this sentence is long enough to wrap several times at either width.";
function longTranscript(view: SessionView): SessionView {
  const start = Date.now() - 60 * 60_000;
  const tallRow = (first: number) => Array.from({ length: 40 }, (_, index) => `${TALL_MARK}${index + first}: ${para} ${para}`).join("\n\n");
  const filler = Array.from({ length: 40 }, (_, index) => ({
    id: `split-motion-${index}`, chat_id: view.session_id, role: index % 2 ? "assistant" as const : "user" as const,
    text: index === 31 ? tallRow(100) : index === 37 ? tallRow(200) : index % 2 ? `## 검토 ${index}\n\n행 ${index}: ${para}\n\n- ${para}\n- 항목 둘\n\n${para}` : `${index}번째 항목도 확인해 줘. ${para}`,
    created_at: new Date(start + index * 60_000).toISOString(),
  }));
  return { ...view, messages: [...filler, ...view.messages] };
}

/** Wheels until `done` holds; a wheel is the user's intent, which releases the bottom lock. */
async function wheelUntil(page: Page, deltaY: number, done: () => Promise<boolean>) {
  const chat = await chatRect(page);
  await page.mouse.move((chat.left + chat.right) / 2, 400);
  for (let step = 0; step < 120 && !await done(); step += 1) { await page.mouse.wheel(0, deltaY); await page.waitForTimeout(40); }
  assert(await done(), "wheeling reached its place");
}
const rowMounted = (page: Page, index: number) => page.evaluate((index) => Boolean(document.querySelector(`[data-index="${index}"]`)), index);

/** Puts the tall answer's paragraph `number` in the middle of the transcript. */
async function readTallParagraph(page: Page, number: number) {
  await wheelUntil(page, 400, () => page.evaluate((text) => [...document.querySelectorAll("[data-index] p")].some((node) => node.textContent!.startsWith(text)), `${TALL_MARK}${number}:`));
  await page.evaluate(({ scroll, text }) => {
    const box = document.querySelector(scroll)!;
    const node = [...document.querySelectorAll("[data-index] p")].find((row) => row.textContent!.startsWith(text))!;
    box.scrollTop += node.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight / 2;
  }, { scroll: SCROLL, text: `${TALL_MARK}${number}:` });
  await page.waitForTimeout(300);
}

/** The reader's line, through one toggle: its paragraph stays on screen. Returns where it was and is. */
async function assertReaderKeepsLine(page: Page, label: string, openNext: boolean) {
  const line = await readingText(page);
  assert(line, `${label}: a paragraph is under the middle of the transcript`);
  await page.locator(TOGGLE).click();
  if (openNext) await page.locator(PANE).waitFor(); else await page.locator(PANE).waitFor({ state: "detached" });
  await settled(page);
  await page.waitForTimeout(300);
  const place = await placeOf(page, line.text);
  const where = await page.evaluate(({ scroll, text }) => {
    const box = document.querySelector(scroll)!;
    const node = [...document.querySelectorAll("[data-index] p")].find((row) => row.textContent!.startsWith(text));
    return { top: node ? Math.round(node.getBoundingClientRect().top - box.getBoundingClientRect().top) : null, scrollTop: Math.round(box.scrollTop), bottom: Math.round(box.scrollHeight - box.scrollTop - box.clientHeight), view: box.clientHeight };
  }, { scroll: SCROLL, text: line.text });
  assert(place !== null, `${label}: the line being read ("${line.text}", ${Math.round(line.top)} before) stays on screen: ${JSON.stringify(where)}`);
  return { text: line.text, before: Math.round(line.top), after: Math.round(place) };
}

const server = await createNativeAppServer({ stubReply: () => "확인했습니다.", uiRoot: process.env.BUTLER_SMOKE_UI_ROOT });
const browser = await launchSmokeBrowser();
try {
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: "light", reduce_motion: false }) });
  const created = await Promise.all(["첫 대화", "둘째 대화", "브라우저 대화"].map((title) => server.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title }) })));
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
  const restClosed = await readRest(page);
  const facts: Record<string, unknown> = { closed };

  // Open and close, pinned to the bottom. The resting gap is read from the open rest.
  const open = await watch(page, [0]);
  await settled(page);
  const opened = await chatRect(page);
  const restOpen = await readRest(page);
  const gap = await page.locator(PANE).evaluate((node) => node.getBoundingClientRect().left) - opened.right;
  assert.equal(opened.width, CHAT_WIDTH, "open: the chat ends at its width");
  assertTravels(open, restClosed, restOpen, gap, STALL_MS, "open");
  assert.equal(open.frames.at(-1)!.dist, 0, "open: the transcript stays at the bottom");
  const close = await watch(page, [0]);
  await page.locator(PANE).waitFor({ state: "detached" });
  await settled(page);
  assert.equal((await chatRect(page)).width, closed.width, "close: the chat takes the workspace back");
  assertTravels(close, restOpen, restClosed, gap, STALL_MS, "close");
  assert.equal(close.frames.at(-1)!.dist, 0, "close: the transcript stays at the bottom");
  assert.equal(await page.locator(CHAT).evaluate((node) => node.getAnimations().length), 0, "close: nothing stays held on the chat");
  facts.pinned = { gap, openFrames: open.frames.length, openLongest: open.longest, closeFrames: close.frames.length, closeLongest: close.longest };

  // Interrupted: each toggle starts from the frame on screen, and the last state wins.
  for (const [label, clicks, width] of [["close while opening", [0, 70], closed.width], ["rapid toggling", [0, 40, 95, 150, 215], CHAT_WIDTH]] as const) {
    const run = await watch(page, [...clicks], 640);
    await settled(page);
    assert.equal((await chatRect(page)).width, width, `${label}: the final width is right`);
    assertContinues(run, label);
    assert(run.frames.every((frame) => frame.same), `${label}: the conversation stays mounted`);
    facts[label] = { frames: run.frames.length, clicks: run.clicks.map((click) => Math.round(Math.abs(click.after - click.before))) };
  }
  // A toggled-open pane after the last run; the drag and restore below start from it.
  assert.equal(await page.locator(TOGGLE).getAttribute("aria-pressed"), "true");

  // A handle drag is immediate and nothing animates.
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
  await page.locator(SEPARATOR).press("End");
  await page.waitForFunction((chat) => document.querySelector(chat)!.getBoundingClientRect().width === 560, CHAT);
  await page.locator(SEPARATOR).press("Home");
  await page.waitForFunction((chat) => document.querySelector(chat)!.getBoundingClientRect().width === 340, CHAT);

  // A real pointer drag that starts mid-motion takes the width over at once. Playback is slowed so the press lands mid-motion.
  await page.locator(TOGGLE).click();
  await page.locator(PANE).waitFor({ state: "detached" });
  await settled(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Animation.enable");
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 0.1 });
  await page.locator(TOGGLE).click();
  await page.locator(SEPARATOR).waitFor();
  await page.evaluate(({ chat }) => {
    window.addEventListener("pointerdown", () => {
      (window as unknown as { __pressed: number }).__pressed = document.querySelector(chat)!.getAnimations().filter((animation) => animation.playState === "running").length;
    }, { capture: true, once: true });
  }, { chat: CHAT });
  const handle = (await page.locator(SEPARATOR).boundingBox())!;
  const hx = handle.x + handle.width / 2, hy = handle.y + handle.height / 2;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  assert((await page.evaluate(() => (window as unknown as { __pressed: number }).__pressed)) > 0, "the press landed mid-motion");
  assert.equal(await page.locator(CHAT).evaluate((node) => node.getAnimations().filter((animation) => animation.playState === "running").length), 0, "a press mid-motion settles it");
  await page.mouse.move(hx + 40, hy);
  await page.waitForFunction((chat) => Math.round(document.querySelector(chat)!.getBoundingClientRect().width) === 380, CHAT);
  await page.mouse.up();
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
  await settled(page);

  // A drag does not outlive the pane: with the button released while the handle was gone, a later hover resizes nothing.
  const held = (await page.locator(SEPARATOR).boundingBox())!;
  const dx0 = held.x + held.width / 2, dy0 = held.y + held.height / 2;
  await page.mouse.move(dx0, dy0);
  await page.mouse.down();
  await page.mouse.move(dx0 + 10, dy0);
  await page.waitForFunction((chat) => Math.round(document.querySelector(chat)!.getBoundingClientRect().width) === 390, CHAT);
  await page.evaluate((toggle) => (document.querySelector(toggle) as HTMLElement).click(), TOGGLE);
  await page.locator(PANE).waitFor({ state: "detached" });
  await page.mouse.up();
  await settled(page);
  await page.evaluate((toggle) => (document.querySelector(toggle) as HTMLElement).click(), TOGGLE);
  await page.locator(PANE).waitFor();
  await settled(page);
  const reopened = (await page.locator(SEPARATOR).boundingBox())!;
  await page.mouse.move(reopened.x + reopened.width / 2, reopened.y + 200);
  await page.mouse.move(reopened.x + reopened.width / 2 + 30, reopened.y + 200, { steps: 3 });
  await page.waitForTimeout(100);
  assert.equal(Math.round((await chatRect(page)).width), 390, "a hover after a closed drag does not resize the chat");
  await page.mouse.move(4, 600);
  await page.locator(SEPARATOR).focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction((chat) => Math.round(document.querySelector(chat)!.getBoundingClientRect().width) === 406, CHAT);
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction((chat) => Math.round(document.querySelector(chat)!.getBoundingClientRect().width) === 422, CHAT);
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction((chat) => Math.round(document.querySelector(chat)!.getBoundingClientRect().width) === 406, CHAT);
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction((chat) => Math.round(document.querySelector(chat)!.getBoundingClientRect().width) === 390, CHAT);
  const restored = 390;

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
  assert.equal((await chatRect(page)).width, restored, "reload: the chat keeps its width");

  // Another conversation: its own closed pane comes up at once, and so does the open one on the way back.
  await page.evaluate(() => { (window as unknown as { __splitMotion: string[] }).__splitMotion.length = 0; });
  await page.locator('[data-test-class="app-sidebar"]').getByText("둘째 대화", { exact: true }).click();
  await page.waitForFunction((pane) => !document.querySelector(pane), PANE);
  await page.locator('[data-test-class="app-sidebar"]').getByText("첫 대화", { exact: true }).click();
  await page.locator(PANE).waitFor();
  await page.waitForTimeout(300);
  assert.deepEqual(await page.evaluate(() => (window as unknown as { __splitMotion: string[] }).__splitMotion), [], "another conversation: nothing moves");

  // A reader keeps the line they are reading through both directions, inside a row that rewraps to far taller.
  await page.locator(TOGGLE).click();
  await page.locator(PANE).waitFor({ state: "detached" });
  await settled(page);
  // Near the end of the transcript first, where the list's old height would stop the scroll.
  // A wheel first: the reader's own scroll is what releases the bottom lock.
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(100);
  await wheelUntil(page, -500, () => page.evaluate((text) => [...document.querySelectorAll("[data-index] p")].some((node) => node.textContent!.startsWith(text)), `${TALL_MARK}220:`));
  await page.mouse.move(800, 400);
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(100);
  await page.evaluate(({ scroll, text }) => {
    const box = document.querySelector(scroll)!;
    const node = [...document.querySelectorAll("[data-index] p")].find((row) => row.textContent!.startsWith(text))!;
    box.scrollTop += node.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight / 2;
  }, { scroll: SCROLL, text: `${TALL_MARK}220:` });
  await page.waitForTimeout(300);
  const nearEnd = [await assertReaderKeepsLine(page, "near the end, open", true), await assertReaderKeepsLine(page, "near the end, close", false)];
  await wheelUntil(page, -800, () => rowMounted(page, 12));
  await readTallParagraph(page, 120);
  const distBefore = await page.locator(SCROLL).evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
  assert(distBefore > 300, `the reader is above the bottom (${distBefore})`);
  const lineOpen = await assertReaderKeepsLine(page, "open", true);
  const lineClose = await assertReaderKeepsLine(page, "close", false);
  facts.reader = { nearEnd, open: lineOpen, close: lineClose };

  // Rows that went out of view at the old width rewrap as they come back: wheeling up moves the text by the wheel only.
  await page.locator(TOGGLE).click();
  await page.locator(PANE).waitFor();
  await settled(page);
  await page.waitForTimeout(300);
  // From the tall row's start, up through rows last measured at the wide width.
  await wheelUntil(page, -600, () => placeOf(page, `${TALL_MARK}100:`).then((place) => place !== null));
  await page.mouse.move(400, 400);
  const WHEEL = 300;
  const shifts: number[] = [];
  const rowInView = (index: number) => page.evaluate(({ scroll, index }) => {
    const row = document.querySelector(`[data-index="${index}"]`)?.getBoundingClientRect();
    return Boolean(row && row.top >= document.querySelector(scroll)!.getBoundingClientRect().top);
  }, { scroll: SCROLL, index });
  for (let step = 0; step < 90 && !await rowInView(12); step += 1) {
    const line = await readingText(page);
    assert(line, "a paragraph is on screen while scrolling up");
    await page.mouse.wheel(0, -WHEEL);
    await page.waitForTimeout(220);
    const place = await placeOf(page, line.text);
    if (place !== null) shifts.push(Math.round(place - line.top));
  }
  assert(await rowInView(12), "scrolling up reached the rows last measured at the wide width");
  const WHEEL_LIMIT = 4;
  assert(shifts.length >= 8, `scrolling up keeps paragraphs in view (${shifts.length})`);
  const pushed = shifts.filter((shift) => Math.abs(shift - WHEEL) > WHEEL_LIMIT);
  assert.deepEqual(pushed, [], `wheeling up by ${WHEEL} moves the text by the wheel only: ${shifts}`);
  facts.scrollUpShifts = shifts;

  // The sidebar steps aside in the same motion when the page would be too narrow; both ends stay right.
  await page.locator(TOGGLE).click();
  await page.locator(PANE).waitFor({ state: "detached" });
  await settled(page);
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.waitForTimeout(200);
  const narrowClosed = await chatRect(page);
  await page.locator(TOGGLE).click();
  await page.locator(PANE).waitFor();
  await settled(page);
  assert.equal((await chatRect(page)).width, restored, "narrow open: the chat ends at its width");
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
  assert(reducedOpen.frames.length > 0, "reduced motion: frames were read");
  assert(reducedOpen.frames.every((frame) => frame.running === 0), "reduced motion: the chat does not animate");
  assert.equal(new Set(edges(reducedOpen).filter((edge) => edge !== closed.right)).size, 1, "reduced motion: the chat edge goes straight to its place");
  const fade = reducedOpen.frames.flatMap((frame) => frame.paneProps);
  assert(fade.includes("opacity"), `reduced motion: the pane fades in: ${fade.slice(0, 6)}`);
  assert(!fade.includes("transform") && !fade.includes("left"), `reduced motion: the pane does not travel: ${fade.slice(0, 6)}`);
  await settled(page);

  // A drag cut short when the pane goes at once: with the button released while the handle was gone, a later hover resizes nothing.
  const cut = (await page.locator(SEPARATOR).boundingBox())!;
  await page.mouse.move(cut.x + cut.width / 2, cut.y + 200);
  await page.mouse.down();
  await page.mouse.move(cut.x + cut.width / 2 + 16, cut.y + 200);
  await page.waitForFunction(({ chat, width }) => Math.round(document.querySelector(chat)!.getBoundingClientRect().width) === width, { chat: CHAT, width: restored + 16 });
  await page.evaluate((toggle) => (document.querySelector(toggle) as HTMLElement).click(), TOGGLE);
  await page.waitForFunction((pane) => !document.querySelector(pane), PANE);
  await page.mouse.up();
  await page.evaluate((toggle) => (document.querySelector(toggle) as HTMLElement).click(), TOGGLE);
  await page.locator(PANE).waitFor();
  await page.mouse.move(cut.x + cut.width / 2, cut.y + 300);
  await page.mouse.move(cut.x + cut.width / 2 + 60, cut.y + 300, { steps: 3 });
  await page.waitForTimeout(100);
  assert.equal(Math.round((await chatRect(page)).width), restored + 16, "a hover after a cut-short drag does not resize the chat");

  await page.locator(TOGGLE).click();
  await page.waitForFunction((pane) => !document.querySelector(pane), PANE);
  assert.equal((await chatRect(page)).width, closed.width, "reduced motion: close places the chat at once");

  // With a live native slot: holds, re-toggles and stale captures.
  const nativeSession = created[2]!.session.id;
  facts.native = await verifyNativeHold(browser, server, nativeSession, await server.api<SessionView>(`/session-view?session_id=${nativeSession}`));
  console.log(JSON.stringify({ result: "BEHAVIOR_PASS", facts }));
} finally {
  await browser.close();
  await server.stop();
}
