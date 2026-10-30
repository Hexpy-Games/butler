import { strict as assert } from "node:assert";
import type { Browser } from "playwright";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import { replaySession } from "./session-info-fixtures.ts";
import type { SessionView } from "../../packages/butler-app/client/ui/src/app/types.ts";

/**
 * A session whose session-view load fails never gets a summary. The sections
 * that need none (pending asks, the canon task, the queue) and the toggle with its asks
 * dot must still show once the load has settled.
 */
export async function verifySessionViewFailure(browser: Browser, server: NativeAppServerHandle, view: SessionView) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: "reduce" });
  try {
    await replaySession(page, () => view);
    await page.route("**/session-view?**", route => route.fulfill({ status: 503, json: { error: { code: "unavailable" } } }));
    await page.addInitScript(id => localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({
      schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), active_session_id: id, left_open: true, right_open: false,
    })), view.session_id);
    await server.signIn(page);
    const failed = page.waitForResponse(response => response.url().includes("/session-view?") && response.status() === 503);
    await page.goto(server.url);
    await failed;
    const toggle = page.locator('[data-test-class="session-info-toggle"]');
    await page.waitForFunction(() => document.querySelector('[data-test-class="session-info-toggle"]')?.getAttribute("aria-label") === "세션 정보 · 답을 기다리는 요청 있음");
    assert.equal(await toggle.locator('[data-slot="icon-button-indicator"]').count(), 1, "the asks dot stays without a summary");
    await toggle.click();
    const aside = page.getByRole("complementary", { name: "세션 정보", exact: true });
    for (const id of ["asks", "task", "queue"]) await aside.locator(`[data-session-section="${id}"]`).waitFor();
    const sections = await aside.locator("[data-session-section]").evaluateAll(elements => elements.map(element => element.getAttribute("data-session-section")));
    assert.deepEqual(sections, ["asks", "task", "queue"], "only the sections that need no summary show");
    console.log(JSON.stringify({ sessionViewFailure: "PASS", sections }));
  } finally {
    await page.close();
  }
}
