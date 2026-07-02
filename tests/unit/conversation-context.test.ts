import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { conversationSessionIdForDurableSession } from "../../packages/butler-agent/src/agent/conversation/session-admission.ts";
import { readConversationContext } from "../../packages/butler-agent/src/agent/context/conversation-context.ts";

let tempDir = "";
let store: AgentConversationStore;
const runtimeSessionId = "butler/main";
const canonicalSessionId = conversationSessionIdForDurableSession(runtimeSessionId);

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-conversation-context-"));
  store = new AgentConversationStore({ butlerData: tempDir });
  store.beginTurn({
    gateway: "app",
    externalSessionId: runtimeSessionId,
    sessionId: canonicalSessionId,
    actor: "user",
    turnId: "turn-context-fixture",
    now: "2026-04-28T11:00:00.000Z",
  });
});

afterEach(() => {
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function appendConversation(kind: "inbound" | "outbound", text: string, sourceRef: string) {
  const input = {
    sessionId: canonicalSessionId,
    turnId: "turn-context-fixture",
    text,
    sourceGateway: "app",
    sourceRef,
    now: `2026-04-28T11:${sourceRef.slice(-2).padStart(2, "0")}:00.000Z`,
  };
  return kind === "inbound"
    ? store.appendUserMessage(input)
    : store.appendAssistantMessage(input);
}

test("readConversationContext returns bounded canonical message slices by query", () => {
  const first = appendConversation("inbound", "처음에 항목A는 2단계이고 항목B은 기본이라고 말했어요.", "evt-01");
  const second = appendConversation("outbound", "네, 항목A 2단계과 항목B 기본으로 기억하겠습니다.", "evt-02");
  const third = appendConversation("inbound", "다른 이야기로 넘어갈게요.", "evt-03");
  appendConversation("inbound", "위에서 항목A 몇 돌이라고 했지?", "evt-04");

  const result = readConversationContext({
    butlerData: tempDir,
    sessionId: runtimeSessionId,
    query: "항목A",
    limit: 3,
    maxChars: 1000,
  });

  expect(result).toMatchObject({
    ok: true,
    session_id: canonicalSessionId,
    runtime_session_id: runtimeSessionId,
    query: "항목A",
    returned: 3,
  });
  expect(result.messages.map((message) => message.conversation_message_id)).toEqual([
    first.id,
    second.id,
    third.id,
  ]);
  expect(result.messages.map((message) => message.speaker)).toEqual(["user", "butler", "user"]);
  expect(JSON.stringify(result)).toContain("항목A는 2단계");
  expect(JSON.stringify(result.messages)).not.toContain("source_ref");
  expect(JSON.stringify(result.messages)).not.toContain("evt-01");
});

test("readConversationContext supports canonical and legacy anchors", () => {
  appendConversation("inbound", "첫 번째 대화입니다.", "evt-10");
  const second = appendConversation("outbound", "첫 번째 답변입니다.", "evt-11");
  const third = appendConversation("inbound", "두 번째 대화입니다.", "evt-12");
  appendConversation("outbound", "두 번째 답변입니다.", "evt-13");

  const byEvent = readConversationContext({
    butlerData: tempDir,
    sessionId: runtimeSessionId,
    anchorEventId: "evt-12",
    direction: "before",
    limit: 2,
    maxChars: 1000,
  });
  const byMessage = readConversationContext({
    butlerData: tempDir,
    sessionId: runtimeSessionId,
    anchorMessageId: third.id,
    direction: "before",
    limit: 2,
    maxChars: 1000,
  });

  expect(byEvent.messages.map((message) => message.conversation_message_id)).toEqual([second.id, third.id]);
  expect(byMessage.messages.map((message) => message.conversation_message_id)).toEqual([second.id, third.id]);
  expect(byEvent.anchor_message_id).toBe(third.id);
  expect(byEvent.truncated).toBe(false);
});
