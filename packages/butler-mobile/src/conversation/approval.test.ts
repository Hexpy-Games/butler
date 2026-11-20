// test-category: pure-logic
import { expect, test } from "bun:test";
import { answerWire, normalizeApprovalCard } from "./approval";

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
