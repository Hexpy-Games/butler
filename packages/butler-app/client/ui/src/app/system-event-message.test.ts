import { afterEach, expect, test } from "bun:test";
import { getAppCopy, setAppCopyLanguage } from "./copy.ts";
import { applyTimelineEventsToViewState } from "./utils.ts";
import { isCompactionMessage, visibleSystemMessageText } from "./system-event-message.ts";

afterEach(() => setAppCopyLanguage("en"));

test("compaction event text and styling follow locale after event ingestion", () => {
  setAppCopyLanguage("en");
  const view = applyTimelineEventsToViewState([
    { id: 1, type: "context.compaction.started", created_at: new Date(0).toISOString(), payload: { session_id: "general" } },
    { id: 2, type: "context.compaction.completed", created_at: new Date(1).toISOString(), payload: { session_id: "general" } },
  ], "general", { messages: [], summary: null, turnProgress: {} });
  const [started, completed] = view.messages;
  expect(isCompactionMessage(started)).toBe(true);
  expect(isCompactionMessage(completed)).toBe(true);
  expect(visibleSystemMessageText(started)).toBe(getAppCopy("en-US").interfaceFeedback.compacting);
  setAppCopyLanguage("ko");
  expect(visibleSystemMessageText(started)).toBe(getAppCopy("ko-KR").interfaceFeedback.compacting);
  expect(visibleSystemMessageText(completed)).toBe(getAppCopy("ko-KR").interfaceFeedback.compacted);
  const authored = { ...started, role: "assistant" as const, text: "Context automatically compacted" };
  expect(isCompactionMessage(authored)).toBe(false);
  expect(visibleSystemMessageText(authored)).toBe(authored.text);
  expect(isCompactionMessage({ ...started, system_event_kind: undefined })).toBe(false);
});
