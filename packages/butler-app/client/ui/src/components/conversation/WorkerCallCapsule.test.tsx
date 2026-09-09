import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useButlerStore } from "@/app/store.ts";
import type { SessionView, WorkerActivitySummary } from "@/app/types.ts";
import { TurnActivityTimeline } from "./TurnActivityTimeline";
import { WorkActivityToolGroup } from "@/libs/design-system/blocks/WorkActivityBlock/WorkActivityToolGroup";
import { WorkerCallCapsule } from "./WorkerCallCapsule";
import { getAppLocale, setAppCopyLanguage } from "@/app/copy.ts";

test("Worker stays below the aggregate while its invocation is inside the expanded list", async () => {
  const previousLocale = getAppLocale();
  setAppCopyLanguage("ko");
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const before = useButlerStore.getState();
  const globals = ["window", "document", "navigator", "HTMLElement", "Node", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const saved = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
  const worker: WorkerActivitySummary = { worker_id: "worker", worker_display_name: "Juno", worker_label: "Worker",
    parent_turn_id: "turn", source_tool_call_id: "call", phase: "executing", status_line: "작업 중",
    objective: "Implement", current_activity_title: "읽기: routes.ts", terminal: false,
    supported_controls: [], approved_plan_total: 3, approved_plan_completed: 1 };
  const setWorker = (value: WorkerActivitySummary) => useButlerStore.setState({ observerSessionId: "steward",
    sessionViews: { ...before.sessionViews, steward: { workers: [value,
      { ...value, worker_id: "wrong", worker_display_name: "Other", parent_turn_id: "other-turn" }],
    } as SessionView } });
  setWorker(worker);
  const container = dom.window.document.querySelector("#root")!;
  const root = createRoot(container);
  try {
    await act(async () => root.render(<TurnActivityTimeline live turnId="turn" activities={[{
      id: "execution", phase: "execution", title: "구현 위임", summary: "구현 위임",
      operations: [{ id: "wait", kind: "used_tool", state: "delivered", bridge_phase: "btcc_operation", safe_tool_name: "wait_for_worker", safe_label: "워커 대기" },
        { id: "call-row", kind: "used_tool", state: "delivered", bridge_phase: "btcc_operation",
          safe_tool_name: "delegate_to_worker", tool_call_id: "call", safe_label: "도구 사용",
          safe_detail_rows: [{ id: "receipt", kind: "detail", safe_label: "전달됨" }] }],
    }]} />));
    const capsule = container.querySelector('[data-test-class="worker-call-capsule"]')!;
    expect(capsule.querySelector("button")?.getAttribute("data-variant")).toBe("outline");
    expect(capsule.querySelector("button")?.getAttribute("data-shape")).toBe("pill");
    expect(capsule.querySelector('[data-surface="glass-pill"]')).toBeNull();
    const group = container.querySelector('[data-test-class="turn-work-tool-row turn-work-tool-group"]')!;
    const button = group.firstElementChild as HTMLButtonElement;
    expect(button.textContent).toBe("2 작업");
    expect(group.lastElementChild?.contains(capsule)).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("워커 호출");
    expect(capsule.textContent).toBe("Juno · 2/3 · 읽기: routes.ts");
    expect(container.textContent).not.toContain("Other");
    expect(container.querySelectorAll('[data-test-class="worker-call-capsule"]')).toHaveLength(1);
    await act(async () => button.click());
    const details = group.querySelector('[data-test-class="turn-activity-details turn-work-tool-detail-list"]')!;
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(details.textContent).toContain("워커 호출");
    expect(details.textContent).toContain("워커 대기");
    expect(details.textContent).not.toContain("Juno");
    expect(group.children[1]).toBe(details);
    expect(group.lastElementChild?.contains(capsule)).toBe(true);
    expect(container.querySelectorAll('[data-test-class="worker-call-capsule"]')).toHaveLength(1);
    await act(async () => button.click());
    expect(container.textContent).not.toContain("워커 호출");
    await act(async () => setWorker({ ...worker, current_activity_title: "수정: routes.ts" }));
    expect(capsule.textContent).toBe("Juno · 2/3 · 수정: routes.ts");
    await act(async () => setWorker({ ...worker, phase: "failed", status_line: "실패", terminal: true }));
    expect(capsule.textContent).toBe("Juno · 2/3 · 실패");
    await act(async () => setWorker({ ...worker, phase: "complete", status_line: "완료", terminal: true, approved_plan_completed: 3 }));
    expect(capsule.textContent).toBe("Juno · 3/3 · 완료");
    await act(async () => root.render(<WorkActivityToolGroup tools={[{
      id: "only-call", title: "워커 호출", summaryLabel: "작업",
      after: <WorkerCallCapsule turnId="turn" callId="call" />,
    }]} />));
    expect(container.textContent).toBe("1 작업Juno · 3/3 · 완료");
    await act(async () => (container.querySelector('button[aria-expanded="false"]') as HTMLButtonElement).click());
    expect(container.textContent).toContain("워커 호출");
  } finally {
    await act(async () => root.unmount());
    setAppCopyLanguage(previousLocale);
    useButlerStore.setState({ observerSessionId: before.observerSessionId, sessionViews: before.sessionViews });
    globals.forEach((key, i) => { const descriptor = saved[i]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
    dom.window.close();
  }
});
