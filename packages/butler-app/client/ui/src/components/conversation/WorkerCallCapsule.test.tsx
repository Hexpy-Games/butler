import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useButlerStore } from "@/app/store.ts";
import type { SessionView, WorkerActivitySummary } from "@/app/types.ts";
import { TurnActivityTimeline } from "./TurnActivityTimeline";

test("Worker call owns its live capsule below the button, including terminal history", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const before = useButlerStore.getState();
  const globals = ["window", "document", "navigator", "HTMLElement", "Node", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const saved = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
  const worker: WorkerActivitySummary = { worker_id: "worker", worker_display_name: "Juno", worker_label: "Worker",
    parent_turn_id: "turn", source_tool_call_id: "call", phase: "executing", status_line: "작업 중",
    objective: "Implement", terminal: false, supported_controls: [], approved_plan_total: 3, approved_plan_completed: 1 };
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
      operations: [{ id: "read", kind: "used_tool", state: "delivered", bridge_phase: "btcc_operation", safe_tool_name: "read_file", safe_label: "파일 읽기" },
        { id: "call-row", kind: "used_tool", state: "delivered", bridge_phase: "btcc_operation",
          safe_tool_name: "delegate_to_worker", tool_call_id: "call", safe_label: "도구 사용",
          safe_detail_rows: [{ id: "receipt", kind: "detail", safe_label: "전달됨" }] }],
    }]} />));
    const capsule = container.querySelector('[data-test-class="worker-call-capsule"]')!;
    const invocation = capsule.parentElement!;
    expect(invocation.firstElementChild?.textContent).toBe("워커 호출");
    expect(invocation.children[1]).toBe(capsule);
    expect(invocation.firstElementChild?.getAttribute("aria-expanded")).toBe("false");
    expect(capsule.textContent).toBe("Juno · 작업 중 · 2/3");
    expect(container.textContent).not.toContain("Other");
    expect(container.textContent).not.toContain("2 작업");
    expect(container.querySelectorAll('[data-test-class="worker-call-capsule"]')).toHaveLength(1);
    await act(async () => setWorker({ ...worker, phase: "failed", status_line: "실패", terminal: true }));
    expect(capsule.textContent).toBe("Juno · 실패 · 2/3");
    await act(async () => setWorker({ ...worker, phase: "complete", status_line: "완료", terminal: true, approved_plan_completed: 3 }));
    expect(capsule.textContent).toBe("Juno · 완료 · 3/3");
  } finally {
    await act(async () => root.unmount());
    useButlerStore.setState({ observerSessionId: before.observerSessionId, sessionViews: before.sessionViews });
    globals.forEach((key, i) => { const descriptor = saved[i]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
    dom.window.close();
  }
});
