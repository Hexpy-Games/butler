import { strict as assert } from "node:assert";
import type { Browser, Page } from "playwright";
import type { NativeAppServerHandle } from "./native-app-server.ts";

const TOGGLE = '[data-test-class="session-info-toggle"]';
const ASIDE = '[data-slot="conversation-aside"]';

export async function newChatPositions(page: Page) {
  await page.locator('[data-test-class="new-chat-empty-state"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate(() => {
    const x = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().x;
    const title = document.querySelector('[data-slot="titlebar-title"]')!.getBoundingClientRect();
    return { composer: x('[data-test-class="composer-card"]'), column: x('[data-test-class="new-chat-empty-state"] header'),
      title: { x: title.x, y: title.y }, grouped: document.querySelector('[data-test-class="custom-titlebar"]')!.hasAttribute("data-grouped") };
  });
}

export async function verifyNewChatSessionInfo(browser: Browser, server: NativeAppServerHandle, sessionId: string,
  title: string, capture: (page: Page, name: string) => Promise<unknown>, theme: string) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: "reduce" });
  try {
    await page.addInitScript(id => {
      if (!localStorage.getItem("butler:app-ui-state:v1")) localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({
        schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), active_session_id: id,
        left_open: true, right_open: false, session_info_open: true,
      }));
    }, sessionId);
    await server.signIn(page);
    await page.goto(server.url);
    // Direct entry must load the linked epic even before the pane can mount.
    await page.locator(`${ASIDE} [data-session-section="task"]`).waitFor();
    const toggle = page.locator(TOGGLE);
    await toggle.click();
    await page.locator(ASIDE).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "새 대화", exact: true }).first().click();
    const closed = await newChatPositions(page);
    assert.equal(await toggle.count(), 0);
    assert.equal(await page.locator(ASIDE).count(), 0);
    await page.getByRole("button", { name: new RegExp(title) }).first().click();
    await toggle.waitFor();
    await toggle.click();
    await page.locator(ASIDE).waitFor();
    await page.getByRole("button", { name: "새 대화", exact: true }).first().click();
    await page.locator(ASIDE).waitFor({ state: "detached" });
    const prefOpen = await newChatPositions(page);
    assert.equal(await toggle.count(), 0);
    assert.deepEqual(prefOpen, closed, "Empty new chat keeps the closed column, composer and title positions");
    assert.equal(prefOpen.grouped, false, "No empty titlebar trailing group");
    await capture(page, "new-chat");
    await page.locator('[data-slot="composer-compact-preview"]').click();
    await page.locator('[contenteditable="true"]').fill("안녕하세요. 오늘의 작업을 정리해 주세요.");
    await page.getByRole("button", { name: "전송", exact: true }).click();
    await toggle.waitFor();
    await page.locator(ASIDE).waitFor();
    await capture(page, "first-message");
    await toggle.click();
    await page.locator(ASIDE).waitFor({ state: "detached" });
    await toggle.click();
    await page.locator(ASIDE).waitFor();
    await page.getByRole("button", { name: new RegExp(title) }).first().click();
    await page.locator(`${ASIDE} [data-session-section="task"]`).waitFor();
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
    await page.getByRole("button", { name: "새 대화", exact: true }).first().click();
    await page.locator(ASIDE).waitFor({ state: "detached" });
    assert.equal(await toggle.count(), 0);
    assert.deepEqual(await newChatPositions(page), closed);
    await page.getByRole("button", { name: new RegExp(title) }).first().click();
    await page.locator(`${ASIDE} [data-session-section="task"]`).waitFor();
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
    console.log(JSON.stringify({ newChatSessionInfo: "PASS", theme, closed, prefOpen, preferenceKept: true }));
  } finally { await page.close(); }
}
