// test-category: race
import { strict as assert } from "node:assert";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import type { SessionView } from "../../packages/butler-app/client/ui/src/app/types.ts";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import { installPendingAskEvents, installSessionBrowser, replaySession } from "./session-info-fixtures.ts";

const ASIDE = '[data-slot="conversation-aside"]';
const SECTION = '[data-session-section="browser"]';
const TOGGLE = '[data-test-class="session-info-toggle"]';
const RAIL = '[data-slot="tab-rail"] > section';
const CARD = '[data-slot="live-tab-card"]';

type BrowserProof = Window & {
  __liveFrameSubs: Map<string, number>;
  __browserState: { activeId: string | null };
  __browserCalls: { method: string; input?: { id?: string } }[];
};

function browserTabs(session: string) {
  return ["자료 검토", "확인 요청"].map((title, index) => ({
    id: `session-browser-${index}`, owner: `conversation:${session}`, title, url: `https://example.com/${index}`,
    favicon: "", agent: true, holder: "agent", agentAt: 1_760_000_000_000 - index, status: "idle",
    canBack: false, canForward: false, ...(index ? { waiting: true } : { busy: true }),
  }));
}

function waitSubscriptions(page: Page, ids: string[]) {
  return page.waitForFunction(ids => {
    const subs = (window as unknown as BrowserProof).__liveFrameSubs;
    return subs.size === ids.length && ids.every(id => subs.get(id) === 1);
  }, ids);
}

async function capture(page: Page, shots: string, name: string, theme: string, raised = false) {
  const aside = (await page.locator(ASIDE).boundingBox())!;
  const pane = raised ? (await page.locator('[data-test-class="browser-area"]').boundingBox())! : aside;
  const viewport = page.viewportSize()!;
  const x = Math.max(0, Math.min(aside.x, pane.x));
  const y = Math.max(0, Math.min(aside.y, pane.y));
  await page.screenshot({ path: join(shots, `si-browser-${name}-${theme}.png`), animations: "disabled",
    clip: { x, y, width: Math.min(viewport.width, Math.max(aside.x + aside.width, pane.x + pane.width)) - x,
      height: Math.min(viewport.height, Math.max(aside.y + aside.height, pane.y + pane.height)) - y } });
}

async function verifyPause(page: Page, ids: string[]) {
  await waitSubscriptions(page, ids);
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.locator('[data-slot="conversation-aside-scroll"]').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await waitSubscriptions(page, []);
  await page.locator(SECTION).scrollIntoViewIfNeeded();
  await waitSubscriptions(page, ids);
  // Exercise the same visibilitychange event the browser emits on backgrounding.
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await waitSubscriptions(page, []);
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "hidden");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await waitSubscriptions(page, ids);
  await page.setViewportSize({ width: 1440, height: 1050 });
}

async function verifyRaised(page: Page, id: string, needsYou = false) {
  await page.locator(SECTION).getByRole("button", needsYou
    ? { name: "열어서 확인", exact: true } : { name: /^자료 검토 ·/u }).click();
  await page.locator('[data-test-class="browser-area"]').waitFor();
  await page.locator(`${ASIDE}[data-layout="floating"]`).waitFor();
  await page.locator(`${ASIDE}[data-layout="docked"]`).waitFor({ state: "hidden" });
  await page.waitForFunction(id => {
    const proof = window as unknown as BrowserProof;
    return proof.__browserState.activeId === id
      && proof.__browserCalls.some(call => call.method === "activate" && call.input?.id === id);
  }, id);
}

async function verifyTwoTabs(page: Page, ids: string[], shots: string, theme: string) {
  const section = page.locator(SECTION);
  const order = await page.locator(`${ASIDE} [data-session-section]`).evaluateAll(nodes => nodes.map(node => node.getAttribute("data-session-section")));
  assert.deepEqual(order.slice(0, 3), ["asks", "browser", "environment"]);
  assert.equal(await section.getByText("브라우저", { exact: true }).count(), 1);
  assert.equal(await section.getByText("2", { exact: true }).count(), 1);
  assert.equal(await section.locator(CARD).count(), 2);
  assert.equal(await section.locator(CARD).first().getAttribute("data-state"), "attention");
  assert.match((await section.locator(CARD).first().textContent())!, /확인 요청/u);
  assert.equal(await page.locator(RAIL).count(), 0);
  await verifyPause(page, ids);
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.locator(`${ASIDE}[data-layout="floating"]`).waitFor();
  await page.locator(`${ASIDE}[data-layout="docked"]`).waitFor({ state: "hidden" });
  await section.scrollIntoViewIfNeeded();
  await waitSubscriptions(page, ids);
  await capture(page, shots, "floating-1024", theme);
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.locator(`${ASIDE}[data-layout="docked"]`).waitFor();
  await page.locator(`${ASIDE}[data-layout="floating"]`).waitFor({ state: "hidden" });
  await verifyRaised(page, ids[0]!);
  await capture(page, shots, "raised", theme, true);
  await verifyRaised(page, ids[1]!, true);
  await page.locator(TOGGLE).click();
  await page.locator(ASIDE).waitFor({ state: "hidden" });
  await waitSubscriptions(page, []);
  await page.locator('[data-test-class="titlebar-browser-toggle"]').click();
  await page.locator('[data-test-class="browser-area"]').waitFor({ state: "hidden" });
  await page.locator(RAIL).waitFor();
  await page.locator(TOGGLE).click();
  await page.locator(ASIDE).waitFor();
  await page.locator(TOGGLE).click();
  await page.locator(ASIDE).waitFor({ state: "hidden" });
  await page.locator(RAIL).waitFor();
  console.log(JSON.stringify({ sessionInfoBrowser: { theme, tabs: ids.length, order: order.slice(0, 3), pause: "scroll/document/close", raisedTab: ids[0], railRestored: true } }));
}

/** Real live-frame decoding, section order, shared right slot, stream lifetime and review captures. */
export async function verifySessionInfoBrowser(browser: Browser, server: NativeAppServerHandle, view: SessionView, shots: string, theme: string) {
  for (const count of [0, 1, 2]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      const tabs = browserTabs(view.session_id).slice(0, count);
      await installSessionBrowser(page, tabs);
      await installPendingAskEvents(page);
      await replaySession(page, () => view);
      await page.addInitScript(id => localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({
        schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), active_session_id: id, left_open: true, right_open: false,
      })), view.session_id);
      await server.signIn(page);
      await page.goto(server.url);
      await page.locator(TOGGLE).click();
      await page.locator(`${ASIDE}[data-layout="docked"]`).waitFor();
      await page.locator(`${ASIDE} [data-session-section="environment"]`).waitFor();
      if (count) {
        await page.locator(SECTION).scrollIntoViewIfNeeded();
        await waitSubscriptions(page, tabs.map(tab => tab.id));
        await page.waitForFunction(({ section, count }) => document.querySelectorAll(`${section} [data-slot="live-tab-canvas"]`).length === count, { section: SECTION, count });
      } else {
        assert.equal(await page.locator(SECTION).count(), 0);
      }
      await capture(page, shots, ["none", "one", "two"][count]!, theme);
      if (count === 2) await verifyTwoTabs(page, tabs.map(tab => tab.id), shots, theme);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  }
}
