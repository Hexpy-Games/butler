// test-category: race
// Public session-view pages replayed through the real card, observer and store.
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { installWorkReplay } from "../support/delegated-work-replay.ts";
import { installSmokeUiAssets } from "../support/smoke-ui-assets";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser.ts";
import { HARNESS_SS03_OBSERVER_VIEW, HARNESS_SS03_SUMMARY } from "../../packages/butler-app/client/ui/src/app/fixtures.ts";
import type { NavigationView, ProgressRow, SessionView } from "../../packages/butler-app/client/ui/src/app/types.ts";

if (await runSmokeCases(["light", "dark"], "BUTLER_CHILD_HISTORY_THEME", import.meta.path)) process.exit(0);
const server = await createNativeAppServer({ uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist") });
const browser = await launchSmokeBrowser();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
  const page = await context.newPage();
  await server.signIn(page);
  await installWorkReplay(page);
  await installSmokeUiAssets(page, process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist");
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: process.env.BUTLER_CHILD_HISTORY_THEME ?? "light", language: "en" }) });
  const navigation = await server.api<NavigationView>("/navigation");
  navigation.chats = [{ id: "general", kind: "chat", title: "General", last_activity_at: new Date().toISOString(), pinned: false, archived: false }];
  const parent = await server.api<SessionView>("/session-view?session_id=general");
  const child = structuredClone(HARNESS_SS03_SUMMARY.steward_children![0]!);
  child.relation.parent_session_id = "general";
  parent.messages = [
    { ...HARNESS_SS03_OBSERVER_VIEW.messages[0]!, role: "user", id: "m3", cursor: 1, chat_id: "general", text: "Compare approaches.", status: "delivered", turn_id: undefined },
    { ...HARNESS_SS03_OBSERVER_VIEW.messages[0]!, id: "m4", cursor: 2, chat_id: "general", text: "Delegated work started.", status: "delivered", turn_id: "turn-2" },
  ];
  parent.active_turn = null;
  parent.latest_turn = null;
  parent.steward_children = [child];
  const observer = structuredClone(HARNESS_SS03_OBSERVER_VIEW);
  observer.relation = child.relation;
  observer.messages = [];
  const titles = ["Plan the comparison", "Check the first source", "Review the next step", "Apply the Worker result"];
  const rows: ProgressRow[] = titles.map((title, index) => ({ id: `event-${index}`, kind: "message", state: "delivered",
    semantic_block_id: `activity-${index}`, activity_stage: "conception", work_decision_summary: "Verify the evidence.", work_decision_title: title, work_decision_source: "model-authored",
    safe_label: title, turn_event_sequence: index % 2 + 1, created_at: `2026-05-01T00:10:0${index}.000Z` }));
  let changed = false;
  let resync = false;
  await page.route("**/navigation", route => route.fulfill({ json: { protocol_version: "butler.app.v1", data: navigation } }));
  await page.route("**/session-view?**", route => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get("session_id") !== child.session_id) return route.fulfill({ json: { protocol_version: "butler.app.v1", data: parent } });
    if (resync && query.has("activity_cursor_token")) {
      return route.fulfill({ status: 409, json: { protocol_version: "butler.app.v1", error: {
        code: "session_cursor_resync_required", message: "Reload the session." } } });
    }
    if (!query.has("cursor_token") && !query.has("activity_cursor_token")) resync = false;
    const after = Number(query.get("activity_cursor_token") ?? 0);
    const end = changed ? 4 : 2;
    const next = Math.min(after + 1, end);
    const current = changed ? "step-two" : "step-one";
    const turn = { ...observer.latest_turn!, id: current,
      progress: { ...observer.latest_turn!.progress!, safe_progress_rows: [] } };
    return route.fulfill({ json: { protocol_version: "butler.app.v1", data: { ...observer,
      active_turn: turn, latest_turn: turn,
      message_window: { next_cursor_token: "messages", requested_cursor_token: query.get("cursor_token") ?? undefined, complete: true },
      activity_history: after < end ? [{ turn_id: after < 2 ? "step-one" : "step-two", created_at: rows[after]!.created_at, rows: [rows[after]] }] : [],
      activity_window: { has_more: next < end, next_cursor_token: String(next), requested_cursor_token: query.get("activity_cursor_token") ?? undefined },
    } } });
  });
  await page.goto(server.url);
  const card = page.locator('[data-test-class~="steward-parent-progress-card"]');
  const toggle = card.locator('[data-test-class="work-activity-disclosure-toggle"]');
  await toggle.click();
  const details = card.locator('[data-test-class="work-block-details-scroll"]');
  for (const title of titles.slice(0, 2)) await details.getByText(title, { exact: true }).waitFor();
  changed = true;
  await page.evaluate(childId => (window as unknown as { __emitWorkEvent: (event: unknown) => void }).__emitWorkEvent({
    id: 90, type: "subsession.changed", payload: { session_id: "general", child_session_id: childId },
  }), child.session_id);
  for (const title of titles) await details.getByText(title, { exact: true }).waitFor();
  assert.equal(await toggle.getAttribute("aria-expanded"), "true", "step changes retain expansion");
  resync = true;
  await page.evaluate(childId => (window as unknown as { __emitWorkEvent: (event: unknown) => void }).__emitWorkEvent({
    id: 91, type: "subsession.changed", payload: { session_id: "general", child_session_id: childId },
  }), child.session_id);
  await page.waitForResponse(response => response.url().includes("activity_cursor_token=3") && response.status() === 200);
  for (const title of titles) await details.getByText(title, { exact: true }).waitFor();
  assert.equal(resync, false, "expired/restarted cursor was resynchronized");
  await page.reload();
  await toggle.click();
  for (const title of titles) await details.getByText(title, { exact: true }).waitFor();
  await card.locator('[data-test-class="steward-observer-action"]').click();
  const dialog = page.locator('[data-test-class="steward-observer-dialog"]');
  await dialog.waitFor();
  // The observer uses the same loaded history; expand its activity disclosure.
  for (const button of await dialog.locator('button[aria-expanded="false"]').all()) await button.click();
  for (const title of titles) await dialog.getByText(title, { exact: true }).waitFor();
  console.log(JSON.stringify({ result: "PASS", theme: process.env.BUTLER_CHILD_HISTORY_THEME, turns: 2, activities: 4, pageSize: 1, reload: true, observer: true }));
} finally { await browser.close(); await server.stop(); }
