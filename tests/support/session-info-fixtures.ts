import type { SessionPendingAsks } from "../../packages/butler-app/client/shared/pending-asks-contracts.ts";
import { probeFocusRingFrames, type FocusRingClip } from "./focus-ring-clipping.ts";
import type { Locator, Page, Route } from "playwright";
import type { EpicProgressSnapshot } from "../../packages/butler-app/client/shared/canon-contracts.ts";
import type { QueuedMessageRecord, SessionView, SessionViewTurn, SubtaskView } from "../../packages/butler-app/client/ui/src/app/types.ts";
import { HARNESS_SUMMARY } from "../../packages/butler-app/client/ui/src/app/fixtures.ts";

/** Running turn with public progress; replaySession supplies its queued follow-up. */
export function runningSession(view: SessionView): SessionView {
  const turn: SessionViewTurn = {
    id: "session-info-turn", state: "thinking", cancellable: true, retryable: false,
    created_at: view.updated_at, updated_at: view.updated_at,
    progress: { turn_id: "session-info-turn", state: "thinking", safe_progress_rows: [
      { id: "accepted", kind: "message", state: "completed", safe_label: "요청을 확인했습니다. 릴리스 노트와 변경 사항을 검토합니다." },
      { id: "round-1", kind: "thinking", bridge_phase: "model_round_waiting", thinking_title: "검토할 변경 사항 정리", state: "completed", safe_label: "모델 응답 1 · 검토할 변경 사항 정리" },
      { id: "tool-1", kind: "ran_command", bridge_phase: "btcc_operation", tool_call_id: "diff-stat", safe_tool_name: "run_command", state: "completed", safe_label: "변경 파일 읽기", safe_input_label: "git diff --stat" },
      { id: "round-2", kind: "thinking", bridge_phase: "model_round_waiting", thinking_title: "변경 사항 검토", state: "running", safe_label: "모델 응답 2 · 변경 사항 검토" },
    ] },
  };
  return { ...view, active_turn: turn, latest_turn: turn };
}

/** Canonical session-view replay: renderer-only coverage, never production fixtures. */
export function populatedSession(view: SessionView): SessionView {
  return {
    ...runningSession(view),
    pending_questions: [sessionQuestion(view.session_id)],
    branch: { workspace_label: "butler", branch_name: "feat/session-info-pane", workspace_binding: "project", workspace_status: "available" },
    context: sessionContext(view.session_id),
    artifacts: HARNESS_SUMMARY.artifacts!.map(item => ({ ...item, session_id: view.session_id, title: "검토 결과.md", deliverable: true })),
    automations: [{ automation_id: "session-schedule", title: "진행 상황 확인", schedule_type: "interval", interval_seconds: 3600 }],
    messages: [{ id: "session-info-message", chat_id: view.session_id, role: "assistant", text: "검토를 시작했습니다.", created_at: new Date().toISOString() },
      { id: "session-info-upload", chat_id: view.session_id, role: "user", text: "이 자료를 검토해 주세요.", created_at: new Date().toISOString(),
      attachments: [{ file_id: "session-info-file", kind: "text", mime_type: "text/plain", safe_name: "검토 자료.txt", size_bytes: 42,
        sha256: "", url: "/message-files/session-info-file", created_at: new Date().toISOString() }] }],
  };
}

export async function replaySession(page: Page, view: () => SessionView, asksOpen = () => true) {
  await page.route("**/sessions/*/pending-asks", route => route.fulfill({ json: { protocol_version: "butler.app.v1", data: pendingPage(view(), asksOpen()) } }));
  // Visual replay supplies a representative 3/5 task; native route coverage runs separately.
  await page.route("**/canon/epics/*/progress", route => {
    const progress: EpicProgressSnapshot = { epic_id: new URL(route.request().url()).pathname.split("/")[3]!,
      running: true, stage: null, stage_history: [], actions: [{ work_id: "release-review", actionKey: "review", dependencyKeys: [], description: "릴리스 노트 검토", status: "active" }], disposition: null, counts: { completed: 3, total: 5 } };
    return route.fulfill({ json: { protocol_version: "butler.app.v1", data: progress } });
  });
  await page.route("**/session-queue?**", route => {
    const session = view();
    const queued: QueuedMessageRecord[] = session.latest_turn ? [{ id: "queued-review", chat_id: session.session_id,
      text: "검토 결과 정리", state: "queued", cursor: 1, created_at: session.updated_at, updated_at: session.updated_at,
      controls: { model: "custom/stub", reasoning_effort: "none", access_mode: "ask_first", plan_mode: false } }] : [];
    return route.fulfill({ json: { protocol_version: "butler.app.v1", data: { session_id: session.session_id, queued_messages: queued } } });
  });
  await page.route("**/session-view?**", route => route.fulfill({ json: { protocol_version: "butler.app.v1", data: view() } }));
}

/** Fail only the browser projection request; the native App remains unchanged. */
export async function failPendingAsksRead(page: Page) {
  const fail = (route: Route) => route.fulfill({
    status: 503, json: { error: "Projection temporarily unavailable" },
  });
  await page.route("**/sessions/*/pending-asks", fail);
  return () => page.unroute("**/sessions/*/pending-asks", fail);
}

/** A browser bridge stub; `tabs` are the open tabs (e.g. a conversation's agent tabs for the rail). */
export async function installSessionBrowser(page: Page, tabs: Record<string, unknown>[] = []) {
  await page.addInitScript((tabs) => {
    const state = { enabled: true, blocked: false, activeId: null as string | null, restored: true, nativeCovered: false, tabs };
    const off = () => () => {};
    const subscriptions = new Map<string, number>();
    const calls: { method: string; input?: { id?: string } }[] = [];
    const handlers = new Set<(value: typeof state) => void>();
    const canvas = document.createElement("canvas");
    canvas.width = 16; canvas.height = 10;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#a4b5c6"; context.fillRect(0, 0, 16, 10);
    const bytes = Uint8Array.from(atob(canvas.toDataURL("image/jpeg").split(",")[1]!), char => char.charCodeAt(0));
    Object.assign(window, { __liveFrameSubs: subscriptions, __browserCalls: calls, __browserState: state, butlerBrowser: {
      call: async (method: string, input?: { id?: string }) => {
        calls.push({ method, input });
        if (method === "activate" && input?.id) {
          state.activeId = input.id;
          for (const handler of handlers) handler({ ...state });
        }
        return method === "state" || method === "open" ? state : null;
      },
      subscribe: (handler: (value: typeof state) => void) => {
        handlers.add(handler); queueMicrotask(() => handler(state)); return () => handlers.delete(handler);
      },
      onFrame: (id: string, handler: (frame: { tab: string; seq: number; bytes: Uint8Array; masked: boolean }) => void) => {
        subscriptions.set(id, (subscriptions.get(id) ?? 0) + 1);
        queueMicrotask(() => handler({ tab: id, seq: 1, bytes, masked: false }));
        return () => {
          const remaining = (subscriptions.get(id) ?? 1) - 1;
          if (remaining) subscriptions.set(id, remaining); else subscriptions.delete(id);
        };
      }, onPointer: off, onElementDrag: off, onSelectionAction: off, onDownload: off, onHistory: off, onAddress: off,
    } });
  }, tabs);
}

export function sessionQuestion(sessionId: string): NonNullable<SessionView["pending_questions"]>[number] {
  return { request_ref: "question-ref", source_turn_id: "session-info-turn", source_session_id: sessionId,
    question_state: "pending", category: "ask_user", questions: { questions: [{ id: "review", eyebrow: "검토", title: "어떤 범위를 검토할까요?",
      kind: "single", allow_custom: false, options: [{ id: "all", label: "전체" }, { id: "changes", label: "변경 사항" }] }] } };
}
function pendingPage(view: SessionView, open: boolean): SessionPendingAsks {
  const asks: SessionPendingAsks["asks"] = (open ? view.pending_questions ?? [] : []).map(question => ({
    ask_id: question.request_ref, kind: "question", session_id: view.session_id, source_session_id: view.session_id,
    source_turn_id: question.source_turn_id, source_message_id: view.messages.find(message => message.role === "assistant")?.id ?? null,
    source_call_id: null, title: question.questions.questions[0]!.title, blocking: true, deferred: false,
    waiting_since: new Date().toISOString(), state: "open", created_at: view.updated_at, actions: ["answer"],
  }));
    if (asks.length) asks.push(
    { ...asks[0]!, ask_id: "release-approval", kind: "approval", title: "릴리스 노트 초안 커밋", actions: ["open"], waiting_since: new Date(Date.now() - 120000).toISOString() },
    { ...asks[0]!, ask_id: "release-question", title: "릴리스 노트에 넣을지", deferred: true, actions: ["answer"], waiting_since: new Date(Date.now() - 240000).toISOString() },
  );
  return { session_id: view.session_id, open_count: asks.length, asks };
}
export async function installPendingAskEvents(page: Page) {
  await page.addInitScript(() => {
    const sources: EventSource[] = [];
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) { super(url, options); sources.push(this); }
    };
    Object.assign(window, { __sessionInfoEventSources: sources });
  });
}
export async function pendingAsksChanged(page: Page, sessionId: string) {
  await page.waitForFunction(() => Boolean((window as unknown as { __sessionInfoEventSources?: EventSource[] }).__sessionInfoEventSources?.length));
  await page.evaluate(sessionId => {
    const source = (window as unknown as { __sessionInfoEventSources: EventSource[] }).__sessionInfoEventSources.at(-1)!;
    source.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "pending_asks.changed", payload: { session_id: sessionId, open_count: 0 } }) }));
  }, sessionId);
}

export async function auditSessionInfoFocus(page: Page, scope: Locator) {
  const targets = scope.locator('button, [role="button"], input, select, [tabindex="0"]');
  const clips: FocusRingClip[] = [];
  let stops = 0;
  await page.keyboard.press("Tab");
  for (const target of await targets.all()) {
    if (!await target.isVisible() || !await target.isEnabled()) continue;
    clips.push(...await probeFocusRingFrames(page, () => target.focus()));
    stops++;
  }
  return { stops, clips };
}

/** The ten current server categories, including all reserves. */
function sessionContext(sessionId: string) {
  const categories = [
    ["working", 41_400], ["current-input", 1_300], ["retrieved", 7_600], ["references", 900],
    ["live-config", 6_800], ["static", 2_400], ["runtime-state", 2_400],
    ["output-reserve", 16_000], ["tool-reserve", 16_000], ["compaction-reserve", 4_800],
  ] as const;
  const used = categories.slice(0, 7).reduce((sum, [, tokens]) => sum + tokens, 0);
  return { ...structuredClone(HARNESS_SUMMARY.context_details!), session_id: sessionId,
    used_tokens: used, ratio: used / 258_000,
    categories: categories.map(([id, tokens]) => ({ id, label: id, used_tokens: tokens,
      budget_tokens: 258_000, ratio: tokens / 258_000, safe_description: id,
      source_kind: id.endsWith("-reserve") ? id.replaceAll("-", "_") : undefined })),
  };
}

/** Two delegated reviews, one with a live, finished and failed worker. */
export function sessionWorkerSubtasks(): SubtaskView[] {
  return [
    { session_id: "review-changes", relation_id: "changes-relation", title: "변경 사항 검토", state: "working", started_at: "2026-11-01T09:00:00Z",
      workers: [
        { session_id: "review-api", relation_id: "api-relation", title: "API 변경 확인", status: "active" },
        { session_id: "review-copy", relation_id: "copy-relation", title: "문구 검토", status: "completed" },
        { session_id: "review-build", relation_id: "build-relation", title: "빌드 결과 확인", status: "failed" },
      ] },
    { session_id: "review-notes", relation_id: "notes-relation", title: "릴리스 노트 정리", state: "working", started_at: "2026-11-01T09:01:00Z" },
  ];
}
