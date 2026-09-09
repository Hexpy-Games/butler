import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useButlerStore } from "@/app/store.ts";
import type { ProgressRow, SessionView, WorkerActivitySummary } from "@/app/types.ts";
import { SessionObserverTimeline } from "./SessionObserverTimeline.tsx";
import { getAppLocale, setAppCopyLanguage } from "@/app/copy.ts";

test("Worker return continues one expanded activity list and retains each tool's original Turn", async () => {
  const previousLocale = getAppLocale();
  setAppCopyLanguage("ko");
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const before = useButlerStore.getState();
  const globals = ["window", "document", "navigator", "HTMLElement", "Node", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const saved = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IS_REACT_ACT_ENVIRONMENT: true });
  const worker: WorkerActivitySummary = { worker_id: "ivy", worker_display_name: "Ivy", worker_label: "Worker",
    parent_turn_id: "delegating-turn", source_tool_call_id: "worker-call", phase: "complete",
    status_line: "완료", objective: "OAuth 구현", terminal: true, supported_controls: [],
    approved_plan_total: 1, approved_plan_completed: 1 };
  useButlerStore.setState({ observerSessionId: "steward",
    sessionViews: { ...before.sessionViews, steward: { workers: [worker] } as SessionView } });
  const oldRows: ProgressRow[] = [activity("execution", "구현 위임", "10:00:00"), {
    id: "worker-call", kind: "used_tool", state: "delivered", safe_label: "워커 호출",
    safe_tool_name: "delegate_to_worker", tool_call_id: "worker-call",
    semantic_block_id: "execution", bridge_phase: "btcc_operation", created_at: "2026-09-06T10:00:01Z",
  }];
  const newRows = [activity("review", "워커 결과 검토", "10:02:00")];
  const oldHistory = { turn_id: "delegating-turn", created_at: "2026-09-06T10:00:00Z", rows: oldRows };
  const newHistory = { turn_id: "result-turn", created_at: "2026-09-06T10:02:00Z", rows: newRows };
  const container = dom.window.document.querySelector("#root")!;
  const root = createRoot(container);
  try {
    await act(async () => root.render(<SessionObserverTimeline messages={[]}
      activeTurn={active("delegating-turn", oldRows, oldHistory.created_at)} />));
    const header = container.querySelector('[data-test-class="toggle-turn-activity-disclosure"]') as HTMLButtonElement;
    await act(async () => header.click());
    expect(container.textContent).toContain("Ivy");
    await act(async () => root.render(<SessionObserverTimeline messages={[]}
      activityHistory={[oldHistory]} activeTurn={active("result-turn", newRows, newHistory.created_at)} />));
    expect(container.querySelectorAll('[data-test-class="turn-current-phase-activity"]')).toHaveLength(1);
    expect(container.querySelector('[data-test-class="toggle-turn-activity-disclosure"]')).toBe(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(header.textContent).toContain("2개 기록");
    expect(container.querySelectorAll('[data-test-class="collapse-turn-activity-history"]')).toHaveLength(1);
    const oldItem = container.querySelector('li[data-turn-id="delegating-turn"]')!;
    const reviewItem = container.querySelector('li[data-turn-id="result-turn"]')!;
    expect(oldItem.textContent).toContain("Ivy");
    expect(reviewItem.textContent).not.toContain("Ivy");
    expect(reviewItem.textContent).toContain("워커 결과 검토");
    expect(container.textContent!.indexOf("Ivy")).toBeLessThan(container.textContent!.indexOf("워커 결과 검토"));
    expect(container.querySelector("[data-turn-ids]")?.getAttribute("data-turn-ids"))
      .toBe("delegating-turn result-turn");

    await act(async () => root.render(<SessionObserverTimeline messages={[]}
      activityHistory={[oldHistory, newHistory]} />));
    expect(container.querySelector('[data-test-class="toggle-turn-activity-disclosure"]')).toBe(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelectorAll('[data-test-class="turn-current-status-slot"]')).toHaveLength(0);

    await act(async () => root.render(<SessionObserverTimeline messages={[{
      id: "direction", chat_id: "steward", role: "user", text: "실제 Butler 추가 지시",
      status: "delivered", created_at: "2026-09-06T10:01:00Z",
    }]} activityHistory={[oldHistory, newHistory]} />));
    expect(container.querySelectorAll('[data-test-class="turn-current-phase-activity"]')).toHaveLength(2);
    expect(container.textContent!.indexOf("Ivy")).toBeLessThan(container.textContent!.indexOf("실제 Butler 추가 지시"));

    await act(async () => root.render(<SessionObserverTimeline messages={[{
      id: "later-direction", chat_id: "steward", role: "user", text: "다음 활동 전에 도착한 지시",
      status: "delivered", created_at: "2026-09-06T10:03:00Z",
    }]} activityHistory={[oldHistory]} activeTurn={active("result-turn", newRows, newHistory.created_at)} />));
    expect(container.querySelectorAll('[data-test-class="turn-current-phase-activity"]')).toHaveLength(1);
    expect(container.querySelectorAll('li[data-turn-id="result-turn"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-test-class="turn-current-status-slot"]')).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    setAppCopyLanguage(previousLocale);
    useButlerStore.setState({ observerSessionId: before.observerSessionId, sessionViews: before.sessionViews });
    globals.forEach((key, index) => { const value = saved[index];
      if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); });
    dom.window.close();
  }
});

function activity(id: string, title: string, time: string): ProgressRow {
  return { id, kind: "message", state: "running", safe_label: title,
    semantic_block_id: id, activity_stage: id, work_decision_source: "model-authored",
    work_decision_title: title, work_decision_summary: title, created_at: `2026-09-06T${time}Z` };
}

function active(id: string, rows: ProgressRow[], created_at: string): NonNullable<SessionView["active_turn"]> {
  return { id, state: "running", created_at, updated_at: created_at, cancellable: true, retryable: false,
    limitations: [], limitation_codes: [], progress: { summary: "검토 중", safe_progress_rows: rows } };
}
