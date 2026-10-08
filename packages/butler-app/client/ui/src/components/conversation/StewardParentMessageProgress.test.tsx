/// <reference types="bun" />

import { getAppLocale, setAppCopyLanguage } from "@/app/copy.ts";
import {
    HARNESS_MESSAGES,
    HARNESS_SS03_SUMMARY,
} from "@/app/fixtures.ts";
import type { MessageRecord, SessionSummaryView } from "@/app/types.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { anchoredStewardProgressByMessageId } from "./stewardParentProgressProjection";
import { stewardProgressStatus } from "./stewardProgressPresentation";

// These expectations are the default (English) copy; pin the locale instead of inheriting it.
const previousLocale = getAppLocale();
beforeAll(() => setAppCopyLanguage("en-US"));
afterAll(() => setAppCopyLanguage(previousLocale));
// test-category: pure-logic
// test-category: pure-logic
test("a terminal child reads as done even when its status is a raw result status", () => {
  const child = structuredClone(HARNESS_SS03_SUMMARY.steward_children![0]!);
  child.terminal = true;
  child.result = { ...(child.result ?? {}), status: "success" } as typeof child.result;
  for (const [status, expected] of [
    ["completed", "Completed"],
    ["blocked", "Failed"],
    ["active", "Completed"],
  ] as const) {
    (child as { status: string }).status = status;
    expect(stewardProgressStatus(child)).toContain(expected);
  }
  child.result = { ...child.result!, status: "blocked" };
  (child as { status: string }).status = "active";
  expect(stewardProgressStatus(child)).toContain("Failed");
});
test("two active Stewards attach to their own Butler messages", () => {
  const messages: MessageRecord[] = [
    ...HARNESS_MESSAGES,
    {
      id: "m5",
      chat_id: "butler-client",
      role: "user",
      text: "두 번째 조사를 진행해줘.",
      status: "sent",
      turn_id: "turn-3",
      cursor: 5,
      created_at: "2026-05-01T00:10:12.000Z",
      updated_at: "2026-05-01T00:10:12.000Z",
    },
    {
      id: "m6",
      chat_id: "butler-client",
      role: "assistant",
      text: "두 번째 Steward 조사도 시작했습니다.",
      status: "sent",
      turn_id: "turn-3",
      cursor: 6,
      created_at: "2026-05-01T00:10:42.000Z",
      updated_at: "2026-05-01T00:10:42.000Z",
    },
  ];
  const summary = structuredClone(HARNESS_SS03_SUMMARY) as SessionSummaryView;
  const first = summary.steward_children![0]!;
  summary.steward_children = [
    first,
    {
      ...first,
      session_id: "harness-steward-2",
      title: "Second bounded inspection",
      relation: {
        ...first.relation,
        relation_id: "harness-relation-2",
        parent_turn_id: "turn-3",
        child_session_id: "harness-steward-2",
        anchor_message_id: "m5",
        ordinal: 2,
      },
      active_turn: {
        ...first.active_turn!,
        id: "harness-steward-turn-2",
      },
    },
  ];

  const progress = anchoredStewardProgressByMessageId(messages, summary);
  expect([...progress.keys()]).toEqual(["m4", "m6"]);
  expect(progress.get("m4")?.child.session_id).toBe("harness-steward");
  expect(progress.get("m6")?.child.session_id).toBe("harness-steward-2");
});

test("missing, mismatched, and duplicate relation anchors fail closed", () => {
  const mismatched = structuredClone(HARNESS_SS03_SUMMARY) as SessionSummaryView;
  mismatched.steward_children![0]!.relation = {
    ...mismatched.steward_children![0]!.relation,
    anchor_message_id: "not-the-originating-message",
  };
  expect(
    anchoredStewardProgressByMessageId(HARNESS_MESSAGES, mismatched),
  ).toHaveLength(0);

  const mismatchedChat = structuredClone(HARNESS_SS03_SUMMARY) as SessionSummaryView;
  const anchor = HARNESS_MESSAGES.find((message) => message.id === "m3")!;
  const messagesWithMismatchedChat = HARNESS_MESSAGES.map((message) =>
    message === anchor ? { ...message, chat_id: "another-session" } : message,
  );
  expect(
    anchoredStewardProgressByMessageId(messagesWithMismatchedChat, mismatchedChat),
  ).toHaveLength(0);

  const mismatchedParentTurn = structuredClone(HARNESS_SS03_SUMMARY) as SessionSummaryView;
  mismatchedParentTurn.steward_children![0]!.relation = {
    ...mismatchedParentTurn.steward_children![0]!.relation,
    parent_turn_id: "not-the-parent-turn",
  };
  expect(
    anchoredStewardProgressByMessageId(HARNESS_MESSAGES, mismatchedParentTurn),
  ).toHaveLength(0);

  const duplicate = structuredClone(HARNESS_SS03_SUMMARY) as SessionSummaryView;
  const child = duplicate.steward_children![0]!;
  duplicate.steward_children = [
    child,
    {
      ...child,
      session_id: "harness-steward-2",
      relation: {
        ...child.relation,
        child_session_id: "harness-steward-2",
      },
    },
  ];
  expect(
    anchoredStewardProgressByMessageId(HARNESS_MESSAGES, duplicate),
  ).toHaveLength(0);
});
