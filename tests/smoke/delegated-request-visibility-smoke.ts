// Real App, replayed public contracts: request data remains, activity lists omit it.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Locator } from "playwright";
import { createNativeAppServer } from "../support/native-app-server";
import { installWorkReplay } from "../support/delegated-work-replay";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser";
import { installSmokeUiAssets } from "../support/smoke-ui-assets";
import { HARNESS_SS03_OBSERVER_VIEW, HARNESS_SS03_SUMMARY } from "../../packages/butler-app/client/ui/src/app/fixtures";
import { getAppCopy } from "../../packages/butler-i18n/src/index";
import type { NavigationView, ProgressRow, SessionView } from "../../packages/butler-app/client/ui/src/app/types";

const copy = getAppCopy("ko-KR");
const cells = [1440, 390].flatMap(width => ["light", "dark"].flatMap(theme =>
  ["running", "delivered"].flatMap(state => [false, true].map(wallpaper => `${width}-${theme}-${state}-${wallpaper}`))));
if (await runSmokeCases(cells, "BUTLER_REQUEST_VISIBILITY_CELL", import.meta.path)) process.exit(0);
const baseline = process.env.BUTLER_SMOKE_BASELINE === "1";
const output = process.env.BUTLER_SMOKE_SCREENSHOTS;
if (output) mkdirSync(output, { recursive: true });
const request = "자료를 확인하고 결과를 정리해 주세요.\n\n" + Array.from({ length: 12 }, (_, i) =>
  `• 확인 조건 ${i + 1}: 출처와 확인 시점을 함께 남겨 주세요.`).join("\n");
const rows: ProgressRow[] = Array.from({ length: 8 }, (_, i) => ({
  id: `activity-${i}`, kind: "message", state: "delivered", semantic_block_id: `step-${i}`,
  activity_stage: "conception", work_decision_title: i ? `자료 확인 ${i}` : "대화 기억 찾기",
  work_decision_source: "model-authored", work_decision_summary: "확인한 자료를 정리합니다.",
  safe_label: i ? `자료 확인 ${i}` : "대화 기억 찾기", created_at: `2026-05-01T00:10:${String(i + 1).padStart(2, "0")}.000Z`,
}));
const uiRoot = resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist");
const server = await createNativeAppServer({ uiRoot });
let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
let captures = 0;

async function checkList(scope: Locator) {
  const bubbles = scope.locator('[data-test-class="user-message-text"]');
  assert.equal(await bubbles.count(), baseline ? 1 : 0, "request bubble visibility");
  if (!baseline) {
    assert(!(await scope.innerText()).includes("확인 조건"), "no request/checklist text in the activity list");
    const first = scope.locator('[data-test-class="steward-observer-message"]').first();
    assert((await first.innerText()).includes("대화 기억 찾기"), "the first row is the activity timeline");
    assert(await first.evaluate(node => node.previousElementSibling === null), "no empty preceding row");
  }
}

try {
  browser = await launchSmokeBrowser();
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const navigation = await server.api<NavigationView>("/navigation");
  navigation.chats = [{ id: "general", kind: "chat", title: "자료 확인", last_activity_at: new Date().toISOString(), pinned: false, archived: false }];
  const parent = await server.api<SessionView>("/session-view?session_id=general");
  for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) {
    for (const state of ["running", "delivered"] as const) for (const wallpaper of [false, true]) {
      if (process.env.BUTLER_REQUEST_VISIBILITY_CELL && process.env.BUTLER_REQUEST_VISIBILITY_CELL !== `${width}-${theme}-${state}-${wallpaper}`) continue;
      const child = structuredClone(HARNESS_SS03_SUMMARY.steward_children![0]!);
      child.relation.parent_session_id = "general";
      const turn = { ...child.latest_turn!, state, cancellable: state === "running", progress: { safe_progress_rows: rows } };
      Object.assign(child, { title: "자료 확인", status: state, latest_turn: turn,
        active_turn: state === "running" ? turn : null, terminal: state !== "running", waiting_for_children: false });
      const observer: SessionView = { ...structuredClone(HARNESS_SS03_OBSERVER_VIEW), relation: child.relation,
        status: state === "running" ? "active" : state, active_turn: child.active_turn, latest_turn: turn,
        messages: [{ ...HARNESS_SS03_OBSERVER_VIEW.messages[0]!, role: "user", id: "request", text: request,
          created_at: "2026-05-01T00:09:00.000Z" }] };
      const parentView: SessionView = { ...parent, status: "delivered", active_turn: null, latest_turn: null,
        steward_children: [child], messages: [
          { ...observer.messages[0]!, id: "m3", cursor: 1, chat_id: "general", text: "자료를 확인해 주세요." },
          { ...HARNESS_SS03_OBSERVER_VIEW.messages[0]!, id: "m4", chat_id: "general",
            cursor: 2, text: "자료 확인을 시작했습니다.", status: "delivered", turn_id: "turn-2" }], message_window: { next_cursor: 2, complete: true } };
      await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme,
        wallpaper: { source: wallpaper ? { kind: "live", module: "butler.bloom", params: { colors: "monochrome" } } : { kind: "none" } } }) });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") console.error(message.text()); });
      page.on("response", response => { if (response.status() >= 400) console.error(response.status(), new URL(response.url()).pathname); });
      await page.setViewportSize({ width, height: 900 });
      await server.signIn(page);
      await installWorkReplay(page);
      await installSmokeUiAssets(page, uiRoot);
      await page.route("**/navigation", route => route.fulfill({ json: { protocol_version: "butler.app.v1", data: navigation } }));
      await page.route("**/session-view?**", route => route.fulfill({ json: { protocol_version: "butler.app.v1",
        data: new URL(route.request().url()).searchParams.get("session_id") === observer.session_id ? observer : parentView } }));
      await page.goto(server.url);
      const card = page.locator('[data-test-class~="steward-parent-progress-card"]');
      try { await card.waitFor(); } catch (error) {
        console.error(JSON.stringify({ body: await page.locator("body").innerText(), errors, html: (await page.content()).slice(0, 2000) }));
        if (output) await page.screenshot({ path: `${output}/failure.png` });
        throw error;
      }
      const hideSidebar = page.getByRole("button", { name: copy.titlebar.hideLeftPanel, exact: true }).last();
      if (width < 640 && await hideSidebar.isVisible()) await hideSidebar.click();
      await card.getByRole("button", { name: copy.conversation.work.showDetailsLabel, exact: true }).click();
      const scroll = card.locator('[data-test-class="work-block-details-scroll"]');
      await scroll.getByText("대화 기억 찾기", { exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      await checkList(scroll);
      await scroll.evaluate(node => { node.scrollTop = 0; });
      await page.waitForFunction(() => document.querySelector('[data-test-class="work-block-details-scroll"]')?.getAttribute("data-at-start") === "true");
      const geometry = await scroll.evaluate(node => ({ height: node.clientHeight, total: node.scrollHeight,
        gap: node.querySelector('[data-test-class="steward-observer-message"]')!.getBoundingClientRect().top - node.getBoundingClientRect().top,
        padding: parseFloat(getComputedStyle(node.firstElementChild!).paddingTop), mask: getComputedStyle(node).maskImage }));
      assert.equal(geometry.height, 320, "the box remains 320px");
      assert(geometry.total > geometry.height, "the timeline has inner overflow");
      assert(Math.abs(geometry.gap - geometry.padding) <= 1, "first row uses only the DS edge padding");
      assert.notEqual(geometry.mask, "none", "edge fade mask remains active");
      const name = `${width}-${theme}-${state}-${wallpaper ? "wallpaper" : "plain"}`;
      if (output) { await page.screenshot({ path: `${output}/${name}-inline.png` }); captures++; }
      await scroll.evaluate(node => { node.scrollTop = node.scrollHeight; });
      await page.waitForFunction(() => document.querySelector('[data-test-class="work-block-details-scroll"]')?.getAttribute("data-at-end") === "true");
      await card.locator('[data-test-class="steward-observer-action"]').click();
      const dialog = page.locator('[data-test-class="steward-observer-dialog"]');
      await dialog.waitFor();
      while (await dialog.getByRole("button", { expanded: false }).count()) {
        await dialog.getByRole("button", { expanded: false }).first().click();
      }
      await checkList(dialog);
      if (output) { await page.screenshot({ path: `${output}/${name}-modal.png` }); captures++; }
      assert.equal(observer.messages[0]!.text, request, "request remains in the public data");
      assert.deepEqual(errors, [], "no renderer errors");
      await page.close();
    }
  }
  console.log(JSON.stringify({ ok: true, baseline, cells: process.env.BUTLER_REQUEST_VISIBILITY_CELL ? 1 : 16, captures, boxHeight: 320,
    checks: ["inline", "modal", "request-data-retained", "first-item-spacing", "inner-scroll", "edge-fades"] }));
} finally { await browser?.close(); await server.stop(); }
