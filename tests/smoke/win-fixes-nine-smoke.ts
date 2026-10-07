// UI smoke: actual conversation renderers, canonical HTTP reads and live SSE invalidation.
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { smokeBrowserArgs } from "../support/smoke-browser.ts";
import { WIN_FIXES_PARENT, WIN_FIXES_ROWS } from "../../packages/butler-app/client/ui/src/app/winFixesFixture.ts";
import { HARNESS_MODEL_CATALOG, HARNESS_SS03_OBSERVER_VIEW } from "../../packages/butler-app/client/ui/src/app/fixtures.ts";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import catalog from "../../packages/butler-agent/rust/crates/butler-runtime/src/capabilities/catalog/catalog.json";

const output = process.env.BUTLER_WIN9_SCREENSHOTS ?? ".tmp/win-fixes-9/screenshots/after";
mkdirSync(output, { recursive: true });
for (const locale of ["ko-KR", "en-US"] as const) {
  const labels = getAppCopy(locale).guided.tools;
  for (const name of Object.keys(catalog.rawDefinitions)) assert(labels[name] && labels[name] !== labels.fallback, `${locale}: ${name}`);
}
let parent = structuredClone(WIN_FIXES_PARENT);
let child = structuredClone(HARNESS_SS03_OBSERVER_VIEW);
const clients = new Set<ReadableStreamDefaultController>();
const send = (event: unknown) => {
  for (const client of clients) client.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
};
const grants = [
  { grant_ref: "grant-node", capability: "run_command", target: 'node -e "console.log(42)"', cwd: "C:/workspace", title: "", description: "" },
  { grant_ref: "grant-node", capability: "run_command", target: 'node -e "console.log(42)"', cwd: "C:/workspace", title: "", description: "" },
  { grant_ref: "grant-folder", capability: "write_file", target: "C:/workspace", title: "", description: "" },
];
let childReads = 0;
let accessMode = "ask_first";
const modeUpdates: string[] = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/events/live") return new Response(new ReadableStream({
    start(controller) { clients.add(controller); }, cancel() { clients.clear(); },
  }), { headers: { "content-type": "text/event-stream" } });
  let data: unknown;
  if (url.pathname === "/session-view") {
    const isChild = url.searchParams.get("session_id") === child.session_id;
    if (isChild) childReads++;
    data = isChild ? child : parent;
  } else if (url.pathname === "/session-queue") data = { queued_messages: [] };
  else if (url.pathname.endsWith("/controls")) {
    if (request.method === "PATCH") {
      const patch = await request.json();
      if (patch.access_mode) { accessMode = patch.access_mode; modeUpdates.push(accessMode); }
    }
    data = {
      session_id: parent.session_id, controls: { model: HARNESS_MODEL_CATALOG.models[0]!.model_ref, reasoning_effort: "medium", access_mode: accessMode, plan_mode: false },
      catalog_generation: HARNESS_MODEL_CATALOG.generation,
    };
  }
  else if (url.pathname === "/authority-requests") data = { session_id: parent.session_id, requests: [], permissions: grants };
  else if (url.pathname.endsWith("/output")) {
    const id = url.pathname.split("/").at(-2)!;
    const content = JSON.stringify(id.startsWith("read") ? { files: [{ path: "index.html", content: "<title>Butler</title>" }] }
      : id === "write" ? { path: "index.html", written_bytes: 21 } : { ok: true, command: id === "command" ? 'node -e "console.log(  42  )"' : "node --version", stdout: "42\n", stderr: "", exit_code: 0 });
    data = { content, complete: true, byte_end: content.length };
  } else if (url.pathname === "/navigation") data = { projects: [], chats: [], space: { nodes: [] } };
  if (data !== undefined) return Response.json({ ok: true, data });
  const file = Bun.file(join("packages/butler-app/client/ui/dist", url.pathname));
  if (await file.exists()) return new Response(file);
  if (url.pathname !== "/") return Response.json({ ok: true, data: {} });
  return new Response(Bun.file("packages/butler-app/client/ui/dist/index.html"));
} });
const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.on("pageerror", error => console.error(error));
  page.on("console", message => { if (message.type() === "error") console.error(message.text()); });
  for (const width of [1280, 375]) for (const theme of ["light", "dark"]) {
    parent = structuredClone(WIN_FIXES_PARENT); child = structuredClone(HARNESS_SS03_OBSERVER_VIEW); accessMode = "ask_first";
    parent.steward_children![0]!.relation.anchor_message_id = "harness-parent-user";
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`http://127.0.0.1:${server.port}/?visual=components&surface=win-fixes&theme=${theme}`);
    await page.locator('[data-harness-ready="true"]').waitFor({ state: "attached" });
    const card = page.locator('[data-test-class~="steward-parent-progress-card"]');
    await card.waitFor();
    const capture = async (name: string) => {
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() => document.getAnimations().every(animation =>
        animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
      await page.screenshot({ path: join(output, `${name}-${width}-${theme}.png`), fullPage: true });
    };
    for (const toggle of await page.locator('[data-test-class="toggle-turn-activity-disclosure"]').all()) await toggle.click();
    for (const toggle of await page.locator('[data-test-class~="turn-work-tool-group"] > button').all()) await toggle.click();
    const rows = page.locator('[data-test-class="turn-work-tool-detail-row"], [data-test-class="turn-work-tool-row"]');
    assert.equal(await rows.count(), WIN_FIXES_ROWS.length);
    assert(!(await rows.allTextContents()).some(text => text.includes("index.html, index.html") || text.includes("도구 사용")));
    const command = rows.filter({ hasText: "명령 실행: node" }).first();
    await command.getByRole("button").click();
    const execution = command.getByText(/^실행:/u);
    await page.waitForFunction(() => document.body.textContent?.includes('node -e "console.log(  42  )"'));
    assert.equal(await execution.textContent(), '실행: node -e "console.log(  42  )"', "canonical command preserves exact whitespace instead of a progress label");
    await command.getByText("결과:", { exact: true }).waitFor();
    assert((await command.innerText()).includes("42"));
    await rows.first().scrollIntoViewIfNeeded();
    await capture("conversation-tools-changes");
    await page.locator('[data-test-class="message-changed-file-list"]').scrollIntoViewIfNeeded();
    await capture("changed-files");
    await capture("delegated-before");
    const reads = childReads;
    child = { ...child, active_turn: { ...child.active_turn!, progress: { safe_progress_rows: [
      { id: "live-step", kind: "used_tool", state: "running", bridge_phase: "btcc_operation", safe_tool_name: "write_file", safe_input_label: "index.html", safe_label: "새 단계 적용 중" },
    ] } } };
    parent.steward_children![0]!.active_turn = child.active_turn;
    parent.steward_children![0]!.approved_plan_completed = 2;
    child.approved_plan_total = 3; child.approved_plan_completed = 2;
    send({ id: 500, type: "agent.turn_event.progress", payload: { session_id: child.session_id } });
    await card.getByText(/새 단계|작성/u).waitFor();
    assert(childReads > reads, "closed modal still receives canonical child live refresh");
    await capture("delegated-updated");
    await card.locator('[data-test-class="steward-observer-action"]').click();
    await page.locator('[data-test-class="steward-observer-dialog"]').waitFor();
    await capture("modal");
    await page.getByRole("button", { name: "닫기", exact: true }).click();
    await page.locator('[data-slot="composer-compact-preview"]').click();
    for (const [mode, label] of [["full_access", "전체 권한"], ["read_only", "읽기 전용"], ["ask_first", "모두 확인"]]) {
      await page.locator('[contenteditable="true"]').focus();
      await page.locator('[data-test-class="access-button"]').click();
      const menu = page.locator('[data-test-class="composer-menu"]');
      assert.equal(await menu.locator('[data-slot="option-menu-item"]').count(), 4, "the shipped choices despite existing grants");
      assert.equal(await page.locator('[data-test-class="granted-permissions"]').count(), 0);
      assert(!(await menu.innerText()).includes("허용한"));
      await capture(`permission-menu-${mode}`);
      await menu.getByRole("button").filter({ has: page.getByText(label, { exact: true }) }).click();
      await page.waitForFunction(label => document.querySelector('[data-test-class="access-button"]')?.getAttribute("aria-label") === `권한: ${label}`, label);
      assert.equal(accessMode, mode, "canonical session controls receive selected mode");
      assert.equal(modeUpdates.at(-1), mode);
      await menu.waitFor({ state: "hidden" });
      await capture(`permission-${mode}`);
    }
  }
  writeFileSync(join(output, "ds-map.md"), "| Element | DS component |\n|---|---|\n| Tool rows/chips | WorkActivityBlock, WorkActivityToolRow, WorkActivityToolGroup, WorkActivityOutput |\n| Delegated card | SurfacePanel, Stack, Typo, IconButton |\n| Modal | Dialog, ScrollArea, MessageRow |\n| Permission menu | Popover, OptionMenu, OptionMenuItem |\n| Changed files | DisclosureRow, ChangedLineDiff |\n");
  console.log(JSON.stringify({ ok: true, screenshots: output, childReads, toolCalls: WIN_FIXES_ROWS.length, hiddenGrants: grants.length, modeSwitches: modeUpdates.length }));
} finally { await browser.close(); server.stop(true); }
