// Replay the public navigation/session-view/event contracts through the real App.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { installNotificationReplay } from "../support/notification-replay.ts";
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
navigation.chats = [{ id: "general", kind: "chat", title: "General", last_activity_at: new Date().toISOString(), pinned: false, archived: false }];
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
let awaiting = false;
const grants = Array.from({ length: 20 }, (_, i) => ({ grant_ref: `grant-${i}`, capability: i % 2 ? "read_file" : "run_command",
  target: i % 2 ? `C:/workspace/report-${i}.html` : `node --check report-${i}.html`, cwd: "C:/workspace",
  title: "internal", description: "internal", created_at: new Date().toISOString() }));
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
    page.on("pageerror", error => console.error("pageerror", error.message));
    await page.setViewportSize({ width, height: 800 });
    phase = "running";
    stopRequested = false;
    awaiting = false;
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en", appearance_theme: theme,
      desktop_notifications: { enabled: true, assistant_messages: false, task_completions: false },
      wallpaper: { source: wallpaper ? { kind: "live", module: "butler.bloom", params: { colors: "monochrome" } } : { kind: "none" } } }) });
    await server.signIn(page);
    await installWorkReplay(page);
    await installNotificationReplay(page, server.url);
    await page.route("**/authority-requests?**", route => route.fulfill({ json: { protocol_version: "butler.app.v1", data: { session_id: "general", requests: [], permissions: [...grants, grants[0]] } } }));
    await page.route("**/navigation", route => route.fulfill({ json: { protocol_version: "butler.app.v1", data: { ...navigation,
      chats: navigation.chats.map(s => ({ ...s, active_turn_state: "delivered", running_delegated_work: phase === "running", attention_required: awaiting && s.id === "general" })) } } }));
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
    const pill = page.locator('[data-test-class="steward-progress-capsule"]');
    const dialog = page.locator('[data-test-class="steward-observer-dialog"]');
    const capture = async (state: string) => {
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() => document.getAnimations().every(animation =>
        animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
      if (output) await page.screenshot({ path: `${output}/${width}-${theme}-${wallpaper ? "wallpaper" : "plain"}-${state}.png` });
    };
    await page.goto(server.url);
    try { await pill.waitFor(); } catch (error) {
      console.error(JSON.stringify({ width, theme, requests, body: await page.locator("body").innerText() }));
      await capture("failure"); throw error;
    }
    if (!await row.isVisible()) await page.getByRole("button", { name: appCopy.titlebar.showLeftPanel, exact: true }).click();
    if (!baseline) {
      await spinner.waitFor();
      const animation = await spinner.locator("circle").evaluate(circle => getComputedStyle(circle).animationName);
      assert(animation.includes("spinner-rotate"), "the existing DS working animation is active");
    }
    await capture("running");
    awaiting = true;
    await page.evaluate(childId => (window as unknown as { __emitWorkEvent: (event: unknown) => void }).__emitWorkEvent({
      id: 90, type: "subsession.changed", created_at: new Date().toISOString(),
      payload: { session_id: "general", child_session_id: childId },
    }), child.session_id);
    if (!baseline) {
      await page.waitForFunction(() => (window as unknown as { __notifications: unknown[] }).__notifications.length === 1);
      assert.equal(await spinner.count(), 0, "attention replaces running animation");
      await row.getByLabel(appCopy.space.attention, { exact: true }).waitFor();
    }
    await capture("sidebar-attention");
    awaiting = false;
    await page.evaluate(() => (window as unknown as { __emitWorkEvent: (event: unknown) => void }).__emitWorkEvent({
      id: 91, type: "question.answered", payload: { session_id: "general" },
    }));
    if (!baseline) {
      await spinner.waitFor();
      await page.getByText(`General · ${appCopy.space.attention}`, { exact: true }).waitFor({ state: "detached" });
    }
    await page.reload(); // A fresh App boot projects the still-running durable child.
    await pill.waitFor();
    if (!await row.isVisible()) await page.getByRole("button", { name: appCopy.titlebar.showLeftPanel, exact: true }).click();
    if (!baseline) await spinner.waitFor();
    // Sidebar overlays the composer on mobile: close it after observing the row.
    if (width < 640) await page.getByRole("button", { name: appCopy.titlebar.hideLeftPanel, exact: true }).last().click();
    const access = page.locator('[data-test-class="access-button"]');
    await page.getByRole("textbox").first().focus();
    await access.click();
    await capture("grants-collapsed");
    if (!baseline) {
      assert.equal(await page.locator('[data-test-class="granted-permission"]').count(), 0);
      await page.getByRole("button", { name: appCopy.interfaceTemplates.grantedItems(20), exact: true }).click();
      assert.equal(await page.locator('[data-test-class="granted-permission"]').count(), 20, "identical grants deduplicate");
      const text = await page.locator('[data-test-class="granted-permissions"]').innerText();
      assert(!/run_command|read_file|internal/.test(text), text);
      assert(text.includes("node --check report-0.html") && text.includes("C:/workspace/report-1.html"));
      await capture("grants-expanded");
      await page.getByText("node --check report-0.html", { exact: true }).hover();
      await page.getByRole("tooltip").filter({ hasText: "node --check report-0.html" }).waitFor();
      const scroll = page.locator('[data-test-class="granted-permissions-scroll"]');
      assert(await scroll.evaluate(el => el.clientHeight >= 100 && el.clientHeight <= 180 && el.scrollHeight > el.clientHeight), "DS scroll bounds the grant list");
    }
    await page.keyboard.press("Escape");
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
