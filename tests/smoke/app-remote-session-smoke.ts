// test-category: race
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { errors, type Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import {
  installRemoteSessionGateway, remoteComputer, remoteSessionOrigin, unreachableComputer, unconfiguredComputer,
} from "../support/remote-session-fixtures";
import { launchSmokeBrowser } from "../support/smoke-browser";

const output = process.env.BUTLER_SMOKE_SCREENSHOTS;
const variants = [
  ["ko", "light", 1280, 900],
  ["ko", "dark", 1280, 900],
  ["ko", "light", 375, 812],
  ["en", "light", 1280, 900],
] as const;
let captures = 0;
if (output) mkdirSync(output, { recursive: true });

async function verify(page: Page, [language, theme, width]: typeof variants[number]) {
  const copy = getAppCopy(language === "ko" ? "ko-KR" : "en-US");
  const c = copy.computers;
  const fake = await installRemoteSessionGateway(page, language, theme);
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  const composer = page.getByRole("textbox", { name: copy.composer.messageComposer });
  const picker = page.getByRole("combobox", { name: c.location });
  const title = language === "ko" ? "작업실에서 자료 정리" : "Organize notes in the studio";
  const sidebar = page.locator('[data-test-class="sidebar-slot"]');
  const row = sidebar.getByRole("button", { name: title, exact: true });
  const tab = (name: string) => sidebar.getByRole("radio", { name, exact: true });

  async function shot(state: string) {
    if (!output) return;
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    });
    await page.screenshot({ path: join(output, `${state}-${language}-${theme}-${width}.png`), animations: "disabled" });
    captures++;
  }

  async function openSidebar() {
    const show = button(copy.titlebar.showLeftPanel);
    if (await show.isVisible()) await show.click();
    await tab(copy.space.all).waitFor();
  }

  const empty = page.waitForResponse(`${remoteSessionOrigin}/computers`);
  await page.goto(remoteSessionOrigin);
  await composer.waitFor();
  assert.equal((await empty).status(), 200);
  assert.equal(await picker.count(), 0);
  fake.computers = true;
  const connection = page.waitForResponse(`${remoteSessionOrigin}/computers/${unreachableComputer.id}/connection`);
  await page.reload();
  await picker.getByText(c.thisComputer, { exact: true }).waitFor();
  await shot("B1");
  assert.equal((await connection).status(), 200);

  await picker.click();
  const option = (name: string) => page.getByRole("option", { name, exact: true });
  assert(await option(`${unreachableComputer.name} · ${c.status.disconnected}`).isDisabled());
  assert(await option(`${unconfiguredComputer.name} · ${c.status.aiNeeded}`).isDisabled());
  await shot("B2");
  await option(remoteComputer.name).click();
  await picker.getByText(remoteComputer.name, { exact: true }).waitFor();
  await shot("B3");
  await composer.fill(title);
  const created = page.waitForResponse((response) => new URL(response.url()).pathname === "/sessions" && response.request().method() === "POST");
  await button(copy.composer.send).click();
  assert.equal((await created).status(), 201);
  assert.equal(fake.createBody?.computer_id, remoteComputer.id);
  await page.locator('[data-test-class="titlebar-title"]').getByText(title, { exact: true }).waitFor();
  await picker.waitFor({ state: "hidden" });
  const subtitle = page.locator('[data-test-class="titlebar-subtitle"]').getByText(remoteComputer.name, { exact: true });
  await subtitle.waitFor({ state: width === 375 ? "hidden" : "visible" });
  await shot("C2");

  await openSidebar();
  await tab(copy.space.all).click();
  const caption = row.getByText(remoteComputer.name, { exact: true });
  await caption.waitFor();
  assert((await caption.boundingBox())!.y > (await row.getByText(title, { exact: true }).boundingBox())!.y);
  await shot("C1");
  const flatCaption = row.getByText(`${copy.space.space} · ${remoteComputer.name}`, { exact: true });
  await tab(copy.space.recent).click();
  await flatCaption.waitFor();
  await tab(copy.space.running).click();
  await flatCaption.waitFor();
  await row.getByText(copy.space.attention, { exact: true }).waitFor();
  await shot("C3");

  const attentionToast = page.locator("[data-sonner-toast]:visible")
    .filter({ hasText: `${title} · ${copy.space.attention}` });
  if (await attentionToast.isVisible()) {
    await attentionToast.getByRole("button", { name: "Close toast", exact: true }).click();
    await attentionToast.waitFor({ state: "hidden" });
  }
  await sidebar.getByRole("button", { name: copy.sidebar.newChat, exact: true }).first().click();
  await picker.waitFor();
  await openSidebar();
  fake.unreachable = true;
  await row.click();
  if (width > 375) await button(copy.titlebar.hideLeftPanel).click();
  const notice = page.getByText(c.unreachable(remoteComputer.name), { exact: true });
  await notice.waitFor();
  const blocked = button(c.status.disconnected);
  assert(await blocked.isDisabled());
  await blocked.hover({ force: true });
  await page.getByRole("tooltip").getByText(c.status.disconnected, { exact: true }).waitFor();
  await shot("D1");
  await button(copy.feedback.reconnect).click();
  await notice.waitFor({ state: "hidden" });
  assert.equal(fake.reconnects, 1);
  fake.showMemoryFailure();
  const reloaded = page.waitForResponse((response) => new URL(response.url()).pathname === "/session-view");
  await fake.emit("remote.connection_changed", { computer_id: remoteComputer.id, state: "connected" });
  assert.equal((await reloaded).status(), 200);
  await button(copy.composer.send).waitFor();

  const history = page.locator('[data-test-class="toggle-turn-activity-disclosure"]');
  await history.click();
  await page.locator('[data-test-class~="turn-work-tool-row"]').getByRole("button").click();
  await page.getByText(c.mainNotConnected, { exact: true }).waitFor();
  assert.equal(await page.getByText("Raw gateway diagnostic").count(), 0);
  await shot("D2");

  const info = page.locator('[data-test-class="session-info-toggle"]');
  await info.waitFor();
  await shot("E1a");
  await info.click();
  await page.getByText(copy.sessionInfo.runLocation, { exact: true }).waitFor();
  await shot("E2");
  if (await info.isVisible()) await info.click();
  else await button(copy.common.close).click();

  const p = c.pendingInstruction;
  fake.pending = [{ id: "remember", action: "remember", text: "Keep drafts in the project folder.", conflict: false, current: null }];
  await fake.emit("remote.instruction_pending", { computer_id: remoteComputer.id });
  await button(p.saved(remoteComputer.name)).waitFor();
  await shot("F1");
  await button(p.apply).click();
  await button(p.saved(remoteComputer.name)).waitFor({ state: "hidden" });
  assert.deepEqual(fake.decisions[0]?.body, { decision: "apply" });

  fake.pending = [{ id: "replace", action: "replace", text: "Use a weekly report.", conflict: true,
    current: { text: "Use a daily report.", revision: "r2" } }];
  await fake.emit("remote.instruction_pending", { computer_id: remoteComputer.id });
  await page.getByText(p.current, { exact: true }).waitFor();
  await page.getByText(p.incoming(remoteComputer.name), { exact: true }).waitFor();
  await page.getByText(p.replaceNotice, { exact: true }).waitFor();
  await shot("F2");
  await button(p.discard).click();
  await button(p.saved(remoteComputer.name)).waitFor({ state: "hidden" });
  assert.deepEqual(fake.decisions[1]?.body, { decision: "discard", expected_revision: "r2" });

  fake.pending = [{ id: "removed", action: "replace", text: "Use a weekly report.", conflict: true, current: null }];
  await fake.emit("remote.instruction_pending", { computer_id: remoteComputer.id });
  const apply = button(p.apply);
  await apply.waitFor();
  assert(await apply.isDisabled());
  await shot("F3");
  await Promise.all([
    assert.rejects(page.waitForRequest((request) => request.method() === "POST" &&
      new URL(request.url()).pathname === "/memory/instructions/pending/removed",
    { timeout: 500 }), errors.TimeoutError),
    apply.dispatchEvent("click"),
  ]);
}

const browser = await launchSmokeBrowser();
try {
  for (const variant of output ? variants : [variants[0]]) {
    const page = await browser.newPage({ viewport: { width: variant[2], height: variant[3] }, reducedMotion: "reduce" });
    try {
      await verify(page, variant);
    } finally {
      await page.close();
    }
  }
  console.log(JSON.stringify({ ok: true, captures }));
} finally {
  await browser.close();
}
