// test-category: race
import { strict as assert } from "node:assert";
import type { Browser, Page } from "playwright";
import type { SessionView } from "../../packages/butler-app/client/ui/src/app/types.ts";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import { installPendingAskEvents, installSessionBrowser, replaySession } from "./session-info-fixtures.ts";

const TOGGLE = '[data-test-class="session-info-toggle"]';
const RAIL = '[data-slot="tab-rail"] > section';
const ASIDE = '[data-slot="conversation-aside"]';

/** Three background tabs the conversation's agent is using: the rail's live cards. */
function agentTabs(sessionId: string) {
  return ["https://example.com/a", "https://example.org/b", "https://example.net/c"].map((url, index) => ({
    id: `rail-${index}`, owner: `conversation:${sessionId}`, url, title: `Tab ${index + 1}`, favicon: "", agent: true, holder: "agent",
    agentAt: 1_760_000_000_000 - index, status: "idle", canBack: false, canForward: false, ...(index === 0 ? { busy: true } : {}),
  }));
}

type HeaderControl = { label: string; hit: boolean; found: string; overlap: number };

/** Every title-bar control: what elementFromPoint finds at its centre, and its overlap with the rail. */
function headerControls(page: Page): Promise<HeaderControl[]> {
  return page.evaluate((rail) => {
    const railBox = document.querySelector(rail)!.getBoundingClientRect();
    const buttons = [...document.querySelectorAll('[data-test-class="custom-titlebar"] button')].filter((button) => button.getClientRects().length);
    return buttons.map((button) => {
      const box = button.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      const overlap = Math.max(0, Math.min(box.right, railBox.right) - Math.max(box.left, railBox.left))
        * Math.max(0, Math.min(box.bottom, railBox.bottom) - Math.max(box.top, railBox.top));
      const found = hit ? `${hit.tagName.toLowerCase()}[${hit.getAttribute("data-slot") ?? hit.getAttribute("data-test-class") ?? ""}]` : `nothing at ${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)} in ${innerWidth}x${innerHeight}`;
      return { label: button.getAttribute("aria-label") ?? "", hit: Boolean(hit && button.contains(hit)), found, overlap };
    });
  }, RAIL);
}

/** Waits until the title bar's controls hold still for 150 ms (the bar's own layout motion has ended). */
function headerSettled(page: Page) {
  return page.evaluate(() => new Promise<void>((resolve) => {
    const read = () => [...document.querySelectorAll('[data-test-class="custom-titlebar"] button')]
      .map((button) => { const box = button.getBoundingClientRect(); return `${Math.round(box.left)},${Math.round(box.top)}`; }).join(" ");
    let last = read(), since = performance.now();
    const tick = (now: number) => {
      const next = read();
      if (next !== last) { last = next; since = now; }
      if (now - since >= 150) resolve(); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
}

async function assertHeaderClear(page: Page, where: string) {
  await headerSettled(page);
  const controls = await headerControls(page);
  assert(controls.some((control) => control.label.startsWith("세션 정보")), `${where}: the 세션 정보 toggle is in the title bar`);
  for (const control of controls) {
    assert(control.hit, `${where}: ${control.label} is hit-testable beside the rail (found ${control.found})`);
    assert.equal(control.overlap, 0, `${where}: the rail stays clear of ${control.label}`);
  }
  return controls.length;
}

type Closed = { asideFrames: number; railUnderAside: number; railShown: boolean };

/** Clicks the toggle to close the pane and watches 600 ms: frames where the rail shows over the leaving aside. */
function closeAndWatch(page: Page): Promise<Closed> {
  return page.evaluate(({ toggle, rail, aside }) => new Promise<Closed>((resolve) => {
    let asideFrames = 0, railUnderAside = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const railNode = document.querySelector(rail);
      const asideNode = document.querySelector(aside);
      if (asideNode) asideFrames += 1;
      if (railNode && asideNode && getComputedStyle(railNode).visibility === "visible") {
        const a = railNode.getBoundingClientRect(), b = asideNode.getBoundingClientRect();
        if (Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)) railUnderAside += 1;
      }
      if (now - start < 600) requestAnimationFrame(tick);
      else resolve({ asideFrames, railUnderAside, railShown: Boolean(railNode && getComputedStyle(railNode).visibility === "visible") });
    };
    requestAnimationFrame(tick);
    (document.querySelector(toggle) as HTMLElement).click();
  }), { toggle: TOGGLE, rail: RAIL, aside: ASIDE });
}

/**
 * The background-browser rail beside the header and the 세션 정보 pane, with motion on: every title-bar
 * control stays hit-testable and clear of the rail (full rail at 1440, shelf at 1024), the rail and an
 * open pane never show together, and on close the rail shows only once the leaving pane has gone.
 */
export async function verifyRailBesidePane(browser: Browser, server: NativeAppServerHandle, view: SessionView) {
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ reduce_motion: false }) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: "no-preference" });
  try {
    await installSessionBrowser(page, agentTabs(view.session_id));
    await installPendingAskEvents(page);
    await replaySession(page, () => view);
    await page.addInitScript((id) => localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({
      schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), active_session_id: id, left_open: true, right_open: false })), view.session_id);
    await server.signIn(page);
    await page.goto(server.url);
    await page.locator(RAIL).waitFor();
    const controls = await assertHeaderClear(page, "full rail");
    const toggle = page.locator(TOGGLE);
    await toggle.click();
    await page.locator(`${ASIDE}[data-layout="docked"]`).waitFor();
    assert.equal(await toggle.getAttribute("aria-pressed"), "true", "The toggle opens the pane with the rail shown");
    assert.equal(await page.locator(RAIL).count(), 0, "The docked pane and the rail never show together");
    const closed = await closeAndWatch(page);
    assert(closed.asideFrames > 0, "The pane leaves with its exit motion");
    assert.equal(closed.railUnderAside, 0, "The rail shows only once the leaving pane has gone");
    assert(closed.railShown, "The rail is back once the pane has closed");
    assert.equal(await toggle.getAttribute("aria-pressed"), "false");
    await assertHeaderClear(page, "full rail after the pane closed");
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.waitForFunction((rail) => document.querySelector(rail)?.getAttribute("data-mode") === "shelf", RAIL);
    await assertHeaderClear(page, "shelf");
    console.log(JSON.stringify({ railBesidePane: { controls, closeAsideFrames: closed.asideFrames, railUnderAside: closed.railUnderAside } }));
  } finally {
    await page.close();
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ reduce_motion: true }) });
  }
}
