import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  appendTranscriptEvent,
  createTranscriptEvent,
} from "../../packages/butler-agent/src/test-support/harness/transcripts.ts";
import { readConversationContext } from "../../packages/butler-agent/src/agent/context/conversation-context.ts";

let tempDir = "";
let originalButlerData: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-conversation-context-"));
  originalButlerData = process.env.BUTLER_DATA;
  process.env.BUTLER_DATA = tempDir;
});

afterEach(() => {
  if (originalButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = originalButlerData;
  rmSync(tempDir, { recursive: true, force: true });
});

function appendConversation(kind: "inbound" | "outbound", text: string, eventId: string): void {
  appendTranscriptEvent(createTranscriptEvent({
    sessionId: "butler/main",
    kind,
    eventId,
    timestamp: `2026-04-28T11:${eventId.slice(-2).padStart(2, "0")}:00.000Z`,
    payload: {
      message: { text },
    },
  }));
}

test("readConversationContext returns bounded local transcript slices by query", () => {
  appendConversation("inbound", "처음에 항목A는 2단계이고 항목B은 기본이라고 말했어요.", "evt-01");
  appendConversation("outbound", "네, 항목A 2단계과 항목B 기본으로 기억하겠습니다.", "evt-02");
  appendConversation("inbound", "다른 이야기로 넘어갈게요.", "evt-03");
  appendTranscriptEvent(createTranscriptEvent({
    sessionId: "butler/main",
    kind: "tool_result",
    eventId: "evt-tool",
    payload: {
      name: "web_search",
      ok: true,
      result: { raw: "tool output must not be exposed" },
    },
  }));
  appendConversation("inbound", "위에서 항목A 몇 돌이라고 했지?", "evt-04");

  const result = readConversationContext({
    sessionId: "butler/main",
    query: "항목A",
    limit: 3,
    maxChars: 1000,
  });

  expect(result).toMatchObject({
    ok: true,
    session_id: "butler/main",
    query: "항목A",
    returned: 3,
  });
  expect(result.events.every((event) => event.kind === "inbound" || event.kind === "outbound")).toBe(true);
  expect(result.events.map((event) => event.event_id)).toEqual(["evt-01", "evt-02", "evt-03"]);
  expect(JSON.stringify(result)).toContain("항목A는 2단계");
  expect(JSON.stringify(result)).not.toContain("tool output must not be exposed");
});

test("readConversationContext supports anchor direction and character budget", () => {
  appendConversation("inbound", "첫 번째 대화입니다.", "evt-10");
  appendConversation("outbound", "첫 번째 답변입니다.", "evt-11");
  appendConversation("inbound", "두 번째 대화입니다.", "evt-12");
  appendConversation("outbound", "두 번째 답변입니다.", "evt-13");

  const result = readConversationContext({
    sessionId: "butler/main",
    anchorEventId: "evt-12",
    direction: "before",
    limit: 2,
    maxChars: 200,
  });

  expect(result.events.map((event) => event.event_id)).toEqual(["evt-11", "evt-12"]);
  expect(result.truncated).toBe(false);
});
