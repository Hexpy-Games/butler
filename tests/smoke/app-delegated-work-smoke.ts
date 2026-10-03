// Replay the public navigation/session-view/event contracts through the real App.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { installWorkReplay } from "../support/delegated-work-replay.ts";
import { smokeBrowserArgs } from "../support/smoke-browser.ts";
import { HARNESS_SS03_OBSERVER_VIEW, HARNESS_SS03_SUMMARY } from "../../packages/butler-app/client/ui/src/app/fixtures.ts";
import { appCopy } from "../../packages/butler-app/client/ui/src/app/copy.ts";
import type { NavigationView, SessionView, SessionViewTurn } from "../../packages/butler-app/client/ui/src/app/types.ts";

const output = process.env.BUTLER_SMOKE_SCREENSHOTS;
if (output) mkdirSync(output, { recursive: true });
const server = await createNativeAppServer({ uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist") });
const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });
const context = await browser.newContext();
const baseline = process.env.BUTLER_SMOKE_BASELINE === "1";
const navigation = await server.api<NavigationView>("/navigation");
const parent = await server.api<SessionView>("/session-view?session_id=general");
const child = structuredClone(HARNESS_SS03_SUMMARY.steward_children![0]!);
child.relation.parent_session_id = "general";
const observer = { ...structuredClone(HARNESS_SS03_OBSERVER_VIEW), relation: child.relation };
parent.messages = [{ ...observer.messages[0]!, id: "m3", chat_id: "general", text: "Delegated work started.", status: "delivered", turn_id: "turn-2" }];
parent.message_window = { next_cursor: 1, complete: true };
parent.active_turn = null;
parent.latest_turn = null;
parent.status = "delivered";
parent.steward_children = [child];
let phase: "running" | "delivered" | "cancelled" | "failed" = "running";
let stopRequested = false;
let requests = 0;
const timings: number[] = [];

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
    const page = await context.newPage();
    await page.setViewportSize({ width, height: 800 });
    phase = "running";
    stopRequested = false;
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en", appearance_theme: theme,
      wallpaper: { source: wallpaper ? { kind: "live", module: "butler.bloom", params: { colors: "monochrome" } } : { kind: "none" } } }) });
    await server.signIn(page);
    await installWorkReplay(page);
    await page.route("**/navigation", route => route.fulfill({ json: { data: { ...navigation,
      chats: navigation.chats.map(s => ({ ...s, active_turn_state: "delivered", running_delegated_work: phase === "running" })) } } }));
    await page.route("**/session-view?**", route => {
      requests++;
      const id = new URL(route.request().url()).searchParams.get("session_id");
      return route.fulfill({ json: { data: id === observer.session_id ? views().observer : views().parent } });
    });
    await page.route("**/steward-relations/*/cancel", route => {
      stopRequested = true;
      return route.fulfill({ status: 202, json: { data: { status: "cancelling" } } });
    });
    const row = page.locator('[data-test-class="app-sidebar"] [data-test-class="tree-row"]').first();
    const spinner = row.locator('[data-slot="spinner"]');
    const pill = page.locator('[data-test-class="steward-progress-capsule"]');
    const dialog = page.locator('[data-test-class="steward-observer-dialog"]');
    const capture = async (state: string) => {
      if (output) await page.screenshot({ path: `${output}/${width}-${theme}-${wallpaper ? "wallpaper" : "plain"}-${state}.png` });
    };
    await page.goto(server.url);
    await pill.waitFor();
    if (!await row.isVisible()) await page.getByRole("button", { name: appCopy.titlebar.showLeftPanel, exact: true }).click();
    if (!baseline) {
      await spinner.waitFor();
      const animation = await spinner.locator("circle").evaluate(circle => getComputedStyle(circle).animationName);
      assert(animation.includes("spinner-rotate"), "the existing DS working animation is active");
    }
    await capture("running");
    await page.reload(); // A fresh App boot projects the still-running durable child.
    await pill.waitFor();
    if (!await row.isVisible()) await page.getByRole("button", { name: appCopy.titlebar.showLeftPanel, exact: true }).click();
    if (!baseline) await spinner.waitFor();
    // Sidebar overlays the composer on mobile: close it after observing the row.
    if (width < 640) await page.getByRole("button", { name: appCopy.titlebar.hideLeftPanel, exact: true }).last().click();
    await pill.click();
    await dialog.getByRole("button", { name: "Stop", exact: true }).waitFor();
    await capture("modal-running");
    const beforeIdle = requests;
    await page.waitForTimeout(2100);
    if (!baseline) assert.equal(requests, beforeIdle, "no observer polling during idle");
    await dialog.getByRole("button", { name: "Stop", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[data-test-class="steward-observer-dialog"] button:disabled'));
    assert(stopRequested, "Stop used the public cancellation endpoint");
    assert.equal(await pill.count(), 1, "request acceptance is not terminal confirmation");
    phase = "cancelled";
    const elapsed = await page.evaluate(async ({ childId, baseline }) => {
      const start = performance.now();
      (window as unknown as { __emitWorkEvent: (event: unknown) => void }).__emitWorkEvent({
        id: 100, type: "subsession.changed", created_at: new Date().toISOString(),
        payload: { session_id: "general", child_session_id: childId },
      });
      if (baseline) return 0;
      return await new Promise<number>((done, reject) => {
        const check = () => {
          const modal = document.querySelector('[data-test-class="steward-observer-dialog"]');
          if (![...modal?.querySelectorAll("button") ?? []].some(button => button.textContent?.trim() === "Stop") &&
              !modal?.querySelector('[data-test-class~="current-turn-status"]') &&
              !document.querySelector('[data-test-class="steward-progress-capsule"]') &&
              !document.querySelector('[data-test-class="app-sidebar"] [data-slot="spinner"]')) {
            done(performance.now() - start);
            return true;
          }
          return false;
        };
        const observer = new MutationObserver(() => { if (check()) observer.disconnect(); });
        observer.observe(document, { subtree: true, childList: true, attributes: true });
        if (check()) observer.disconnect();
        setTimeout(() => { observer.disconnect(); reject(new Error("terminal surfaces exceeded 500 ms: " + JSON.stringify({
          modal: document.querySelector('[data-test-class="steward-observer-dialog"]')?.textContent,
          pill: document.querySelector('[data-test-class="steward-progress-capsule"]')?.textContent,
          spinners: document.querySelectorAll('[data-test-class="app-sidebar"] [data-slot="spinner"]').length,
        }))); }, 500);
      });
    }, { childId: child.session_id, baseline });
    timings.push(elapsed);
    await capture("modal-stopped");
    if (!baseline) {
      const completed = dialog.locator(`[data-test-class="turn-current-phase-activity"][data-turn-id="${observer.latest_turn!.id}"]`);
      await completed.getByRole("button", { expanded: false }).waitFor();
      assert.equal(await dialog.getByRole("button", { name: "Stop", exact: true }).count(), 0);
      await page.keyboard.press("Escape");
      for (const terminal of ["delivered", "failed"] as const) {
        phase = "running";
        await page.reload();
        await pill.waitFor();
        phase = terminal;
        await page.evaluate(childId => (window as unknown as { __emitWorkEvent: (event: unknown) => void }).__emitWorkEvent({
          id: 101, type: "subsession.changed", payload: { session_id: "general", child_session_id: childId },
        }), child.session_id);
        await pill.waitFor({ state: "detached" });
        assert.equal(await spinner.count(), 0, `${terminal} clears the row`);
      }
    }
    await page.close();
  }
  console.log(JSON.stringify({ ok: true, baseline, timingsMs: timings, maxMs: Math.max(...timings), requests,
    checks: baseline ? ["before-snapshots"] : ["parent-ended-child-running", "reload", "stop-accepted-still-running", "confirmed-stop-all-surfaces-500ms", "collapsed-summary", "complete", "fail", "no-idle-polling"] }));
} finally {
  await browser.close();
  await server.stop();
}
