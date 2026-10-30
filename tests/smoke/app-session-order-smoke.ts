// test-category: race
// Stub-only native gateway smoke; four light/dark × desktop/phone cells.
// BUTLER_SMOKE_BASELINE=1 captures the same screens before the UI change.
import assert from "node:assert/strict";
import { assertNoCanonInstructions, assertStepActivity, completedPrefixDrop } from "../support/session-order-regressions.ts";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser.ts";
import { apiOrderEdit, installOrderPage, orderChat, orderItems, orderShape, readOrder, requestOrder, seedOrderPlan, stopOrderTurn, waitOrder } from "../support/session-order-fixtures.ts";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import type { CanonQueueEdit, CanonQueueView } from "../../packages/butler-app/client/shared/canon-queue-contracts.ts";
import { formatClips, probeFocusRing } from "../support/focus-ring-clipping.ts";

const cells = ["light-desktop", "dark-desktop", "light-phone", "dark-phone"];
if (await runSmokeCases(cells, "BUTLER_ORDER_CELL", import.meta.path, { isolate: true })) process.exit(0);
const [theme, device] = (process.env.BUTLER_ORDER_CELL ?? cells[0]).split("-") as ["light" | "dark", "desktop" | "phone"];
const lang = theme === "light" ? "ko" : "en";
const copy = getAppCopy(lang === "ko" ? "ko-KR" : "en-US");
const c = copy.canon.order;
const baseline = process.env.BUTLER_SMOKE_BASELINE === "1";
const shots = resolve(process.env.BUTLER_SMOKE_SCREENSHOTS ?? join(tmpdir(), "butler-session-order-shots"));
mkdirSync(shots, { recursive: true });
let release!: () => void;
const gate = new Promise<void>(done => { release = done; });
const host = await createNativeAppServer({ uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist"),
  stubTextStream: async function* () { yield "확인하고 있습니다."; await gate; },
});
const browser = await launchSmokeBrowser();
const errors: string[] = [];
let edits = 0;
const section = (page: Page) => page.locator('[data-session-section="order"]');
const grip = (page: Page, id: string, stack = false) => section(page).locator(`[data-step-grip="${stack ? "step" : "item"}:${id}"]`);
async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(shots, `${baseline ? "before" : "after"}-${theme}-${device}-${name}.png`), animations: "disabled", caret: "hide" });
}
try {
  await host.api("/settings", { method: "PATCH", body: JSON.stringify({ language: lang, appearance_theme: theme, reduce_motion: false, chats_intro_seen: true,
    wallpaper: { source: { kind: "none" } } }) });
  await singleStep();
  if (!baseline) await completedPrefixDrop(host, open, info, keyboardEdit, shot);
  const plain = await orderChat(host, "진행 순서 확인");
  await scenario(plain, "plain");
  await scenario("general", "bubble");
  assert.deepEqual(errors, [], "no page errors");
  console.log(JSON.stringify({ ok: true, theme, device, edits, stubModelCalls: host.stubModelCalls.length, shots }));
} catch (error) {
  for (const [index, page] of browser.contexts().flatMap(context => context.pages()).entries()) {
    await shot(page, `failure-${index}`).catch(() => undefined);
    console.error(JSON.stringify({ page: index, errors, text: (await page.locator("body").innerText()).slice(-4000) }));
  }
  throw error;
} finally { release(); await browser.close(); await host.stop(); }

async function open(id: string) {
  const page = await browser.newPage({ viewport: device === "phone" ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
  page.on("pageerror", error => errors.push(error.message));
  await installOrderPage(page, id, lang);
  await host.signIn(page);
  await page.goto(host.url);
  await page.locator('[data-test-class~="conversation"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page;
}
async function info(page: Page) {
  const toggle = page.locator('[data-test-class="session-info-toggle"]');
  if (!await page.getByRole("complementary", { name: copy.sessionInfo.title, exact: true }).isVisible()) await toggle.click();
  await page.getByRole("complementary", { name: copy.sessionInfo.title, exact: true }).waitFor();
}
async function closeInfo(page: Page) {
  await page.locator('[data-test-class="session-info-toggle"]').click();
  await page.getByRole("complementary", { name: copy.sessionInfo.title, exact: true }).waitFor({ state: "hidden" });
}
async function singleStep() {
  const id = await orderChat(host, "단일 과제");
  const page = await open(id);
  await info(page);
  await page.locator('[data-session-section="subtasks"]').waitFor();
  assert.equal(await section(page).count(), 0, "an open info panel has no empty order section");
  await shot(page, "empty");
  const { epics } = await seedOrderPlan(host, 1);
  await requestOrder(host, id, { op: "start_now", epic_id: epics[0]!.id });
  await waitOrder(host, id, view => view.counts.running === 1);
  if (!baseline) await assertStepActivity(page);
  await info(page);
  if (!baseline) { await section(page).waitFor(); assert.equal(await section(page).locator("[data-step-items]").count(), 1); }
  await shot(page, "single-start-now");
  await assertNoCanonInstructions(page);
  await page.unrouteAll({ behavior: "wait" });
  await page.close();
}
async function scenario(id: string, layout: string) {
  const { plan, epics } = await seedOrderPlan(host);
  const page = await open(id);
  await requestOrder(host, id, { op: "plan_run", plan_id: plan.id });
  await waitOrder(host, id, view => view.counts.running === 1 && view.counts.waiting === 4);
  await page.getByText("확인하고 있습니다.", { exact: true }).first().waitFor();
  assert.equal(await page.locator('[data-test-class="assistant-bubble"]').count() > 0, layout === "bubble", "both reply layouts are exercised");
  if (!baseline) await assertStepActivity(page);
  await info(page);
  if (!baseline) {
    await section(page).waitFor();
    const ids = await page.locator("[data-session-section]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-session-section")));
    assert(ids.indexOf("subtasks") >= 0, "the subtask section is present");
    assert.equal(ids[ids.indexOf("subtasks") + 1], "order");
    assert.equal(await section(page).locator("[data-step-items]").count(), 5);
    assert.equal(await grip(page, epics[0]!.id).count(), 0, "running is pinned");
    assert.equal(await section(page).locator('[data-step-items]').first().locator('[data-slot="card"]').getAttribute("data-activity"), "running");
    // A waiting step shows no status word; its caption already says what it waits for.
    const waitingRow = (await section(page).locator(`[data-step-item="${epics[1]!.id}"]`).innerText()).trim();
    for (const word of ["대기", "Waiting", ...(["ko-KR", "en-US"] as const).flatMap(locale => Object.values(getAppCopy(locale).canon.order.status))]) {
      assert(!waitingRow.includes(word), `waiting row shows no status word: ${waitingRow}`);
    }
  }
  await shot(page, `${layout}-running-plan`);
  if (layout === "plain") await editFlows(page, id, epics.map(epic => epic.id));
  await closeInfo(page);
  await stopOrderTurn(host, id);
  await waitOrder(host, id, view => view.counts.failed === 1 && view.counts.held > 0);
  const hold = page.locator('[data-test-class="canon-hold"]');
  if (!baseline) await hold.waitFor();
  await shot(page, `${layout}-hold`);
  await heldOrder(page, id, layout);
  await assertNoCanonInstructions(page);
  if (!baseline) {
    const decision = layout === "plain" ? "delete" : "continue";
    const response = page.waitForResponse(reply => reply.url().includes("/canon/queue/holds/") && reply.request().method() === "POST");
    await hold.getByRole("button", { name: decision === "delete" ? copy.canon.queue.remove : copy.canon.queue.proceed, exact: true }).click();
    assert((await response).ok());
    await page.locator('[data-test-class="canon-hold-settled"]').waitFor();
    await shot(page, `${layout}-hold-settled`);
  }
  const source = await orderChat(host, "다른 발표 준비");
  const other = await seedOrderPlan(host, 2);
  await requestOrder(host, source, { op: "plan_run", plan_id: other.plan.id });
  await waitOrder(host, source, view => view.counts.running === 1);
  // Initiated decisions are delivered after the current reply settles.
  if (!baseline) await stopOrderTurn(host, id);
  const elsewhere = await requestOrder(host, id, { op: "start_now", epic_id: other.epics[1]!.id }) as { code: string };
  assert.equal(elsewhere.code, "held_elsewhere");
  const take = page.locator('[data-test-class="canon-take-here"]');
  if (!baseline) await take.waitFor();
  await shot(page, `${layout}-take-here`);
  if (!baseline) {
    const response = page.waitForResponse(reply => reply.url().includes("/canon/queue/take/") && reply.request().method() === "POST");
    await take.getByRole("button", { name: copy.canon.queue.take, exact: true }).click();
    assert((await response).ok());
    await page.locator('[data-test-class="canon-take-settled"]').waitFor();
    const result = await waitOrder(host, id, view => orderItems(view).some(item => item.epic_id === other.epics[1]!.id));
    assert(orderItems(result).some(item => item.epic_id === other.epics[1]!.id));
    assert(!orderItems(await readOrder(host, source)).some(item => item.epic_id === other.epics[1]!.id));
  }
  await assertNoCanonInstructions(page);
  await page.unrouteAll({ behavior: "wait" });
  await page.close();
}
async function heldOrder(page: Page, id: string, layout: string) {
  await info(page);
  const view = await readOrder(host, id);
  const chain = view.chains.find(chain => chain.steps.some(step => step.items.some(item => item.state === "running" && item.hold_reason)))!;
  const head = chain.steps[0]!.items[0]!;
  const row = section(page).locator(`[data-step-item="${head.epic_id}"]`);
  await row.getByText(c.status.failed, { exact: true }).waitFor();
  await shot(page, `${layout}-held-order`);
  if (!baseline) {
    assert.equal(await row.locator('xpath=ancestor::*[@data-slot="card"][1]').getAttribute("data-activity"), null, "a blocked head has no running glow");
    assert.equal(await row.locator("svg").count(), 1, "the blocked alert marker remains");
    assert.equal(await grip(page, head.epic_id).count(), 0, "the blocked head stays pinned");
    assert.equal(await row.getByRole("button", { name: c.menu(head.title), exact: true }).count(), 0, "the blocked head has no menu");
    const last = chain.steps.at(-1)!.items[0]!;
    const edit = await keyboardEdit(page, id, last.epic_id, Array<string>(8).fill("ArrowUp"));
    assert.equal(edit.op, "move_to_new_step", "a blocked head takes no joins");
    assert.equal(edit.index, 1, "nothing drops before the blocked head");
    const next = (await readOrder(host, id)).chains.find(next => next.chain_id === chain.chain_id)!;
    assert.deepEqual(next.steps[0], chain.steps[0], "the blocked head retains its index and exact membership");
  }
  await closeInfo(page);
}
async function keyboardEdit(page: Page, id: string, item: string, keys: string[], stack = false) {
  await grip(page, item, stack).focus();
  await page.keyboard.press("Space");
  for (const key of keys) await page.keyboard.press(key);
  const reply = page.waitForResponse(response => response.url().endsWith("/canon/queue/edits") && response.request().method() === "POST");
  await page.keyboard.press("Space");
  const response = await reply;
  assert(response.ok(), await response.text());
  edits++;
  const body = response.request().postDataJSON() as CanonQueueEdit;
  const view = (await response.json()).data as CanonQueueView;
  await assertOrder(page, id, view);
  return body;
}
async function assertOrder(page: Page, id: string, view: CanonQueueView) {
  const expected = view.chains.filter(chain => chain.steps.some(step => step.items.some(item => item.state !== "done")))
    .flatMap(chain => {
      const first = chain.steps.findIndex(step => step.items.some(item => item.state !== "done"));
      return chain.steps.slice(first).map(step => step.items.map(item => item.epic_id).join(" "));
    });
  await page.waitForFunction(values => {
    const actual = [...document.querySelectorAll('[data-session-section="order"] [data-step-items]')].map(node => node.getAttribute("data-step-items"));
    return JSON.stringify(actual) === JSON.stringify(values);
  }, expected);
  assert.deepEqual(orderShape(await readOrder(host, id)), orderShape(view), "complete order round-trips through the gateway");
}
async function editFlows(page: Page, id: string, items: string[]) {
  const [, second, third] = items;
  const joined = await keyboardEdit(page, id, second!, ["ArrowDown"]);
  assert.equal(joined.op, "join_stack"); assert.equal(joined.target_epic_id, third);
  const stack = [third!, second!];
  if (!baseline) {
    const after = section(page).locator(`[data-step-item="${items[3]}"]`);
    await after.getByText(lang === "ko" ? "‘발표 자료 외 1건’ 끝나면" : "After ‘발표 자료’ +1 more", { exact: true }).waitFor();
  }
  await shot(page, "stack");
  const moved = await keyboardEdit(page, id, third!, ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown"], true);
  assert.deepEqual(moved.epic_ids, stack, "a collapsed stack moves as an ordered selection");
  assert.equal(moved.epic_id, undefined); assert.equal(moved.index, 3);
  await section(page).getByRole("button", { name: c.deck.expand(2, "발표 자료"), exact: true }).click();
  await shot(page, "stack-expanded");
  const split = await keyboardEdit(page, id, second!, ["ArrowUp"]);
  assert.equal(split.op, "move_to_new_step"); assert.equal(split.index, 3);
  const focus = grip(page, second!);
  await focus.focus();
  const probe = await probeFocusRing(page);
  assert(probe && !probe.noIndicator, "keyboard focus has an indicator");
  assert.equal(probe.clips.length, 0, formatClips(probe.clips));
  await shot(page, "keyboard-focus");
  await focus.scrollIntoViewIfNeeded();
  const box = (await focus.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2, box.y - 30, { steps: 6 });
  await section(page).locator('[data-dragging="pointer"]').waitFor();
  await shot(page, "drag-mid-gesture");
  await page.keyboard.press("Escape"); await page.mouse.up();
  await section(page).getByRole("button", { name: c.menu("발표 자료"), exact: true }).click();
  await page.getByRole("menuitem", { name: c.startNow, exact: true }).waitFor();
  await shot(page, "menu-open");
  await page.keyboard.press("Escape");
  await conflictAndRollback(page, id, second!);
  await keyboardEdit(page, id, second!, ["ArrowUp"]);
  const current = await readOrder(host, id);
  const stackFront = current.chains.flatMap(chain => chain.steps).find(step => step.items.length > 1)!.items[0]!;
  await menuEdit(page, id, stackFront.title, c.unstack, "split_stack");
  const secondTitle = orderItems(current).find(item => item.epic_id === second)!.title;
  await menuEdit(page, id, secondTitle, c.remove, "delete");
  await menuEdit(page, id, "발표 자료", c.startNow, "start_now");
}
async function conflictAndRollback(page: Page, id: string, item: string) {
  const endpoint = `**/sessions/${id}/canon/queue/edits`;
  await page.route(endpoint, async route => {
    const current = await readOrder(host, id);
    const chain = current.chains[0]!;
    const last = chain.steps.at(-1)!.items[0]!.epic_id;
    await apiOrderEdit(host, id, { op: "move_to_new_step", epic_id: last, index: 1 });
    await route.continue();
  }, { times: 1 });
  await grip(page, item).focus(); await page.keyboard.press("Space"); await page.keyboard.press("ArrowUp");
  const conflict = page.waitForResponse(response => response.url().endsWith("/canon/queue/edits") && response.status() === 409);
  await page.keyboard.press("Space"); await conflict;
  await page.getByText(c.changed, { exact: true }).waitFor();
  await assertOrder(page, id, await readOrder(host, id));
  const before = await readOrder(host, id);
  await page.route(endpoint, route => route.fulfill({ status: 500, json: { error: { code: "internal" } } }), { times: 1 });
  await grip(page, item).focus(); await page.keyboard.press("Space"); await page.keyboard.press("ArrowUp");
  const failed = page.waitForResponse(response => response.url().endsWith("/canon/queue/edits") && response.status() === 500);
  await page.keyboard.press("Space"); await failed;
  await page.getByText(c.failed, { exact: true }).waitFor();
  await assertOrder(page, id, before);
}

async function menuEdit(page: Page, id: string, title: string, action: string, op: string) {
  await section(page).getByRole("button", { name: c.menu(title), exact: true }).click();
  const reply = page.waitForResponse(response => response.url().endsWith("/canon/queue/edits") && response.request().method() === "POST");
  await page.getByRole("menuitem", { name: action, exact: true }).click();
  const response = await reply;
  assert(response.ok(), await response.text());
  assert.equal(response.request().postDataJSON().op, op);
  edits++;
  await assertOrder(page, id, (await response.json()).data as CanonQueueView);
}
