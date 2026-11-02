// test-category: race
// The right pane's hold for a native view, in the harness: a stub bridge whose stills the test releases by hand.
import { strict as assert } from "node:assert";
import type { Browser } from "playwright";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import { installPendingAskEvents, installSessionBrowser, replaySession } from "./session-info-fixtures.ts";
import type { SessionView } from "../../packages/butler-app/client/ui/src/app/types.ts";
import { CHAT, PANE, SEPARATOR, TOGGLE, settled } from "./split-motion-frames.ts";

type StillStub = { manual: boolean; pending: Array<() => void>; calls: number };
declare global { interface Window { __stills: StillStub } }

const STILL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const paneLeft = `document.querySelector(${JSON.stringify(PANE)})?.getBoundingClientRect().left`;

/** Clicks the toggle mid-motion and counts the frames until the pane moves again from where the click found it. */
const framesToMove = (clickAfter: number) => `new Promise((resolve) => {
  setTimeout(() => {
    const at = ${paneLeft};
    document.querySelector(${JSON.stringify(TOGGLE)}).click();
    let frames = 0;
    const tick = () => {
      frames += 1;
      const left = ${paneLeft};
      if (left !== undefined && Math.abs(left - at) > 1) resolve({ frames, running: true });
      else if (frames > 40) resolve({ frames, running: false });
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, ${clickAfter});
})`;

/** Holds, re-toggles and stale captures with a tab whose native slot is live. */
export async function verifyNativeHold(browser: Browser, server: NativeAppServerHandle, session: string, view: SessionView) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: "no-preference" });
  const facts: Record<string, unknown> = {};
  try {
    await installSessionBrowser(page, [{ id: "motion-tab", owner: `conversation:${session}`, title: "Running page", url: "https://example.com/", favicon: "", status: "idle", canBack: false, canForward: false }]);
    await page.addInitScript((still) => {
      const bridge = (window as unknown as { butlerBrowser: { call: (method: string, input?: unknown) => Promise<unknown> } }).butlerBrowser;
      const call = bridge.call;
      window.__stills = { manual: false, pending: [], calls: 0 };
      bridge.call = (method, input) => {
        if (method !== "still") return call(method, input);
        window.__stills.calls += 1;
        return new Promise((resolve) => {
          const release = () => resolve(still);
          if (window.__stills.manual) window.__stills.pending.push(release); else setTimeout(release, 10);
        });
      };
    }, STILL);
    await installPendingAskEvents(page);
    await replaySession(page, () => view);
    await page.addInitScript((id) => { if (!localStorage.getItem("butler:app-ui-state:v1")) localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({
      schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), active_session_id: id, left_open: true, right_open: false })); }, session);
    await server.signIn(page);
    await page.goto(server.url);
    const toggle = page.locator(TOGGLE);
    await toggle.waitFor();
    await page.waitForTimeout(500);
    if (await toggle.getAttribute("aria-pressed") === "false") await toggle.click();
    await page.locator(PANE).waitFor();
    await page.waitForFunction((pane) => document.querySelector(pane)?.querySelector('[data-slot="native-view-slot"]:not([data-hidden])'), PANE);
    await settled(page);
    await page.waitForTimeout(300);

    // A toggle while the still already stands in continues at once: no second wait for it.
    const midClose = await page.evaluate(`(() => { document.querySelector(${JSON.stringify(TOGGLE)}).click(); return ${framesToMove(120)}; })()`) as { frames: number; running: boolean };
    assert(midClose.running, "the pane moves after the mid-motion toggle");
    assert(midClose.frames <= 3, `a toggle mid-motion moves at once, not after a second hold (${midClose.frames} frames)`);
    facts.toggleMidMotion = midClose;
    await settled(page);
    await page.waitForTimeout(300);

    // An older capture settling must not release a newer hold: only the newest covering's still does.
    await toggle.click();
    await page.locator(PANE).waitFor({ state: "detached" });
    await settled(page);
    await page.evaluate(() => { window.__stills.manual = true; });
    await toggle.click();
    await page.waitForFunction(() => window.__stills.pending.length > 0);
    await page.waitForFunction((pane) => document.querySelector(pane)?.querySelector('[data-slot="native-view-slot"]')?.hasAttribute("data-occluded"), PANE);
    // A resize settles the held motion and uncovers the view, with the first capture still out.
    await page.locator(SEPARATOR).evaluate((node) => node.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    await page.waitForFunction((pane) => !document.querySelector(pane)?.querySelector('[data-slot="native-view-slot"]')?.hasAttribute("data-occluded"), PANE);
    const older = await page.evaluate(() => window.__stills.pending.length);
    await toggle.click();
    await page.waitForFunction((count) => window.__stills.pending.length > count, older);
    const before = await page.evaluate(paneLeft) as number;
    await page.evaluate((count) => { for (const release of window.__stills.pending.splice(0, count)) release(); }, older);
    await page.waitForTimeout(120);
    const held = await page.evaluate(paneLeft) as number;
    assert.equal(held, before, "an older capture settling leaves the newer hold on");
    await page.evaluate(() => { window.__stills.manual = false; for (const release of window.__stills.pending.splice(0)) release(); });
    await page.waitForFunction((pane) => !document.querySelector(pane), PANE);
    facts.staleCapture = { older, heldAt: held };
    assert.equal(await page.locator(CHAT).evaluate((node) => node.getAnimations().length), 0, "nothing stays held on the chat");
  } finally {
    await page.close();
  }
  return facts;
}
