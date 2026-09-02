import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { MessageRecord, WorkerActivitySummary } from "@/app/types.ts";
import { SessionObserverTimeline } from "./SessionObserverTimeline.tsx";

test("a Worker follows current activity, then its calling reply, regardless of launch time", () => {
  const worker: WorkerActivitySummary = {
    worker_id: "worker-1", parent_turn_id: "calling-turn", activity_kind: "worker",
    worker_label: "Worker", worker_display_name: "Rowan", objective: "Implement",
    phase: "executing", status_line: "Working", terminal: false, supported_controls: [],
    created_at: "2026-09-02T10:00:00.000Z",
  };
  const messages: MessageRecord[] = [{
    id: "reply", chat_id: "steward", turn_id: "calling-turn", role: "assistant",
    text: "The Worker is implementing the change.", status: "delivered",
    created_at: "2026-09-02T10:00:30.000Z",
  }, {
    id: "direction", chat_id: "steward", role: "user", text: "Keep the current design.",
    status: "delivered", created_at: "2026-09-02T10:01:00.000Z",
  }];
  const pending = renderToStaticMarkup(
    <SessionObserverTimeline messages={[]} workers={[worker]}>
      <div>Current activity</div>
    </SessionObserverTimeline>,
  );
  expect(pending.indexOf("Current activity")).toBeLessThan(pending.indexOf("Rowan"));
  for (const status of [{ terminal: false, phase: "executing" }, { terminal: true, phase: "complete" }]) {
    const html = renderToStaticMarkup(
      <SessionObserverTimeline messages={messages} workers={[{ ...worker, ...status }]} />,
    );
    expect(html.indexOf(messages[0]!.text)).toBeLessThan(html.indexOf("Rowan"));
    expect(html.indexOf("Rowan")).toBeLessThan(html.indexOf(messages[1]!.text));
    expect(html.match(/data-test-class="steward-observer-worker-message"/gu)).toHaveLength(1);
  }
});
