import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { MessageRecord } from "@/app/types.ts";
import { SessionObserverTimeline } from "./SessionObserverTimeline.tsx";

test("observer keeps message chronology without a second standalone Worker record", () => {
  const messages: MessageRecord[] = [{
    id: "reply", chat_id: "steward", turn_id: "calling-turn", role: "assistant",
    text: "Worker가 구현 중입니다.", status: "delivered", created_at: "2026-09-06T10:00:00Z",
  }, {
    id: "direction", chat_id: "steward", role: "user", text: "기존 디자인을 유지해주세요.",
    status: "delivered", created_at: "2026-09-06T10:01:00Z",
  }];
  const html = renderToStaticMarkup(
    <SessionObserverTimeline messages={[...messages].reverse()}>
      <div>현재 활동</div>
    </SessionObserverTimeline>,
  );
  expect(html.indexOf(messages[0]!.text)).toBeLessThan(html.indexOf(messages[1]!.text));
  expect(html.indexOf(messages[1]!.text)).toBeLessThan(html.indexOf("현재 활동"));
  expect(html).not.toContain("steward-observer-worker-message");
});

test("activity-only execution stays between earlier and later messages", () => {
  const html = renderToStaticMarkup(<SessionObserverTimeline messages={[
    { id: "first", chat_id: "s", role: "user", status: "delivered", text: "먼저 요청",
      created_at: "2026-09-06T10:00:00Z" },
    { id: "second", chat_id: "s", role: "user", status: "delivered", text: "추가 지시",
      created_at: "2026-09-06T10:02:00Z" },
  ]} activityHistory={[{ turn_id: "waiting-turn", created_at: "2026-09-06T10:01:00Z",
    rows: [{ id: "call", kind: "used_tool", state: "completed", safe_label: "Worker 호출",
      safe_tool_name: "delegate_to_worker", tool_call_id: "call",
      bridge_phase: "btcc_operation", semantic_block_id: "waiting-turn" }],
  }]} />);
  expect(html.indexOf("먼저 요청")).toBeLessThan(html.indexOf('data-turn-id="waiting-turn"'));
  expect(html.indexOf('data-turn-id="waiting-turn"')).toBeLessThan(html.indexOf("추가 지시"));
  expect(html).not.toContain("현재 작업");
});
