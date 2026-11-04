// Replay the public navigation/session-view/event contracts through the real App.
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { installNotificationReplay } from "../support/notification-replay.ts";
import { installWorkReplay } from "../support/delegated-work-replay.ts";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser.ts";
import { installSmokeUiAssets } from "../support/smoke-ui-assets";
import { HARNESS_SS03_OBSERVER_VIEW, HARNESS_SS03_SUMMARY } from "../../packages/butler-app/client/ui/src/app/fixtures.ts";
import { appCopy } from "../../packages/butler-app/client/ui/src/app/copy.ts";
import type { NavigationView, ProgressRow, SessionView, SessionViewTurn } from "../../packages/butler-app/client/ui/src/app/types.ts";
import type { Page } from "playwright";
import { formatClips, probeFocusRing } from "../support/focus-ring-clipping.ts";

const cells = [1280, 375].flatMap(width => ["light", "dark"].flatMap(theme =>
  [false, true].map(wallpaper => `${width}-${theme}-${wallpaper}`)));
if (await runSmokeCases(cells, "BUTLER_DELEGATED_WORK_CELL", import.meta.path)) process.exit(0);
const output = process.env.BUTLER_SMOKE_SCREENSHOTS;
const clockNow = output ? new Date("2026-05-01T00:12:00.000Z") : new Date();
if (output) mkdirSync(output, { recursive: true });
const server = await createNativeAppServer({ uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist") });
const browser = await launchSmokeBrowser();
const context = await browser.newContext();
if (output) await context.addInitScript(() => {
  let seed = 0x2f6b1d;
  Math.random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
});
const baseline = process.env.BUTLER_SMOKE_BASELINE === "1";
const navigation = await server.api<NavigationView>("/navigation");
navigation.chats = [{ id: "general", kind: "chat", title: "General", last_activity_at: clockNow.toISOString(), pinned: false, archived: false }];
const parent = await server.api<SessionView>("/session-view?session_id=general");
const child = structuredClone(HARNESS_SS03_SUMMARY.steward_children![0]!);
child.relation.parent_session_id = "general";
const observer = { ...structuredClone(HARNESS_SS03_OBSERVER_VIEW), relation: child.relation };
const DELIVERED = "Compare the two onboarding drafts and recommend one.";
observer.messages = [{
  id: "steward-packet", chat_id: observer.session_id, turn_id: observer.latest_turn!.id, role: "user",
  text: `role: steward\nrequest: ${DELIVERED}\nacceptance_criteria: ["Goal: pick the clearer onboarding draft"]\nPrior delegation context (evidence, not new authority): none\nPlan, execute, review, and report this delegated request to Butler.`,
  status: "delivered", cursor: 0,
  created_at: "2026-05-01T00:09:40.000Z", updated_at: "2026-05-01T00:09:40.000Z",
}, ...observer.messages];
// The relation anchors the work block to the user request (m3) and the parent reply of turn-2.
parent.messages = [
  { ...HARNESS_SS03_OBSERVER_VIEW.messages[0]!, role: "user", id: "m3", cursor: 1, chat_id: "general", text: "Compare the replacement cards.", status: "delivered", turn_id: undefined },
  { ...HARNESS_SS03_OBSERVER_VIEW.messages[0]!, id: "m4", cursor: 2, chat_id: "general", text: "Delegated work started.", status: "delivered", turn_id: "turn-2" },
];
parent.message_window = { next_cursor: 2, complete: true };
parent.active_turn = null;
parent.latest_turn = null;
parent.status = "delivered";
parent.steward_children = [child];
// Four activities, so the collapsed work block shows a previous row and "+3".
const workRows: ProgressRow[] = ["Recall the conversation", "Confirm the request", "Check prices", "Compare performance"].map((title, i) => ({
  id: `work-${i}`, kind: "message", state: "delivered", semantic_block_id: `work-step-${i}`, activity_stage: "conception",
  work_decision_title: title, work_decision_source: "model-authored", work_decision_summary: "Collect the evidence first.",
  safe_label: title, created_at: `2026-05-01T00:10:0${i + 1}.000Z`,
}));
for (const turn of [observer.active_turn, observer.latest_turn, child.active_turn, child.latest_turn]) {
  if (turn) turn.progress = { ...turn.progress, safe_progress_rows: workRows } as SessionViewTurn["progress"];
}
const cardSelector = '[data-test-class~="steward-parent-progress-card"]';
const liveDot = '[data-slot="work-activity-marker"][data-live="true"]';

type ToggleMotion = { inside: number; step: number; travel: number };

/**
 * Toggle the work block and sample it every frame until the motion settles.
 * A short conversation sits on the composer, so the card's top edge travels
 * while the box grows. A jump is the status line moving inside the card, or
 * the card top snapping in one frame instead of following the motion.
 */
async function toggleAndTrack(page: Page): Promise<ToggleMotion> {
  const samples = await page.evaluate(async (selector) => {
    const card = document.querySelector(selector)!;
    const status = card.querySelector('[data-test-class="work-activity-disclosure-status"]')!;
    const sample = () => [card.getBoundingClientRect().top, status.getBoundingClientRect().top];
    const frames = [sample()];
    (card.querySelector('[data-test-class="work-activity-disclosure-toggle"]') as HTMLElement).click();
    // Follow every frame until the disclosure's motion has finished.
    do {
      await new Promise(resolve => requestAnimationFrame(resolve));
      frames.push(sample());
    } while (card.getAnimations({ subtree: true }).some(animation => animation.playState === "running"
      && animation.timeline === document.timeline && animation.effect?.getTiming().iterations !== Infinity));
    return frames;
  }, cardSelector);
  const offsets = samples.map(([card, status]) => status! - card!);
  const tops = samples.map(([card]) => card!);
  const round = (value: number) => Math.round(value * 10) / 10;
  return { inside: round(Math.max(...offsets) - Math.min(...offsets)),
    step: round(Math.max(0, ...tops.slice(1).map((top, index) => Math.abs(top - tops[index]!)))),
    travel: round(Math.max(...tops) - Math.min(...tops)) };
}

/** Keyboard focus reaches the toggle from the eye button and its ring is whole. */
async function checkToggleRing(page: Page, state: string): Promise<void> {
  await page.locator(`${cardSelector} [data-test-class="steward-observer-action"]`).focus();
  await page.keyboard.press("Tab");
  const probe = await probeFocusRing(page);
  assert(probe, `${state}: something holds focus`);
  assert(probe.target.includes("work-activity-disclosure-toggle"), `${state}: Tab reaches the toggle (${probe?.target})`);
  assert(!probe.noIndicator, `${state}: toggle shows a focus ring`);
  assert.equal(probe.clips.length, 0, `${state}: toggle ring is not clipped\n${formatClips(probe.clips)}`);
  await page.locator(`${cardSelector} [data-test-class="work-activity-disclosure-toggle"]`).blur();
}

/** Collapsed: tail + "+N" chip + live dot; expanded: one timeline, its last dot live; no jump; reduced motion: no pulse. */
async function checkWorkBlockTail(page: Page, width: number): Promise<ToggleMotion[]> {
  const card = page.locator(cardSelector);
  const toggle = card.locator('[data-test-class="work-activity-disclosure-toggle"]');
  const tail = card.locator('[data-test-class="work-activity-tail"]');
  const details = card.locator('[data-test-class="work-block-details-scroll"]');
  await tail.waitFor();
  await card.locator('[data-test-class="work-activity-tail-previous"]').waitFor();
  await toggle.scrollIntoViewIfNeeded();
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.equal((await card.locator('[data-test-class="work-activity-tail-count"]').innerText()).trim(), "+3", "chip counts the hidden records");
  const latest = await card.locator('[data-test-class="work-activity-tail-latest"]').evaluate(node => node.children[1]!.textContent ?? "");
  const status = await card.locator('[data-test-class="work-activity-disclosure-status"]').innerText();
  assert.equal(await toggle.getAttribute("aria-label"), appCopy.conversation.work.disclosureLabel(status, latest, 3), "toggle names status, latest and the earlier records");
  const pulse = await card.locator(`[data-test-class="work-activity-tail-latest"] ${liveDot}`).evaluate(node => {
    const style = getComputedStyle(node);
    return { name: style.animationName, count: style.animationIterationCount, duration: style.animationDuration };
  });
  assert.deepEqual(pulse, { name: pulse.name, count: "infinite", duration: "1.6s" });
  assert(pulse.name.includes("work-activity-live-pulse"), "the collapsed latest dot pulses while running");
  const minimum = width < 640 ? 44 : 30;
  assert((await toggle.boundingBox())!.height >= minimum, "collapsed toggle meets the touch target");
  await checkToggleRing(page, "collapsed");
  const openJump = await toggleAndTrack(page);
  await tail.waitFor({ state: "detached" });
  await details.waitFor();
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  assert.equal(await card.locator('[data-test-class="work-activity-tail-count"]').count(), 0, "expanded hides the tail");
  const markers = details.locator('[data-slot="work-activity-marker"]');
  assert.equal(await markers.count(), 4, "the expanded timeline lists every record");
  assert.equal(await details.locator(liveDot).count(), 1, "one live dot while running");
  assert.equal(await markers.last().getAttribute("data-live"), "true", "the last expanded item pulses");
  assert.equal(await card.locator('[data-slot="work-activity-collapse-icon"]').evaluate(node => getComputedStyle(node).opacity), "1", "collapse chevron shows");
  const hit = await toggle.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    let rows = 0;
    for (let y = Math.floor(rect.top) - 40; y <= rect.bottom + 40; y++) {
      if (document.elementFromPoint(rect.left + rect.width / 2, y)?.closest('[data-test-class="work-activity-disclosure-toggle"]') === node) rows++;
    }
    return rows;
  });
  assert(hit >= minimum - 1, `expanded toggle keeps the touch target: ${hit}px`);
  await checkToggleRing(page, "expanded");
  const closeJump = await toggleAndTrack(page);
  await tail.waitFor();
  await details.waitFor({ state: "detached" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await card.locator(liveDot).evaluate(node => getComputedStyle(node).animationName), "none", "reduced motion: no pulse");
  await toggle.click();
  await details.locator(liveDot).waitFor();
  assert.equal(await details.locator(liveDot).evaluate(node => getComputedStyle(node).animationName), "none", "reduced motion: no pulse when expanded");
  await toggle.click();
  await tail.waitFor();
  await page.emulateMedia({ reducedMotion: null });
  for (const motion of [openJump, closeJump]) {
    console.log(JSON.stringify({ check: "delegated-status-drift", driftPx: motion.inside, incidentPx: 3 }));
    assert(motion.inside < 3, `the status line stays put inside the card: ${JSON.stringify(motion)}`);
    assert(motion.step <= Math.max(1, motion.travel * 0.75), `the card follows the motion instead of snapping: ${JSON.stringify(motion)}`);
  }
  return [openJump, closeJump];
}
const jumps: ToggleMotion[][] = [];
let phase: "running" | "delivered" | "cancelled" | "failed" = "running";
let stopRequested = false;
let awaiting = false;
let ownState = "delivered";
const grants = Array.from({ length: 20 }, (_, i) => ({ grant_ref: `grant-${i}`, capability: i % 2 ? "read_file" : "run_command",
  target: i % 2 ? `C:/workspace/report-${i}.html` : `node --check report-${i}.html`, cwd: "C:/workspace",
  title: "internal", description: "internal", created_at: clockNow.toISOString() }));
let requests = 0;

function views(): { parent: SessionView; observer: SessionView } {
  if (phase === "running") return { parent, observer };
  const turn: SessionViewTurn = { ...observer.latest_turn!, state: phase,
    delivery_state: phase === "failed" ? "failed_system" : phase, cancellable: false };
  return {
    parent: { ...parent, steward_children: [{ ...child, status: phase, active_turn: null, latest_turn: turn,
      terminal: true, waiting_for_children: false,
      result: { ...child.result!, status: phase === "delivered" ? "success" : phase } }] },
    observer: { ...observer, status: phase, active_turn: null, latest_turn: turn, waiting_for_children: false },
  };
}

try {
  for (const width of [1280, 375]) for (const theme of ["light", "dark"]) for (const wallpaper of [false, true]) {
    if (process.env.BUTLER_DELEGATED_WORK_CELL && process.env.BUTLER_DELEGATED_WORK_CELL !== `${width}-${theme}-${wallpaper}`) continue;
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", error => { pageErrors.push(error.message); console.error("pageerror", error.message); });
    await page.setViewportSize({ width, height: 800 });
    phase = "running";
    stopRequested = false;
    awaiting = false;
    ownState = "delivered";
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en", appearance_theme: theme,
      desktop_notifications: { enabled: true, assistant_messages: false, task_completions: false },
      wallpaper: { source: wallpaper ? { kind: "live", module: "butler.bloom", params: { colors: "monochrome" } } : { kind: "none" } } }) });
    await server.signIn(page);
    await installWorkReplay(page);
    await installSmokeUiAssets(page, process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist");
    await installNotificationReplay(page, server.url, wallpaper);
    // Screenshot mode: report battery power, so the conversation wallpaper holds its frame through the
    // product's on-battery pause. App reduce-motion would also stop the DS Spinner asserted below.
    if (output) await page.addInitScript(() => {
      const bridge = (window as unknown as { butlerApp: Record<string, unknown> }).butlerApp;
      bridge.onPowerState = (handler: (state: { onBattery: boolean; constrained: boolean }) => void) => {
        handler({ onBattery: true, constrained: false });
        return () => {};
      };
    });
    await page.route("**/authority-requests?**", route => route.fulfill({ json: { protocol_version: "butler.app.v1", data: { session_id: "general", requests: [], permissions: [...grants, grants[0]] } } }));
    await page.route("**/navigation", route => route.fulfill({ json: { protocol_version: "butler.app.v1", data: { ...navigation,
      chats: navigation.chats.map(s => ({ ...s, active_turn_state: ownState, running_delegated_work: phase === "running", attention_required: awaiting && s.id === "general" })) } } }));
    await page.route("**/session-view?**", route => {
      requests++;
      const id = new URL(route.request().url()).searchParams.get("session_id");
      return route.fulfill({ json: { protocol_version: "butler.app.v1", data: id === observer.session_id ? views().observer : views().parent } });
    });
    await page.route("**/steward-relations/*/cancel", route => {
      stopRequested = true;
      return route.fulfill({ status: 202, json: { protocol_version: "butler.app.v1", data: { status: "cancelling" } } });
    });
    const row = page.locator('[data-test-class="app-sidebar"] [data-test-class="tree-row"]').first();
    const spinner = row.locator('[data-slot="spinner"]');
    // The transcript card's observer action; the composer capsule is gone.
    const pill = page.locator('[data-test-class="steward-observer-action"]').first();
    const dialog = page.locator('[data-test-class="steward-observer-dialog"]');
    const capture = async (state: string) => {
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() => document.getAnimations().every(animation =>
        // Scroll-driven animations follow scroll position, not time, and never finish.
        animation.timeline !== document.timeline || animation.effect?.getTiming().iterations === Infinity ||
          animation.playState !== "running"));
      if (output) await page.waitForFunction(() => [...document.querySelectorAll<HTMLCanvasElement>("canvas[data-wallpaper-state]")]
        .every(canvas => canvas.dataset.wallpaperState !== "pending"));
      await page.waitForLoadState("networkidle");
      if (output) await page.screenshot({ animations: "disabled", caret: "hide", path: `${output}/${width}-${theme}-${wallpaper ? "wallpaper" : "plain"}-${state}.png` });
    };
    if (output) await page.clock.setFixedTime(clockNow);
    await page.goto(server.url);
    try { await pill.waitFor(); } catch (error) {
      console.error(JSON.stringify({ width, theme, requests, body: await page.locator("body").innerText(),
        crashes: await page.evaluate(() => (window as unknown as { __uiCrashes: unknown[] }).__uiCrashes) }));
      await capture("failure"); throw error;
    }
    if (!await row.isVisible()) await page.getByRole("button", { name: appCopy.titlebar.showLeftPanel, exact: true }).click();
    await spinner.waitFor();
    const animation = await spinner.locator("circle").evaluate(circle => getComputedStyle(circle).animationName);
    assert(animation.includes("spinner-rotate"), "the existing DS working animation is active");
    await capture("running");
    if (wallpaper) assert(await page.evaluate(() => (window as unknown as { __wallpaperLogFailures: number }).__wallpaperLogFailures > 0), "unavailable wallpaper log sink was exercised");
    awaiting = true;
    await page.evaluate(({ childId, createdAt }) => (window as unknown as { __emitWorkEvent: (event: unknown) => void }).__emitWorkEvent({
      id: 90, type: "subsession.changed", created_at: createdAt,
      payload: { session_id: "general", child_session_id: childId },
    }), { childId: child.session_id, createdAt: clockNow.toISOString() });
    await page.waitForFunction(() => (window as unknown as { __notifications: unknown[] }).__notifications.length === 1);
    assert.equal(await spinner.count(), 0, "attention replaces running animation");
    await row.getByLabel(appCopy.space.attention, { exact: true }).waitFor();
    await capture("sidebar-attention");
    awaiting = false;
    await page.evaluate(() => (window as unknown as { __emitWorkEvent: (event: unknown) => void }).__emitWorkEvent({
      id: 91, type: "question.answered", payload: { session_id: "general" },
    }));
    await spinner.waitFor();
    await page.getByText(`General · ${appCopy.space.attention}`, { exact: true }).waitFor({ state: "detached" });
    await page.reload(); // A fresh App boot projects the still-running durable child.
    await pill.waitFor();
    if (!await row.isVisible()) await page.getByRole("button", { name: appCopy.titlebar.showLeftPanel, exact: true }).click();
    await spinner.waitFor();
    // Sidebar overlays the composer on mobile: close it after observing the row.
    if (width < 640) await page.getByRole("button", { name: appCopy.titlebar.hideLeftPanel, exact: true }).last().click();
    if (!baseline) jumps.push(await checkWorkBlockTail(page, width));
    const access = page.locator('[data-test-class="access-button"]');
    await page.getByRole("textbox").first().focus();
    await access.click();
    await capture("grants-collapsed");
    assert.equal(await page.locator('[data-test-class="granted-permission"]').count(), 0);
    const options = page.locator('[data-slot="option-menu-item"]');
    const labels = [appCopy.permissions.auto, appCopy.permissions.readOnly, appCopy.permissions.askAlways,
      appCopy.permissions.askFirst, appCopy.permissions.fullAccess];
    assert.equal(await options.count(), labels.length, "only access modes, no grant rows");
    for (let index = 0; index < labels.length; index++) assert((await options.nth(index).innerText()).includes(labels[index]!), "access mode order and labels");
    assert.equal(await access.getAttribute("aria-label"), `${appCopy.composer.permission}: ${appCopy.permissions.askFirst}`, "grants do not add a count");
    assert(!(await page.locator('[data-test-class="composer-menu"]').innerText()).includes("Allowed"), "no grants section");
    await page.keyboard.press("Escape");
    await pill.click();
    await dialog.getByRole("button", { name: "Stop", exact: true }).waitFor();
    await capture("modal-running");
    if (output) writeFileSync(`${output}/${width}-${theme}-${wallpaper ? "wallpaper" : "plain"}-modal-running.txt`, await dialog.innerText());
    if (!baseline) {
      const text = await dialog.innerText();
      assert(!text.includes(DELIVERED), "the delegated request stays out of the work activity list");
      assert(!text.includes("role: steward"));
      assert(!text.includes("Prior delegation context"));
    }
    await dialog.getByRole("button", { name: "Stop", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[data-test-class="steward-observer-dialog"] button:disabled'));
    assert(stopRequested, "Stop used the public cancellation endpoint");
    assert.equal(await dialog.getByRole("button", { name: "Stop", exact: true }).count(), 1, "request acceptance is not terminal confirmation");
    phase = "cancelled";
    await page.evaluate(async ({ childId, createdAt }) => {
      (window as unknown as { __emitWorkEvent: (event: unknown) => void }).__emitWorkEvent({
        id: 100, type: "subsession.changed", created_at: createdAt,
        payload: { session_id: "general", child_session_id: childId },
      });
      await new Promise<void>((done) => {
        const check = () => {
          const modal = document.querySelector('[data-test-class="steward-observer-dialog"]');
          if (![...modal?.querySelectorAll("button") ?? []].some(button => button.textContent?.trim() === "Stop") &&
              !modal?.querySelector('[data-test-class~="current-turn-status"]') &&
              !document.querySelector('[data-test-class="app-sidebar"] [data-slot="spinner"]')) {
            done();
            return true;
          }
          return false;
        };
        const observer = new MutationObserver(() => { if (check()) observer.disconnect(); });
        observer.observe(document, { subtree: true, childList: true, attributes: true });
        if (check()) observer.disconnect();
      });
    }, { childId: child.session_id, createdAt: clockNow.toISOString() });
    const completed = dialog.locator(`[data-test-class="turn-current-phase-activity"][data-turn-id="${observer.latest_turn!.id}"]`);
    await completed.getByRole("button", { expanded: false }).waitFor();
    await capture("modal-stopped");
    if (output) writeFileSync(`${output}/${width}-${theme}-${wallpaper ? "wallpaper" : "plain"}-modal-stopped.txt`, await dialog.innerText());
    assert.equal(await dialog.getByRole("button", { name: "Stop", exact: true }).count(), 0);
    await page.keyboard.press("Escape");
    if (!baseline) await page.waitForFunction(({ selector, dot }) => !document.querySelector(`${selector} ${dot}`) &&
      document.querySelector(`${selector} [data-test-class="work-activity-tail"]`), { selector: cardSelector, dot: liveDot });
    for (const terminal of ["delivered", "failed"] as const) {
      ownState = terminal;
      phase = "running";
      await page.reload();
      await pill.waitFor();
      if (!await row.isVisible()) await page.getByRole("button", { name: appCopy.titlebar.showLeftPanel, exact: true }).click();
      await spinner.waitFor();
      phase = terminal;
      await page.evaluate(childId => (window as unknown as { __emitWorkEvent: (event: unknown) => void }).__emitWorkEvent({
        id: 101, type: "subsession.changed", payload: { session_id: "general", child_session_id: childId },
      }), child.session_id);
      await spinner.waitFor({ state: "detached" });
      assert.equal(await spinner.count(), 0, `${terminal} clears the row`);
    }
    assert.deepEqual(pageErrors, [], "no uncaught bridge errors");
    assert.deepEqual(await page.evaluate(() => (window as unknown as { __uiCrashes: unknown[] }).__uiCrashes), [], "no contained view crashes");
    await page.close();
  }
  console.log(JSON.stringify({ ok: true, baseline, requests, toggleMotionPx: jumps,
    checks: baseline ? ["before-snapshots"] : ["steward-modal-hides-request-packet", "parent-ended-child-running", "reload", "stop-accepted-still-running", "confirmed-stop-all-surfaces", "collapsed-summary", "work-block-tail-and-chip", "expanded-hides-tail", "live-pulse-running-only", "reduced-motion-no-pulse", "no-toggle-jump", "complete", "fail", "attention-notification-and-clear", "access-modes-with-existing-grants", "unavailable-wallpaper-log", "no-ui-crashes"] }));
} finally {
  await browser.close();
  await server.stop();
}
