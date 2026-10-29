// Replayed public contracts for the subtask smoke: the native App, store and
// subscriptions run; only the parent chat's /navigation row and /session-view,
// its pending asks and the resume endpoint answer from these renderer-only fixtures.
import type { Locator, Page, Route } from "playwright";
import type { SessionPendingAsks } from "../../packages/butler-app/client/shared/pending-asks-contracts.ts";
import { HARNESS_SS03_OBSERVER_VIEW, HARNESS_SS03_SUMMARY } from "../../packages/butler-app/client/ui/src/app/fixtures.ts";
import type { MessageRecord, NavigationView, SessionView, SubtaskView } from "../../packages/butler-app/client/ui/src/app/types.ts";

export const COPY = {
  ko: { parent: "로그인 오류 원인 찾기", other: "README 번역 검토", ask: "로그 폴더 읽기",
    request: "로그인 실패 원인을 찾아 줘. 토큰 갱신과 테스트도 같이 봐 줘.", reply: "세 갈래로 나눠 하위 작업으로 맡겼습니다. 끝나는 대로 정리해 드릴게요.",
    titles: ["토큰 갱신 로직 검토", "회귀 테스트 정리", "로그인 실패 로그를 시간대별로 모아 원인 후보 정리"] },
  en: { parent: "Find the sign-in error", other: "Review the README translation", ask: "Read the log folder",
    request: "Find why sign-in fails. Check token refresh and the tests too.", reply: "I split this into three subtasks. I'll sum up as each one finishes.",
    titles: ["Review the token refresh logic", "Tidy the regression tests", "Group the sign-in failure logs by hour and list likely causes"] },
};

export function subtaskFixtures(lang: "ko" | "en"): SubtaskView[] {
  const [working, paused, approval] = COPY[lang].titles;
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  return [
    { session_id: "steward-subtask-working", relation_id: "relation-working", title: working!, state: "working", plan_completed: 2, plan_total: 5, started_at: at(9) },
    { session_id: "steward-subtask-paused", relation_id: "relation-paused", title: paused!, state: "paused", started_at: at(6) },
    { session_id: "steward-subtask-approval", relation_id: "relation-approval", title: approval!, state: "needs_approval", plan_completed: 0, plan_total: 3, started_at: at(3) },
  ];
}

export type SubtaskReplay = {
  parentId: string;
  lang: "ko" | "en";
  subtasks: SubtaskView[];
  /** The approval also listed under 답을 기다리는 요청, as the gateway does (PA-03). */
  asksOn: boolean;
  resumed: { relation: string; parent: string }[];
};

function approvalAsk(session: string, subtask: SubtaskView, title: string): SessionPendingAsks["asks"][number] {
  const now = new Date().toISOString();
  return { ask_id: "approval:subtask", kind: "approval", session_id: session, source_session_id: subtask.session_id,
    source_turn_id: "subtask-turn", source_message_id: null, source_call_id: null, title, blocking: true, deferred: false,
    waiting_since: new Date(Date.now() - 60_000).toISOString(), state: "open", created_at: now, actions: ["open"] };
}

function conversation(chat: string, lang: "ko" | "en"): MessageRecord[] {
  const base = HARNESS_SS03_OBSERVER_VIEW.messages[0]!;
  const at = new Date(Date.now() - 10 * 60_000).toISOString();
  return [
    { ...base, id: "subtask-request", chat_id: chat, role: "user", cursor: 1, text: COPY[lang].request, status: "delivered", turn_id: undefined, created_at: at, updated_at: at },
    { ...base, id: "subtask-reply", chat_id: chat, role: "assistant", cursor: 2, text: COPY[lang].reply, status: "delivered", turn_id: "subtask-parent-turn", created_at: at, updated_at: at },
  ];
}

/** Active chat, open sidebar, and a replayed event transport (`__emitWorkEvent`); the App's own subscription runs. */
export async function installSubtaskPage(page: Page, active: string) {
  await page.addInitScript(id => {
    localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({ schema: "butler.app-ui-state.v1",
      cached_at: new Date().toISOString(), active_session_id: id, left_open: true, right_open: false }));
    class ReplayEventSource {
      onmessage?: (event: { data: string }) => void;
      onopen?: () => void;
      constructor() {
        Object.assign(window, { __emitWorkEvent: (event: unknown) => this.onmessage?.({ data: JSON.stringify(event) }) });
        queueMicrotask(() => this.onopen?.());
      }
      addEventListener() {}
      close() {}
    }
    Object.assign(window, { EventSource: ReplayEventSource });
  }, active);
}

/** `origin`: the Butler page origin; forwarded reads must carry it like the page's own requests. */
export async function replaySubtasks(page: Page, replay: SubtaskReplay, origin: string) {
  const parent = replay.parentId;
  const approval = () => replay.subtasks.find(subtask => subtask.state === "needs_approval");
  const forward = async (route: Route) => route.fetch({ headers: { ...await route.request().allHeaders(), origin } });
  await page.route("**/navigation", async route => {
    const response = await forward(route);
    const real = await response.json() as { data?: NavigationView };
    if (!real.data?.chats) return route.fulfill({ response });
    const chats = real.data.chats.map(chat => chat.id !== parent ? chat : {
      ...chat, subtasks: replay.subtasks, running_delegated_work: replay.subtasks.length > 0,
      attention_required: Boolean(approval()), attention_source: approval() ? "subtask" as const : undefined,
    });
    return route.fulfill({ json: { ...real, data: { ...real.data, chats } } });
  });
  await page.route("**/session-view?**", async route => {
    const id = new URL(route.request().url()).searchParams.get("session_id");
    const child = replay.subtasks.find(subtask => subtask.session_id === id);
    if (child) return route.fulfill({ json: { protocol_version: "butler.app.v1", data: {
      ...structuredClone(HARNESS_SS03_OBSERVER_VIEW), session_id: child.session_id, parent_session_id: parent,
      relation: { ...HARNESS_SS03_SUMMARY.steward_children![0]!.relation, relation_id: child.relation_id, parent_session_id: parent, safe_title: child.title },
    } } });
    if (id !== parent) return route.continue();
    const response = await forward(route);
    const real = await response.json() as { data?: SessionView };
    if (!real.data) return route.fulfill({ response });
    const messages = conversation(parent, replay.lang);
    return route.fulfill({ json: { ...real, data: { ...real.data, subtasks: replay.subtasks, messages,
      message_window: { ...real.data.message_window, next_cursor: messages.length, complete: true } } } });
  });
  await page.route(`**/sessions/${parent}/pending-asks`, route => {
    const subtask = approval();
    const asks = replay.asksOn && subtask ? [approvalAsk(parent, subtask, COPY[replay.lang].ask)] : [];
    return route.fulfill({ json: { protocol_version: "butler.app.v1", data: { session_id: parent, open_count: asks.length, asks } } });
  });
  await page.route("**/steward-relations/*/resume", async route => {
    const relation = decodeURIComponent(new URL(route.request().url()).pathname.split("/")[2]!);
    const body = route.request().postDataJSON() as { parent_session_id: string };
    replay.resumed.push({ relation, parent: body.parent_session_id });
    replay.subtasks = replay.subtasks.map(subtask => subtask.relation_id === relation ? { ...subtask, state: "working" } : subtask);
    return route.fulfill({ status: 202, json: { protocol_version: "butler.app.v1", data: { status: "resuming" } } });
  });
}

/** The hover fill's inset from the card's border box on each side (px); negative means it crosses the edge. */
export async function hoverInset(row: Locator): Promise<{ left: number; right: number; radius: string }> {
  await row.hover();
  return row.evaluate(element => {
    const card = element.closest('[data-slot="card"]') ?? element.closest("[data-session-section]")!;
    const fill = element.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    return { left: fill.left - box.left, right: box.right - fill.right, radius: getComputedStyle(element).borderTopLeftRadius };
  });
}

/**
 * Each nested subtask mark's x-centre minus the parent row's spinner x-centre, keyed by mark
 * (progress = working, attention = needs approval, resume = paused).
 */
export async function markDeltas(sidebar: Locator): Promise<Record<string, number>> {
  return sidebar.evaluate(root => {
    const lines = root.querySelector('[data-test-class="subtask-lines"]')!;
    const centre = (node: Element) => { const box = node.getBoundingClientRect(); return box.left + box.width / 2; };
    const spinner = centre(lines.previousElementSibling!.querySelector('[data-slot="spinner"]')!);
    const deltas: Record<string, number> = {};
    for (const mark of lines.querySelectorAll('[data-test-class="subtask-progress"], [data-test-class="subtask-attention"], [data-test-class="subtask-resume"]')) {
      deltas[mark.getAttribute("data-test-class")!.replace("subtask-", "")] = Math.round((centre(mark) - spinner) * 100) / 100;
    }
    return deltas;
  });
}

/** The x delta between a parent row's title and each nested subtask title. */
export async function titleDeltas(sidebar: Locator): Promise<number[]> {
  return sidebar.evaluate(root => {
    const lines = root.querySelector('[data-test-class="subtask-lines"]')!;
    const parent = lines.previousElementSibling!.querySelector('[data-slot="nav-row-label"]')!.getBoundingClientRect().left;
    return [...lines.querySelectorAll('[data-test-class="subtask-line"] [data-slot="nav-row-label"]')]
      .map(label => Math.round((label.getBoundingClientRect().left - parent) * 100) / 100);
  });
}
