// test-category: race
// Real App UI with replayed gateway responses: a cached chat opens on its newest answer and stays there while the server's longer window loads.
import { strict as assert } from "node:assert";
import { initiatedMessage, installInitiatedGateway, session } from "../support/initiated-fixtures";
import { launchSmokeBrowser } from "../support/smoke-browser";
import { snapshotForCache } from "../../packages/butler-app/client/ui/src/app/messageCache.ts";
import { APP_CACHE_BUDGET } from "../../packages/butler-app/client/ui/src/app/cacheBudget.ts";
import { HARNESS_SS03_SUMMARY } from "../../packages/butler-app/client/ui/src/app/fixtures";
import type { MessageRecord } from "../../packages/butler-app/client/ui/src/app/types.ts";

const messages: MessageRecord[] = [];
for (let i = 0; i < 60; i++) {
  const hour = Date.parse("2026-10-20T00:00:00Z") + i * 60 * 60 * 1000;
  messages.push({ id: `ask-${i}`, chat_id: "general", turn_id: `turn-${i}`, role: "user",
    status: "sent", cursor: 2 * i + 1, created_at: new Date(hour).toISOString(), text: `${i}번째 질문` });
  messages.push({ id: `answer-${i}`, chat_id: "general", turn_id: `turn-${i}`, role: "assistant",
    status: "delivered", cursor: 2 * i + 2, created_at: new Date(hour + 60 * 1000).toISOString(),
    text: [`## ${i}번째 브리핑`, ...Array.from({ length: 100 }, (_, j) =>
      `- 항목 ${j + 1}: 오늘 확인한 소식과 수치를 한 줄로 정리한 문장입니다. 출처와 시각을 함께 적었습니다.`)].join("\n") });
}
const report: MessageRecord = { ...initiatedMessage("report"), id: "delegated-report", text: "", artifacts: [], turn_id: "schedule-turn", cursor: 121,
  work_blocks: [{ id: "delegate-block", label: "delegate_to_steward", state: "delivered", rows: [{ id: "delegate-row", kind: "used_tool",
    safe_label: "delegate_to_steward", state: "delivered", safe_tool_name: "delegate_to_steward", tool_call_id: "delegate-call" }] }] };
messages.push(report);
const child = structuredClone(HARNESS_SS03_SUMMARY.steward_children![0]!);
child.relation = { ...child.relation, parent_session_id: "general", parent_turn_id: "schedule-turn", anchor_message_id: "schedule-request" };
const server = { ...session(messages), steward_children: [child] };
const cache = snapshotForCache("general", { chat_id: "general", messages, turn_progress: {}, next_cursor: messages.length });
assert(cache);
assert(cache.messages.length < messages.length);
assert.equal(cache.messages.at(-1)!.id, messages.at(-1)!.id);
assert(new TextEncoder().encode(JSON.stringify(cache)).byteLength <= APP_CACHE_BUDGET.maxSnapshotBytes);

type Frame = { fromEnd: number | null; rows: { top: number; bottom: number; id: string }[] };
const browser = await launchSmokeBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: "light", reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    if (sessionStorage.getItem("cached-chat-ui-seeded")) return;
    sessionStorage.setItem("cached-chat-ui-seeded", "1");
    localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({ schema: "butler.app-ui-state.v1",
      cached_at: new Date().toISOString(), active_session_id: "other", left_open: true, right_open: false }));
  });
  await installInitiatedGateway(page, "ko", "light", server);
  // The harness preload has no cache budget argument and clears cached chats; seed after it, before the App reads the cache.
  await page.addInitScript(snapshot => {
    if (sessionStorage.getItem("cached-chat-messages-seeded")) return;
    sessionStorage.setItem("cached-chat-messages-seeded", "1");
    localStorage.setItem("butler:message-cache:v1:general", JSON.stringify(snapshot));
  }, cache);
  await page.addInitScript(() => {
    const frames: Frame[] = [];
    Object.assign(window, { __frames: frames });
    const sample = () => {
      const scroller = document.querySelector('[data-test-class~="message-virtual-scroll"]');
      const fromEnd = scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight : null;
      const rows = [...document.querySelectorAll('[data-test-class~="message"]')].map(node => {
        const rect = node.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, id: (node.textContent ?? "").slice(0, 12) };
      }).filter(row => row.bottom > 0 && row.top < window.innerHeight);
      frames.push({ fromEnd, rows });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  let releaseSnapshot!: () => void;
  const heldSnapshot = new Promise<void>(resolve => { releaseSnapshot = resolve; });
  await page.route("**/session-view*", async route => {
    if (new URL(route.request().url()).searchParams.get("session_id") === "general") await heldSnapshot;
    await route.fallback();
  });
  await page.goto("http://127.0.0.1:43827/");
  const general = page.locator('[data-tree-item="s:general"] [data-test-class~="tree-row"]');
  await general.waitFor();
  await general.click();
  await page.getByText("59번째 브리핑", { exact: true }).waitFor();
  const lastAnswer = page.locator('[data-test-class~="message"][data-test-class~="assistant"]').last();
  assert.equal(await lastAnswer.locator("time").count(), 0, "no bare footer before the card");
  assert.equal(await page.locator('[data-test-class~="steward-parent-progress-card"]').count(), 0, "no bare footer before the card");
  await page.evaluate(() => { (window as unknown as { __frames: Frame[] }).__frames.length = 0; });
  const newest = () => [...document.querySelectorAll('[data-test-class~="message"]')].find(node => node.textContent?.includes("59번째 브리핑"));
  await page.evaluate(`window.__newest = (${newest})()`);
  releaseSnapshot();
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('[data-test-class~="steward-parent-progress-card"]').count(), 1, "the footer comes with the card");
  assert.equal(await lastAnswer.locator("time").count(), 1, "the footer comes with the card");
  const frames = await page.evaluate(() => (window as unknown as { __frames: Frame[] }).__frames);
  assert(frames.length > 0, "at least one frame was sampled");
  for (const frame of frames) {
    assert(frame.fromEnd !== null && frame.fromEnd < 2, `the chat stays on its newest answer: ${JSON.stringify(frame)}`);
    const rows = frame.rows.toSorted((a, b) => a.top - b.top);
    for (let k = 1; k < rows.length; k++) {
      assert(rows[k].top >= rows[k - 1].bottom - 1, `rows never overlap while older messages load: ${JSON.stringify(frame)}`);
    }
  }
  assert(await page.evaluate(`window.__newest.isConnected && window.__newest === (${newest})()`), "the newest answer keeps its row while older messages load");
  assert.deepEqual(errors, []);
  await page.locator('[data-test-class~="message-virtual-scroll"]').evaluate(node => { node.scrollTop = 0; });
  await page.getByText("0번째 질문", { exact: true }).waitFor();
  console.log(JSON.stringify({ result: "PASS", frames: frames.length, cachedRows: cache.messages.length, totalRows: messages.length,
    cacheBytes: new TextEncoder().encode(JSON.stringify(cache)).byteLength }));
} finally { await browser.close(); }
