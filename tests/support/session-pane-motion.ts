// test-category: race
import { strict as assert } from "node:assert";
import type { Browser, Page } from "playwright";
import type { SessionView } from "../../packages/butler-app/client/ui/src/app/types.ts";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import { installPendingAskEvents, installSessionBrowser, replaySession } from "./session-info-fixtures.ts";

const SCROLL = '[data-test-class~="conversation-scroll"]';
const LIST = '[data-test-class~="message-list"]';
const TOGGLE = '[data-test-class="session-info-toggle"]';
/** A visible stall; normal frames here are 8-40 ms (headless, software compositing). */
const STALL_MS = 200;

/** A transcript long enough to scroll, so the scroll position before and after the motion means something. */
function longTranscript(view: SessionView): SessionView {
  const start = Date.now() - 60 * 60_000;
  const filler = Array.from({ length: 30 }, (_, index) => ({
    id: `pane-motion-${index}`, chat_id: view.session_id, role: index % 2 ? "assistant" as const : "user" as const,
    text: index % 2 ? `검토 ${index}: 변경 사항을 하나씩 확인하고, 릴리스 노트에 들어갈 항목만 남겼습니다.` : `${index}번째 항목도 확인해 줘.`,
    created_at: new Date(start + index * 60_000).toISOString(),
  }));
  return { ...view, messages: [...filler, ...view.messages] };
}

type Toggled = { frames: number; maxGap: number; longTasks: number; glides: number; asides: string[] };

/** Clicks the toggle and watches 400 ms: rAF frames, the longest gap, long tasks, transform glides and the asides mounted. */
function toggleAndWatch(page: Page): Promise<Toggled> {
  return page.evaluate(({ toggle, list }) => new Promise<Toggled>((resolve) => {
    let longTasks = 0, frames = 0, maxGap = 0, glides = 0;
    const asides = new Set<string>();
    const observer = new PerformanceObserver((entries) => { longTasks += entries.getEntries().length; });
    observer.observe({ type: "longtask" });
    const start = performance.now();
    let last = start;
    const tick = (now: number) => {
      frames += 1; maxGap = Math.max(maxGap, now - last); last = now;
      glides = Math.max(glides, document.querySelector(list)!.getAnimations().length);
      for (const node of document.querySelectorAll('[data-slot="conversation-aside"]')) asides.add(`${node.getAttribute("data-layout")}:${node.getAttribute("data-state")}`);
      if (now - start < 400) requestAnimationFrame(tick);
      else { observer.disconnect(); resolve({ frames, maxGap: Math.round(maxGap), longTasks, glides, asides: [...asides] }); }
    };
    requestAnimationFrame(tick);
    (document.querySelector(toggle) as HTMLElement).click();
  }), { toggle: TOGGLE, list: LIST });
}

/** ⋯ sits after the whole title line (title, then subtitle), never over a truncated subtitle and never clipped. */
export async function verifyTitleActionsAfterSubtitle(page: Page) {
  const row = await page.evaluate(() => {
    const bar = document.querySelector('[data-test-class="custom-titlebar"]')!;
    const box = (node: Element | null) => node?.getBoundingClientRect();
    const title = box(bar.querySelector('[data-slot="titlebar-title"]'))!;
    const subtitleNode = bar.querySelector('[data-slot="titlebar-subtitle"]');
    const subtitle = box(subtitleNode)!;
    const actions = box(bar.querySelector('[data-slot="titlebar-title-actions"]'))!;
    const group = box(bar.querySelector('[data-slot="titlebar-chat-group"]') ?? bar)!;
    return { title: title.right, subtitle: [subtitle.left, subtitle.right], actions: [actions.left, actions.right], groupRight: group.right,
      truncated: subtitleNode!.scrollWidth > subtitleNode!.clientWidth };
  });
  assert(row.subtitle[0]! >= row.title, `The subtitle follows the title: ${JSON.stringify(row)}`);
  assert(row.actions[0]! >= row.subtitle[1]! - 0.5, `⋯ follows the subtitle: ${JSON.stringify(row)}`);
  assert(row.actions[1]! <= row.groupRight + 0.5, `⋯ stays visible: ${JSON.stringify(row)}`);
  return row;
}

const column = (page: Page) => page.evaluate(({ scroll, list }) => ({
  scrollTop: document.querySelector(scroll)!.scrollTop,
  left: Math.round(document.querySelector(list)!.getBoundingClientRect().left),
}), { scroll: SCROLL, list: LIST });

/**
 * The 세션 정보 pane with motion on: the docked column glides on a transform (never a layout animation) and keeps
 * the transcript's scroll position, the toggle shows its pressed tone, a floating reopen after a resize mounts only
 * the floating panel, and reduced motion moves the column at once.
 */
export async function verifySessionPaneMotion(browser: Browser, server: NativeAppServerHandle, view: SessionView) {
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ reduce_motion: false }) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: "no-preference" });
  try {
    const transcript = longTranscript(view);
    await installSessionBrowser(page);
    await installPendingAskEvents(page);
    await replaySession(page, () => transcript);
    await page.addInitScript((id) => localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({
      schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), active_session_id: id, left_open: true, right_open: false })), view.session_id);
    await server.signIn(page);
    await page.goto(server.url);
    await page.locator(LIST).waitFor();
    await page.waitForFunction((scroll) => document.querySelector(scroll)!.scrollHeight > document.querySelector(scroll)!.clientHeight + 600, SCROLL);
    // Scroll up only once the transcript has settled (the first load pins it to the bottom), and hold there.
    let held = false;
    for (let attempt = 0; attempt < 20 && !held; attempt += 1) {
      held = await page.evaluate((scroll) => new Promise<boolean>((resolve) => {
        const node = document.querySelector(scroll)!;
        const target = Math.round(node.scrollHeight - node.clientHeight - 600);
        node.scrollTop = target;
        setTimeout(() => resolve(Math.abs(node.scrollTop - target) <= 1), 500);
      }), SCROLL);
    }
    assert(held, "The transcript holds a scroll position above the bottom");
    const toggle = page.locator(TOGGLE);
    assert.equal(await toggle.getAttribute("aria-pressed"), "false");
    assert.equal(await toggle.getAttribute("data-tone"), null, "Closed: the toggle keeps the default tone");
    const closedColor = await toggle.evaluate((node) => getComputedStyle(node).color);
    const before = await column(page);
    const open = await toggleAndWatch(page);
    const opened = await column(page);
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
    assert.equal(await toggle.getAttribute("data-tone"), "butler", "Open: the toggle shows the pressed (butler) tone");
    assert.notEqual(await toggle.evaluate((node) => getComputedStyle(node).color), closedColor, "The pressed tone changes the icon colour");
    assert.equal(await toggle.locator('[data-slot="icon-button-indicator"]').count(), 1, "The pending-ask dot stays on the pressed toggle");
    assert(open.glides > 0, "Docked open glides the column");
    assert(opened.left < before.left - 20, `The column moves left: ${before.left} -> ${opened.left}`);
    assert.equal(opened.scrollTop, before.scrollTop, "Opening keeps the transcript's scroll position");
    const close = await toggleAndWatch(page);
    const closed = await column(page);
    assert(close.glides > 0, "Docked close glides the column");
    assert.equal(closed.left, before.left, "The column comes back to centre");
    assert.equal(closed.scrollTop, before.scrollTop, "Closing keeps the transcript's scroll position");
    for (const [name, run] of [["open", open], ["close", close]] as const) {
      assert(run.maxGap < STALL_MS, `Docked ${name}: no visible stall (${run.maxGap} ms)`);
    }
    await page.setViewportSize({ width: 1024, height: 900 });
    const floating = await toggleAndWatch(page);
    assert.deepEqual(floating.asides, ["floating:open"], "Reopened at a floating width, only the floating panel mounts");
    await toggle.click();
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const reduced = await toggleAndWatch(page);
    assert.equal(reduced.glides, 0, "Reduced motion: the column moves at once");
    assert.equal((await column(page)).left, opened.left);
    console.log(JSON.stringify({ paneMotion: { open, close, floating: floating.asides, reducedGlides: reduced.glides, scrollTop: before.scrollTop, columnLeft: [before.left, opened.left] } }));
  } finally {
    await page.close();
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ reduce_motion: true }) });
  }
}
