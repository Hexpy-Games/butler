// Real native gateway, stub model, accepted/revised plan, durable activity history.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { liveDelegationBrowser } from "../support/live-delegation-browser.ts";
import {
  firstStepActivity, stepObjective, stepTitles, workCardStepsStub, workerCardTitle, workerObjective, workerStepTitles,
} from "../support/work-card-steps-stub.ts";
import { probeFocusRing, probeFocusRingFrames } from "../support/focus-ring-clipping.ts";

async function waitForHold(held: Promise<void>, message = "Child did not reach the held read") {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([held, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 30_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function openSteps(card: Locator, key = "collect sources") {
  const trigger = card.locator('[data-test-class="work-activity-disclosure-toggle"][aria-expanded]').first();
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
  await card.locator(`[data-step-key="${key}"]`).waitFor();
}

async function assertSteps(page: Page, card: Locator) {
  const groups = card.locator("[data-step-key]");
  assert.deepEqual(await groups.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-step-key"))),
    stepTitles);
  for (const [index, title] of stepTitles.entries()) {
    const group = groups.nth(index);
    await group.getByRole("button", { name: new RegExp(`${index + 1}\\. ${title}`) }).waitFor();
    assert.match(await group.locator('[data-slot="disclosure-row-meta"]').innerText(),
      index === 0 ? /완료 · .+–.+/ : index === 2 ? /^대기 중$/ : /진행 중 · .+부터/);
  }
  await groups.first().getByText(`내용: ${firstStepActivity}`, { exact: true }).first().waitFor();
  const revision = card.locator("[data-plan-revision]");
  assert.equal(await revision.count(), 1);
  assert.match(await revision.innerText(), /계획 수정 · 단계 1개 추가/);
  assert(await revision.evaluate(node => node.nextElementSibling?.getAttribute("data-step-key") === "check availability"));
  await page.keyboard.press("Tab");
  const trigger = groups.first().getByRole("button").first();
  const clips = await probeFocusRingFrames(page, () => trigger.focus());
  const probe = await probeFocusRing(page);
  assert(probe && !probe.noIndicator, "step header has a focus ring");
  assert.deepEqual([...clips, ...probe.clips], [], "step header ring is not clipped");
  await trigger.click();
  assert.equal(await trigger.getAttribute("aria-expanded"), "false", "finished step can collapse");
  await trigger.click();
}

async function scrollDetails(page: Page, card: Locator, edge: "top" | "bottom") {
  const scroll = card.locator('[data-test-class="work-block-details-scroll"]');
  await scroll.hover();
  await page.mouse.wheel(0, edge === "top" ? -100000 : 100000);
  await page.waitForFunction(([node, edge]) =>
    edge === "top" ? node!.scrollTop === 0 : node!.scrollHeight - node!.scrollTop - node!.clientHeight < 1,
  [await scroll.elementHandle(), edge] as const);
}

async function capture(card: Locator, name: string) {
  const output = process.env.BUTLER_SMOKE_SCREENSHOTS;
  if (!output) return;
  mkdirSync(output, { recursive: true });
  await card.screenshot({ path: join(output, `${name}.jpg`), type: "jpeg", quality: 80 });
}

const scratchRoot = join(tmpdir(), "wcs");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "steps-"));
const source = join(scratch, "source.txt");
writeFileSync(source, "Source notes for comparison\n");
const manifest = join(scratch, "app-update-manifest.json");
writeFileSync(manifest, JSON.stringify({ artifacts: [{ component: "app", version: "0.0.1", channel: "stable",
  staging_policy: "butler-data-updates", activation_policy: "user-installs-app-package", rollback_policy: "not-managed-by-butler" }] }));
const stub = workCardStepsStub(source);
stub.options.env = { BUTLER_APP_VERSION: "0.0.1", BUTLER_APP_UPDATE_MANIFEST: manifest };
let server: Awaited<ReturnType<typeof createNativeAppServer>> | undefined;
let browser: Awaited<ReturnType<typeof liveDelegationBrowser>> | undefined;
try {
  server = await createNativeAppServer(stub.options);
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ access_mode: "full_access" }) });
  browser = await liveDelegationBrowser(server);
  const { page } = browser;
  const errors: string[] = [];
  page.on("response", response => {
    if (response.status() >= 400) console.error(JSON.stringify({ status: response.status(), path: new URL(response.url()).pathname }));
  });
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() !== "error") return;
    // Pre-existing gateway CSP header issue outside this test.
    if (/^The source list for the Content Security Policy directive 'frame-src' contains an invalid source: 'http:\/\/\[::1\]:\d+'\. It will be ignored\.$/.test(message.text())) {
      console.info(message.text());
      return;
    }
    errors.push(message.text());
  });
  await server.signIn(page);
  await page.addInitScript(() => localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({
    schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), active_session_id: "general", left_open: false, right_open: false,
  })));
  await page.goto(server.url);
  await page.locator('[data-slot="composer-compact-preview"]').click();
  await page.locator('[contenteditable="true"]').fill(stepObjective);
  await page.locator('[data-test-class="composer-send-button"]').click();
  const card = page.locator('[data-test-class~="steward-parent-progress-card"]');
  await card.getByText("완료 1/4 · 지금: compare options, check availability", { exact: true }).waitFor();
  await waitForHold(stub.whenHeld());
  assert.equal(await card.getAttribute("id"), null, "card measurement adds no DOM id");
  for (const part of ["previous", "latest", "count"]) {
    assert(await card.locator(`[data-test-class="work-activity-tail-${part}"]`).count() > 0, `${part} tail remains present`);
  }
  assert.match(await card.locator('[data-test-class="work-activity-tail-count"]').last().innerText(), /\+\d+/);
  await capture(card, "steps-held-collapsed");
  await openSteps(card);
  await scrollDetails(page, card, "top");
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.mouse.move(1200, 900);
  await capture(card, "steps-held-expanded-top");
  await assertSteps(page, card);
  await scrollDetails(page, card, "bottom");
  await capture(card, "steps-held-expanded-bottom");
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: "dark" }) });
  await page.reload();
  await openSteps(card);
  await scrollDetails(page, card, "top");
  await card.locator('[data-step-key="check availability"]').scrollIntoViewIfNeeded();
  await capture(card, "steps-held-expanded-dark");
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: "light" }) });
  await page.reload();
  await openSteps(card);
  await card.locator('[data-test-class="work-activity-disclosure-toggle"][aria-expanded]').first().click();
  await page.setViewportSize({ width: 390, height: 844 });
  await card.getByText("지금: compare options 외 1", { exact: true }).waitFor();
  await capture(card, "steps-held-mobile");
  stub.advance();
  await card.getByText("완료됨 · 4/4 단계", { exact: true }).waitFor();
  await page.setViewportSize({ width: 1280, height: 1000 });
  await capture(card, "steps-delivered-collapsed");
  await openSteps(card);
  await card.locator('[data-step-key="collect sources"]').scrollIntoViewIfNeeded();
  await capture(card, "steps-delivered-expanded");
  await page.reload();
  await card.getByText("완료됨 · 4/4 단계", { exact: true }).waitFor();
  await openSteps(card);
  await card.locator('[data-step-key="collect sources"]').getByText(`내용: ${firstStepActivity}`, { exact: true }).first().waitFor();
  await card.locator('[data-step-key="collect sources"]').scrollIntoViewIfNeeded();
  await capture(card, "steps-reloaded-expanded");
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ max_simultaneous_workers: 2 }) });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('[data-slot="composer-compact-preview"]').click();
  await page.locator('[contenteditable="true"]').fill(workerObjective);
  await page.locator('[data-test-class="composer-send-button"]').click();
  const workerCard = page.locator(`[data-test-class~="steward-parent-progress-card"][aria-label="${workerCardTitle}"]`);
  await waitForHold(stub.whenWorkersHeld(), "Workers did not reach the held answer");
  await workerCard.getByText("완료 0/2 · 지금: research domestic, research overseas", { exact: true }).waitFor();
  const reopen = async () => {
    await openSteps(workerCard, "research domestic");
    await scrollDetails(page, workerCard, "top");
    await workerCard.locator('[data-step-key="research domestic"]').evaluate(node => node.scrollIntoView({ block: "start" }));
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    await page.mouse.move(1200, 900);
  };
  await reopen();
  await capture(workerCard, "workers-held-1440-light");
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: "dark" }) });
  await page.reload();
  await reopen();
  await capture(workerCard, "workers-held-1440-dark");
  await workerCard.locator('[data-test-class="work-activity-disclosure-toggle"][aria-expanded]').first().click();
  await page.setViewportSize({ width: 390, height: 844 });
  await workerCard.getByText("지금: research domestic 외 1", { exact: true }).waitFor();
  await reopen();
  await capture(workerCard, "workers-held-390-dark");
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: "light" }) });
  await page.reload();
  await reopen();
  await capture(workerCard, "workers-held-390-light");
  for (const title of workerStepTitles) {
    const capsule = workerCard.locator(`[data-step-key="${title}"] [data-test-class="step-worker-capsule"]`);
    assert.equal(await capsule.count(), 1);
    assert.match(await capsule.innerText(), new RegExp(`Research ${title}`));
  }
  assert.equal(await workerCard.locator('[data-test-class="step-worker-capsule"]').count(), 2);
  assert.deepEqual(errors, [], "no browser errors");
  console.log(JSON.stringify({ ok: true, browser: browser.name, steps: 4, workerSteps: 2, revisions: 1, viewport: 390, historyAfterReload: true }));
} catch (error) {
  console.error(JSON.stringify({ body: await browser?.page.locator("body").innerText(), calls: server?.stubModelCalls.length }));
  throw error;
} finally {
  stub.release();
  try { await browser?.close(); } finally {
    try { await server?.stop(); } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
}
