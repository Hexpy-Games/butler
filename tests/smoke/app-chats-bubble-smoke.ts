// test-category: race
// SS10: product conversation components through the existing offline VisualHarness.
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { Page } from "playwright";
import { EMPTY_SETTINGS } from "../../packages/butler-app/client/ui/src/app/constants.ts";
import { HARNESS_NAVIGATION, HARNESS_SS03_OBSERVER_VIEW } from "../../packages/butler-app/client/ui/src/app/fixtures.ts";
import type { MessageRecord, SessionView } from "../../packages/butler-app/client/ui/src/app/types.ts";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser.ts";

if (await runSmokeCases(["light", "dark"], "BUTLER_CHATS_BUBBLE_THEME", import.meta.path, { isolate: true })) process.exit(0);
const theme = (process.env.BUTLER_CHATS_BUBBLE_THEME ?? "light") as "light" | "dark";
const shots = process.env.BUTLER_SMOKE_SCREENSHOTS ?? mkdtempSync(join(tmpdir(), "butler-chats-bubble-"));
mkdirSync(shots, { recursive: true });
const dist = resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist");
const browser = await launchSmokeBrowser();
try {
  const general = transcript("general");
  const work = transcript("butler-client");
  for (const width of [1280, 375]) {
    for (const view of [general, work]) {
      const page = await browser.newPage({ viewport: { width, height: 960 }, colorScheme: theme, reducedMotion: "reduce" });
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await installFixture(page, view);
      await page.goto(`http://chats-bubble.localhost/?visual=components&theme=${theme}&locale=ko`);
      const assistant = page.locator('[data-test-class~="message"][data-test-class~="assistant"]:has([data-test-class="turn-result-section"])').last();
      await assistant.locator('[data-test-class~="assistant-footer"] time').waitFor().catch(async error => {
        console.error(JSON.stringify({ errors, body: await page.locator("body").innerText() }));
        throw error;
      });
      await page.evaluate(() => document.fonts.ready);
      const isGeneral = view.session_id === "general";
      const screenshot = join(shots, `${isGeneral ? "chats" : "session"}-${theme}-${width}.png`);
      await page.screenshot({ path: screenshot, animations: "disabled" });
      assert.equal(await page.locator('[data-sonner-toast][data-type="error"]').count(), 0, "fixture requests succeed");
      const measured = await measure(page);
      console.log(JSON.stringify({ theme, width, session: isGeneral ? "chats" : "work", screenshot, ...measured }));
      assert.equal(measured.timeCount, 1, "the settled answer has a footer time");
      assert.equal(measured.copyCount, 1, "the footer keeps its copy action");
      if (isGeneral) {
        assert.equal(measured.bubbles, 1, "one answer is one bubble");
        assert.equal(measured.bubble!.radius, "12px");
        assert.equal(measured.user.radius, "12px");
        assert.equal(measured.bubble!.background, measured.user.background);
        assert.equal(measured.bubble!.padding, measured.user.padding);
        assert(Math.abs(measured.bubble!.left - measured.body.left) < 1, "Butler aligns left");
        assert(measured.bubble!.width <= measured.maxWidth + 0.5, "bubble respects 440px / 68% cap");
        assert.equal(measured.document!.radius, "12px");
        assert.equal(measured.document!.top - measured.bubble!.bottom, 16, "the wrapper owns the lg gap");
        assert(Math.abs(measured.document!.left - measured.bubble!.left) < 1, "document aligns to bubble");
        assert(measured.document!.width <= measured.maxWidth + 0.5, "document respects bubble cap");
        assert(Math.abs(measured.actionLayout!.rightGap) < 1, "document actions align to the card's right edge");
        if (measured.document!.width >= 400) assert(measured.actionLayout!.sameRow, "actions stay beside the name on a wide card");
        assert.equal(measured.terminalCount, 0, "completed status row is hidden");
        assert.equal(measured.completedLabel, false);
        assert.equal(measured.workedFor, false, "duration is hidden");
      } else {
        assert.equal(measured.bubbles, 0);
        assert(Math.abs(measured.answerWidth - measured.body.width) < 1, "work answer keeps full width");
        assert.equal(measured.terminalCount, 1);
        assert.equal(measured.completedLabel, true);
        assert.equal(measured.workedFor, true, "work duration stays visible");
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  }
  await assertViewportResize();
  // While a reply runs, 대화 names the current tool in its status line, counted as its timeline group would.
  for (const [locale, sessionId, expected] of [["ko", "general", "웹 검색 중 · 3개"], ["en", "general", "Web search · 3"], ["ko", "butler-client", null]] as const) {
    for (const width of [1280, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 960 }, colorScheme: theme, reducedMotion: "reduce" });
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await installFixture(page, liveTranscript(sessionId));
      await page.goto(`http://chats-bubble.localhost/?visual=components&theme=${theme}&locale=${locale}`);
      const status = page.locator('[data-test-class~="turn-current-status-slot"]').last();
      await status.waitFor();
      await page.evaluate(() => document.fonts.ready);
      const screenshot = join(shots, `live-${sessionId === "general" ? "chats" : "session"}-${locale}-${theme}-${width}.png`);
      await page.screenshot({ path: screenshot, animations: "disabled" });
      const measured = await page.evaluate(() => ({
        activity: document.querySelector('[data-test-class="turn-chat-activity"]')?.textContent ?? null,
        status: document.querySelector('[data-test-class~="turn-current-status-slot"]')?.textContent ?? "",
        timeline: document.querySelectorAll('[data-test-class~="turn-current-phase-activity"]').length,
      }));
      console.log(JSON.stringify({ theme, width, locale, session: sessionId === "general" ? "chats" : "work", screenshot, ...measured }));
      if (expected) {
        // The elapsed time follows as the last segment.
        assert.equal(measured.activity?.replace(/ · [^·]+$/u, ""), expected, "대화 status names the current tool and its count");
        assert.equal(measured.timeline, 0, "대화 keeps its activity in the status line");
      } else {
        assert.equal(measured.activity, null, "work sessions keep their status line");
        assert.equal(measured.timeline, 1, "work sessions keep their activity timeline");
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  }
  for (const kind of ["partial", "empty", "stopped"] as const) {
    for (const width of [800, ...(kind === "partial" && process.env.BUTLER_STOP_REVIEW_BEFORE !== "1" ? [390] : [])]) {
    const before = process.env.BUTLER_STOP_REVIEW_BEFORE === "1";
    const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: "reduce" });
    try {
      await installFixture(page, failedTranscript(kind));
      await page.goto(`http://chats-bubble.localhost/?visual=components&theme=${theme}&locale=ko`);
      await page.getByText("검토 요청입니다.", { exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      if (!before) {
        if (kind === "partial") {
          await page.getByText("미완료", { exact: true }).waitFor();
          assert.equal(await page.locator('[data-test-class~="assistant-footer"] time').count(), 1, "partial and failure share one timestamp");
          assert.equal(await page.getByRole("button", { name: "답변 복사", exact: true }).count(), 1, "partial and failure share one copy action");
          assert.equal(await page.locator('[role="alert"]').filter({ hasText: "검토 결과" }).count(), 0);
          assert.equal(await page.locator("strong").filter({ hasText: "검토 결과" }).count(), 1);
        }
        if (kind === "stopped") await page.getByText("중지됨", { exact: true }).waitFor();
        if (kind !== "stopped") await page.getByText("모델 응답 중단", { exact: true }).waitFor();
      }
      await page.locator('[data-test-class~="message"][data-test-class~="user"]').first().evaluate(element => {
        for (let parent = element.parentElement; parent; parent = parent.parentElement) parent.scrollTop = 0;
      });
      await page.locator('[data-test-class~="message"][data-test-class~="user"]').first().scrollIntoViewIfNeeded();
      const clip = await page.locator('[data-test-class~="message"]').evaluateAll(rows => {
        const rects = rows.map(row => row.getBoundingClientRect());
        const left = innerWidth === 390 ? 0 : Math.max(0, Math.min(...rects.map(r => r.left)));
        const top = Math.max(0, Math.min(...rects.map(r => r.top)));
        return { x: left, y: top, width: (innerWidth === 390 ? innerWidth : Math.min(innerWidth, Math.max(...rects.map(r => r.right)))) - left,
          height: Math.max(...rects.map(r => r.bottom)) - top + 8 };
      });
      await page.screenshot({ path: join(shots, `${before ? "before" : "after"}-${kind}-${theme}${width === 390 ? "-mobile" : ""}.jpg`), clip, type: "jpeg", quality: 80, animations: "disabled" });
    } finally { await page.close(); }
    }
  }
  if (process.env.BUTLER_STOP_REVIEW_BEFORE !== "1") {
    for (const [locale, expected] of [["ko", "표시할 답변이 없습니다."], ["en", "No visible answer."]] as const) {
      const page = await browser.newPage({ viewport: { width: 800, height: 1000 }, colorScheme: theme });
      try {
        const view = failedTranscript("empty");
        const failure = view.messages[1];
        failure.safe_error_code = "no_visible_result";
        failure.text = expected;
        await installFixture(page, view);
        await page.goto(`http://chats-bubble.localhost/?visual=components&theme=${theme}&locale=${locale}`);
        await page.getByText(expected, { exact: true }).waitFor();
      } finally { await page.close(); }
    }
  }
  console.log(JSON.stringify({ result: "SS10_PASS", theme, cells: 10, screenshots: shots, modelCalls: 0 }));
} finally {
  await browser.close();
}

function transcript(sessionId: string): SessionView {
  const messages: MessageRecord[] = [
    { id: "question", chat_id: sessionId, role: "user", text: "문서를 정리해 주세요.", status: "sent", cursor: 1,
      turn_id: "review", created_at: "2026-10-25T09:00:00Z" },
    { id: "answer", chat_id: sessionId, role: "assistant", status: "delivered", cursor: 2, turn_id: "review",
      text: "문서를 정리했어요.\n\n**검토 결과**를 첨부했어요. 다음 단계도 함께 확인해 주세요.",
      created_at: "2026-10-25T09:00:03Z", updated_at: "2026-10-25T09:00:03Z",
      artifacts: [{ id: "review-document", session_id: sessionId, message_id: "answer", title: "검토-결과.md",
        kind: "document", safe_path_label: "검토-결과.md", deliverable: true, size_bytes: 6104,
        url: "/message-files/file-00000000-0000-4000-8000-000000000001", created_at: "2026-10-25T09:00:03Z" }] },
  ];
  return { ...HARNESS_SS03_OBSERVER_VIEW, session_id: sessionId, messages, active_turn: null, latest_turn: null,
    kind: sessionId === "general" ? "chat" : "project", parent_session_id: undefined, relation: undefined, artifacts: [], authority_requests: [], pending_questions: [], steward_children: [], status: "idle" };
}

/** A running turn as the gateway projects it after three web searches, waiting on the next model round. */
function liveTranscript(sessionId: string): SessionView {
  const start = Date.now() - 12_000, at = (second: number) => new Date(start + second * 1000).toISOString();
  const search = (call: number) => ({ id: `search-${call}`, kind: "used_tool" as const, safe_label: "web_search", state: "delivered",
    safe_tool_name: "web_search", tool_call_id: `call-${call}`, bridge_phase: "btcc_operation" as const, semantic_block_id: `tool-call-${call}`, created_at: at(call * 2) });
  const rows = [search(1), search(2), search(3), { id: "round-3", kind: "message" as const, safe_label: "Generating", state: "running",
    safe_tool_name: "model_round", tool_call_id: "btcc-model-round-3", bridge_phase: "model_round_waiting" as const, interface_label_key: "generating", created_at: at(8) }];
  const turn = { id: "live", state: "thinking", delivery_state: "running" as const, cancellable: true, retryable: false, limitations: [], limitation_codes: [],
    progress: { turn_id: "live", state: "thinking", delivery_state: "running" as const, updated_at: at(8), safe_progress_rows: rows }, created_at: at(0), updated_at: at(8) };
  const question: MessageRecord = { id: "question", chat_id: sessionId, role: "user", text: "날씨 알려 줘", status: "sent", cursor: 1, turn_id: "live", created_at: at(0) };
  return { ...transcript(sessionId), messages: [question], active_turn: turn, latest_turn: turn, status: "active" };
}

async function installFixture(page: Page, view: SessionView) {
  const types: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
    ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".json": "application/json" };
  let settings = { ...EMPTY_SETTINGS };
  const fixture = { messages: view.messages, sessionView: view, navigation: HARNESS_NAVIGATION, background: "plain" };
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://chats-bubble.localhost") return route.abort();
    if (url.pathname === "/") {
      settings = { ...EMPTY_SETTINGS, language: url.searchParams.get("locale") === "ko" ? "ko" : "en",
        appearance_theme: url.searchParams.get("theme") === "dark" ? "dark" : "light" };
      return route.fulfill({ contentType: "text/html", body: readFileSync(join(dist, "index.html"), "utf8")
      .replace("<head>", `<head><script>window.butlerConversationFixture=${JSON.stringify(fixture).replaceAll("<", "\\u003c")}</script>`) });
    }
    if (url.pathname === "/settings") {
      if (route.request().method() === "PATCH") settings = { ...settings, ...route.request().postDataJSON() };
      return route.fulfill({ json: { ok: true, data: settings } });
    }
    const file = normalize(join(dist, decodeURIComponent(url.pathname)));
    if (file.startsWith(dist + sep) && existsSync(file) && statSync(file).isFile())
      return route.fulfill({ contentType: types[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
    if (/^\/sessions\/[^/]+\/controls$/u.test(url.pathname)) return route.fulfill({ json: { ok: true, data: {
      session_id: view.session_id, revision: 0, catalog_generation: "harness-model-catalog-v1",
      controls: { model: "openai/gpt-6-luna", reasoning_effort: "none", access_mode: "full_access", plan_mode: false },
    } } });
    if (/^\/projects\/[^/]+\/canon\/sidebar$/u.test(url.pathname))
      return route.fulfill({ json: { ok: true, data: { project_id: "butler", groups: [] } } });
    if (url.pathname === "/session-queue") return route.fulfill({ json: { ok: true, data: { queued_messages: [] } } });
    if (url.pathname === "/session-view") return route.fulfill({ json: { protocol_version: "butler.app.v1", data: view } });
    return route.fulfill({ json: { ok: true, data: {} } });
  });
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const assistant = [...document.querySelectorAll('[data-test-class~="message"][data-test-class~="assistant"]:has([data-test-class="turn-result-section"])')].at(-1)!;
    const body = assistant.querySelector('[data-test-class="message-body"]')!;
    const user = document.querySelector('[data-test-class~="message"][data-test-class~="user"] [data-test-class="message-body"]')!;
    const bubble = assistant.querySelector('[data-test-class="assistant-bubble"]');
    const card = assistant.querySelector('[data-test-class="message-artifact-list"]');
    const geometry = (node: Element) => {
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
      return { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width, radius: style.borderRadius, background: style.backgroundColor, padding: style.padding };
    };
    const footer = assistant.querySelector('[data-test-class~="assistant-footer"]')!;
    const row = card?.firstElementChild, actions = row?.lastElementChild, name = row?.children[1];
    const actionLayout = row && actions && name && actions !== name ? {
      rightGap: row.getBoundingClientRect().right - parseFloat(getComputedStyle(row).paddingRight) - actions.getBoundingClientRect().right,
      sameRow: actions.getBoundingClientRect().top < name.getBoundingClientRect().bottom,
    } : null;
    return {
      actionLayout,
      body: geometry(body), user: geometry(user), bubble: bubble ? geometry(bubble) : null, document: card ? geometry(card) : null,
      bubbles: assistant.querySelectorAll('[data-test-class="assistant-bubble"]').length,
      maxWidth: Math.min(440, assistant.getBoundingClientRect().width * 0.68),
      answerWidth: assistant.querySelector('[data-test-class="turn-result-section"]')!.getBoundingClientRect().width,
      terminalCount: assistant.querySelectorAll('[data-test-class="assistant-terminal-status-row"]').length,
      completedLabel: /답변 완료|Response completed/u.test(assistant.textContent ?? ""),
      workedFor: /작업|Worked for|worked for/u.test(footer.textContent ?? ""),
      timeCount: footer.querySelectorAll("time").length,
      copyCount: footer.querySelectorAll('[aria-label="답변 복사"], [aria-label="Copy assistant response"]').length,
    };
  });
}

function failedTranscript(kind: "partial" | "empty" | "stopped"): SessionView {
  const view = transcript("general");
  const partial = "## 검토 결과\n\n첫 번째 항목을 확인했습니다. **검토 결과**를 정리하는 중입니다.\n\n- 확인한 내용은 여기에 남습니다.\n- 다음 항목은 아직 작성 중입니다.";
  const base = { chat_id: "general", role: "assistant" as const, turn_id: "review", created_at: "2026-10-25T09:00:03Z" };
  const messages: MessageRecord[] = [{ ...view.messages[0], text: "검토 요청입니다." }];
  if (kind === "stopped" || (kind === "partial" && process.env.BUTLER_STOP_REVIEW_BEFORE !== "1")) messages.push({ ...base, id: "partial", cursor: 2,
    status: "cancelled", incomplete: kind === "partial", text: partial });
  if (kind !== "stopped") messages.push({ ...base, id: "failure", cursor: 3, status: "failed", safe_error_code: "provider_invalid_request",
    text: "모델 응답 중단" });
  return { ...view, messages };
}

async function assertViewportResize() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 }, colorScheme: theme, reducedMotion: "reduce" });
  try {
    await installFixture(page, transcript("general"));
    await page.goto(`http://chats-bubble.localhost/?visual=components&theme=${theme}&locale=ko`);
    await page.locator('[data-test-class~="assistant-footer"] time').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const result = await page.evaluate(async () => {
      const scroller = document.querySelector<HTMLElement>('[data-test-class~="message-virtual-scroll"]')!;
      const rows = () => [...scroller.querySelectorAll<HTMLElement>('[data-index]')];
      const measure = () => ({
        height: scroller.clientHeight,
        keys: rows().map(row => row.dataset.index),
        gap: scroller.getBoundingClientRect().bottom - rows().at(-1)!.getBoundingClientRect().bottom,
        headroom: rows()[0]!.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
      });
      await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
      const before = measure();
      const after = await new Promise<ReturnType<typeof measure>>(resolve => {
        const observer = new ResizeObserver(() => {
          if (scroller.clientHeight === before.height) return;
          observer.disconnect();
          requestAnimationFrame(() => resolve(measure()));
        });
        observer.observe(scroller);
        Object.assign(scroller.style, { flex: "none", height: `${before.height - 160}px` });
      });
      return { before, after };
    });
    console.log(JSON.stringify({ viewportResize: result, theme }));
    assert(result.before.headroom > 160, "conversation stays short enough for bottom alignment");
    assert.equal(result.after.height, result.before.height - 160);
    assert.deepEqual(result.before.keys, ["0", "1", "2"], "both messages and the chat intro are rendered");
    assert.deepEqual(result.after.keys, result.before.keys, "resize keeps the virtual range");
    assert(Math.abs(result.after.gap - result.before.gap) < 1, "bottom alignment updates by the next frame after resize delivery");
  } finally { await page.close(); }
}
