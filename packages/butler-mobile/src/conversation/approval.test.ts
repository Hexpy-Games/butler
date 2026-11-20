// test-category: pure-logic
import { expect, test } from "bun:test";
import type { AnsweredUserQuestions, ConversationMessage } from "../../../butler-protocol/src/index.ts";
import { answerWire, normalizeApprovalCard, withQuestionAnswers } from "./approval";

test("normalizeApprovalCard rejects invalid records and maps a command approval", () => {
  const record = { request_ref: "request", category: "command", reason: "Run the command", executable: "echo", command_count: 1,
    approval: { action_kind: "run_command", targets: [], count: 1, examples: [] } };
  expect(normalizeApprovalCard({ ...record, category: "ask_user" })).toBeNull();
  expect(normalizeApprovalCard({ ...record, reason: "" })).toBeNull();
  expect(normalizeApprovalCard(record)).toMatchObject({ requestRef: "request", category: "command", approval: { actionKind: "run_command" } });
});

test("answerWire maps a single-choice pick and a text answer", () => {
  expect(answerWire([
    { id: "choice", eyebrow: "Choice", title: "Choose", kind: "single", allow_custom: false, options: [{ id: "first", label: "First" }] },
    { id: "text", eyebrow: "Text", title: "Answer", kind: "text", allow_custom: false, options: [] },
  ], [
    { id: "choice", selected: [0], text: "", other: "", skipped: false },
    { id: "text", selected: [], text: "Details", other: "", skipped: false },
  ])).toEqual([
    { id: "choice", selected: ["first"], custom: null, skipped: false },
    { id: "text", selected: [], custom: "Details", skipped: false },
  ]);
});

test("withQuestionAnswers places the answer after the asking message and before the continuation", () => {
  const user: ConversationMessage = { id: "user", turn_id: "t1", role: "user", text: "Question" };
  const asking: ConversationMessage = { id: "asking", turn_id: "t1", role: "assistant", text: "" };
  const continuation: ConversationMessage = { id: "continuation", turn_id: "t1", role: "assistant", text: "Got it" };
  const answer: AnsweredUserQuestions = { request_ref: "answer", source_turn_id: "t1", followup_message_id: "client-id",
    updated_at: "2026-11-20T00:00:00Z", questions: { questions: [] }, response: { status: "answered", answers: [] } };
  expect(withQuestionAnswers([user, asking, continuation], [answer], message => message.role === "user"
    || (message.role === "assistant" && (message.text !== "" || !!message.answer_blocks?.length))))
    .toEqual([user, { id: answer.request_ref, questionAnswer: answer }, continuation]);
});
