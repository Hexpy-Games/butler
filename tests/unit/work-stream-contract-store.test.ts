import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  BLOCKER_EVIDENCE_RECEIPT_SCHEMA,
  compileTurnContract,
  TURN_CONTRACT_DECISION_SCHEMA,
  TYPED_BLOCKER_SCHEMA,
  type CompiledTurnContract,
  TurnContractStore,
} from "../../packages/butler-agent/src/agent/turn/turn-contract.ts";
import { TodoListStore, type TodoItemInput } from "../../packages/butler-agent/src/agent/work/todo-list.ts";
import { WorkStreamClaimStore } from "../../packages/butler-agent/src/agent/work/work-stream-claim-store.ts";
import { WorkStreamPlanStore } from "../../packages/butler-agent/src/agent/work/work-stream-plan-store.ts";
import { commitWorkStreamMutation, withWorkStreamMutationAuthority } from "../../packages/butler-agent/src/agent/work/work-stream-mutation-authority.ts";
import { WorkStreamStore } from "../../packages/butler-agent/src/agent/work/work-stream.ts";

let data = "";
beforeEach(() => {
  data = join(tmpdir(), `butler-workstream-contract-${Date.now()}-${Math.random()}`);
  mkdirSync(data, { recursive: true });
});
afterEach(() => rmSync(data, { recursive: true, force: true }));

function item(id: string, status: TodoItemInput["status"]): TodoItemInput {
  return { id, content: id, active_form: `Doing ${id}`, status, phase: status === "completed" ? "planning" : "execution" };
}

function createStream(input: { withProvenance?: boolean; listId?: string } = {}) {
  const listId = input.listId ?? "work";
  const todos = new TodoListStore(data).update({ listId, items: [item("done", "completed"), item("next", "in_progress")] });
  return new WorkStreamStore(data).updateFromTodoList({
    ownerSessionId: "session-a",
    originChatId: input.withProvenance === false ? null : "chat-a",
    projectId: input.withProvenance === false ? null : "project-a",
    listId,
    items: todos.list.items,
  });
}

function contract(workstreamId: string, decisionId = "decision-resume", publicSummary = "Resume durable work."): CompiledTurnContract {
  return compileTurnContract({
    decision: {
      schema_version: TURN_CONTRACT_DECISION_SCHEMA,
      decision_id: decisionId,
      action: "resume_work",
      target_workstream_id: workstreamId,
      target_project_id: "project-a",
      deliverables: ["code_change"],
      public_summary: publicSummary,
    },
    candidates: { workstreams: [{
      workstream_id: workstreamId,
      state: "recoverable",
      unsatisfied_obligations: [{ deliverable: "code_change", target_kind: "workspace", target_id: "workspace-a", generation: 1 }],
    }] },
  });
}

function cancellationContract(workstreamId: string, decisionId = "decision-cancel"): CompiledTurnContract {
  return compileTurnContract({
    decision: {
      schema_version: TURN_CONTRACT_DECISION_SCHEMA,
      decision_id: decisionId,
      action: "cancel_work",
      target_workstream_id: workstreamId,
      target_project_id: "project-a",
      deliverables: [],
      public_summary: "Cancel durable work.",
    },
    candidates: { workstreams: [{ workstream_id: workstreamId, state: "executing", unsatisfied_obligations: [] }] },
  });
}

function claim(stream = createStream(), selectedContract = contract(stream.id), now = new Date("2026-07-10T00:00:00.000Z")) {
  return new WorkStreamClaimStore(data).claim({
    contract: selectedContract,
    workstreamId: stream.id,
    sessionId: "session-a",
    chatId: "chat-a",
    projectId: "project-a",
    turnId: "turn-a",
    expectedGeneration: stream.record_generation!,
    leaseMs: 1_000,
    now,
  });
}

test("claim requires complete provenance and mandatory CAS generation", () => {
  const missing = createStream({ withProvenance: false, listId: "missing" });
  expect(claim(missing, contract(missing.id))).toEqual({ ok: false, code: "workstream_provenance_missing" });
  const stream = createStream({ listId: "cas" });
  const selected = contract(stream.id);
  expect(new WorkStreamClaimStore(data).claim({
    contract: selected, workstreamId: stream.id, sessionId: "session-a", chatId: "chat-a", projectId: "project-a", turnId: "turn-a", expectedGeneration: 99,
  })).toEqual({ ok: false, code: "workstream_claim_generation_conflict" });
});

test("claim repairs a receipt after an interrupted write and renews by CAS", () => {
  const stream = createStream();
  const selected = contract(stream.id);
  expect(() => new WorkStreamClaimStore(data).claim({
    contract: selected,
    workstreamId: stream.id,
    sessionId: "session-a",
    chatId: "chat-a",
    projectId: "project-a",
    turnId: "turn-a",
    expectedGeneration: stream.record_generation!,
    faultAfterWorkStreamWrite: true,
  })).toThrow("injected_claim_failure");
  const persisted = new WorkStreamStore(data).read(stream.id)!;
  const replay = new WorkStreamClaimStore(data).claim({
    contract: selected,
    workstreamId: stream.id,
    sessionId: "session-a",
    chatId: "chat-a",
    projectId: "project-a",
    turnId: "turn-a",
    expectedGeneration: stream.record_generation!,
  });
  expect(replay).toMatchObject({ ok: true, replayed: true });
  const renewed = new WorkStreamClaimStore(data).renew({
    contractId: selected.contract_id,
    workstreamId: stream.id,
    expectedGeneration: persisted.record_generation!,
    turnId: "turn-a",
    now: new Date("2026-07-10T01:00:00.000Z"),
  });
  expect(renewed).toMatchObject({ ok: true, receipt: { operation: "renew", outcome: "renewed" } });
  if (!renewed.ok) return;
  const claimReplay = new WorkStreamClaimStore(data).claim({
    contract: selected,
    workstreamId: stream.id,
    sessionId: "session-a",
    chatId: "chat-a",
    projectId: "project-a",
    turnId: "turn-a",
    expectedGeneration: stream.record_generation!,
  });
  expect(claimReplay).toMatchObject({
    ok: true,
    replayed: true,
    receipt: { operation: "claim", receipt_id: replay.ok ? replay.receipt.receipt_id : "" },
    record: { original_claim_receipt_id: replay.ok ? replay.receipt.receipt_id : "", active_claim_receipt_id: renewed.receipt.receipt_id },
  });
});

test("public copy replay for one decision id does not duplicate claim side effects", () => {
  const stream = createStream({ listId: "public-copy-replay" });
  const firstContract = contract(stream.id, "public-copy-decision", "First public wording.");
  const copyChanged = contract(stream.id, "public-copy-decision", "Reworded public wording.");
  expect(copyChanged.contract_id).toBe(firstContract.contract_id);
  const claims = new WorkStreamClaimStore(data);
  const first = claims.claim({
    contract: firstContract,
    workstreamId: stream.id,
    sessionId: "session-a",
    chatId: "chat-a",
    projectId: "project-a",
    turnId: "turn-a",
    expectedGeneration: stream.record_generation!,
  });
  if (!first.ok) throw new Error("expected first claim");
  const replay = claims.claim({
    contract: copyChanged,
    workstreamId: stream.id,
    sessionId: "session-a",
    chatId: "chat-a",
    projectId: "project-a",
    turnId: "turn-a",
    expectedGeneration: stream.record_generation!,
  });
  expect(replay).toMatchObject({ ok: true, replayed: true, receipt: { receipt_id: first.receipt.receipt_id } });
  if (!replay.ok) throw new Error("expected replay");
  expect(replay.record.record_generation).toBe(first.record.record_generation);
});

test("expired active claim rebinds under serialized SQLite ownership", () => {
  const stream = createStream();
  const first = claim(stream);
  expect(first.ok).toBe(true);
  const current = new WorkStreamStore(data).read(stream.id)!;
  const secondContract = contract(stream.id, "decision-second");
  const reclaimed = new WorkStreamClaimStore(data).claim({
    contract: secondContract, workstreamId: stream.id, sessionId: "session-a", chatId: "chat-a", projectId: "project-a", turnId: "turn-b", expectedGeneration: current.record_generation!, now: new Date("2026-07-10T00:00:02.000Z"),
  });
  expect(reclaimed).toMatchObject({ ok: true, receipt: { outcome: "reclaimed" } });
  const after = new WorkStreamStore(data).read(stream.id)!;
  const renewed = new WorkStreamClaimStore(data).renew({ contractId: secondContract.contract_id, workstreamId: stream.id, expectedGeneration: after.record_generation!, turnId: "turn-b", now: new Date("2026-07-10T00:00:03.000Z") });
  expect(renewed).toMatchObject({ ok: true, receipt: { operation: "renew" } });
});

test("verified blockers gate waiting_user and only matching supply semantics resumes", () => {
  const stream = createStream();
  const selected = contract(stream.id);
  const claimed = claim(stream, selected);
  expect(claimed.ok).toBe(true);
  if (!claimed.ok) return;
  const blocker = {
    schema_version: TYPED_BLOCKER_SCHEMA,
    blocker_id: "blocker-1",
    owner: "user" as const,
    code: "authentication_required",
    evidence_ref: "blocker-evidence-1",
    requested_action: "Sign in through the visible provider page.",
  };
  const evidence = {
    schema_version: BLOCKER_EVIDENCE_RECEIPT_SCHEMA,
    receipt_id: blocker.evidence_ref,
    producer: "runtime" as const,
    contract_id: selected.contract_id,
    workstream_id: stream.id,
    blocker_id: blocker.blocker_id,
    owner: "user" as const,
    code: "authentication_required" as const,
    requested_action: blocker.requested_action,
    verified: true,
    created_at: new Date(0).toISOString(),
  };
  expect(() => new WorkStreamStore(data).transition({ id: stream.id, state: "waiting_user" }))
    .toThrow("WorkStreamClaimStore.waitForUser");
  expect(new WorkStreamClaimStore(data).waitForUser({ contract: selected, workstreamId: stream.id, expectedGeneration: claimed.record.record_generation!, turnId: "turn-a", blocker, blockerEvidenceReceipts: [] }))
    .toEqual({ ok: false, code: "workstream_user_blocker_unverified" });
  const waiting = new WorkStreamClaimStore(data).waitForUser({ contract: selected, workstreamId: stream.id, expectedGeneration: claimed.record.record_generation!, turnId: "turn-a", blocker, blockerEvidenceReceipts: [evidence] });
  expect(waiting).toMatchObject({
    ok: true,
    record: {
      state: "waiting_user",
      active_blocker_id: "blocker-1",
      original_claim_receipt_id: claimed.receipt.receipt_id,
    },
  });
  if (!waiting.ok) return;
  expect(waiting.record.active_claim_receipt_id).not.toBe(claimed.receipt.receipt_id);
  expect(new WorkStreamClaimStore(data).claim({ contract: selected, workstreamId: stream.id, sessionId: "session-a", chatId: "chat-a", projectId: "project-a", turnId: "turn-b", expectedGeneration: waiting.record.record_generation! }))
    .toEqual({ ok: false, code: "workstream_waiting_user_requires_supply" });
  const supply = compileTurnContract({
    decision: { schema_version: TURN_CONTRACT_DECISION_SCHEMA, decision_id: "decision-supply", action: "supply_user_action", target_workstream_id: stream.id, target_project_id: "project-a", blocker_id: "blocker-1", deliverables: [], public_summary: "Continue after authentication." },
    candidates: { workstreams: [{ workstream_id: stream.id, state: "waiting_user", waiting_user_blocker_id: "blocker-1", unsatisfied_obligations: selected.required_evidence }] },
  });
  expect(new WorkStreamClaimStore(data).supplyUserAction({ contract: supply, blockerId: "wrong", workstreamId: stream.id, sessionId: "session-a", chatId: "chat-a", projectId: "project-a", turnId: "turn-b", expectedGeneration: waiting.record.record_generation! }))
    .toEqual({ ok: false, code: "workstream_supply_action_mismatch" });
  expect(new WorkStreamClaimStore(data).supplyUserAction({ contract: { ...supply, target_workstream_id: "wrong-stream" }, blockerId: "blocker-1", workstreamId: stream.id, sessionId: "session-a", chatId: "chat-a", projectId: "project-a", turnId: "turn-b", expectedGeneration: waiting.record.record_generation! }))
    .toEqual({ ok: false, code: "workstream_contract_target_mismatch" });
  expect(new WorkStreamClaimStore(data).supplyUserAction({ contract: { ...supply, target_project_id: "wrong-project" }, blockerId: "blocker-1", workstreamId: stream.id, sessionId: "session-a", chatId: "chat-a", projectId: "project-a", turnId: "turn-b", expectedGeneration: waiting.record.record_generation! }))
    .toEqual({ ok: false, code: "workstream_contract_project_mismatch" });
  expect(new WorkStreamClaimStore(data).supplyUserAction({ contract: { ...supply, state: "delivered" }, blockerId: "blocker-1", workstreamId: stream.id, sessionId: "session-a", chatId: "chat-a", projectId: "project-a", turnId: "turn-b", expectedGeneration: waiting.record.record_generation! }))
    .toEqual({ ok: false, code: "workstream_contract_terminal" });
  expect(new WorkStreamClaimStore(data).supplyUserAction({ contract: supply, blockerId: "blocker-1", workstreamId: stream.id, sessionId: "session-a", chatId: "chat-a", projectId: "project-a", turnId: "turn-b", expectedGeneration: waiting.record.record_generation! }))
    .toMatchObject({ ok: true, record: { state: "executing", active_blocker_id: null, active_contract_id: supply.contract_id } });
});

test("blocker provenance precedes waiting visibility and restart auto-recovers supply", () => {
  const stream = createStream({ listId: "blocker-crash" });
  const selected = contract(stream.id, "blocker-crash-resume");
  const claimed = claim(stream, selected);
  if (!claimed.ok) throw new Error("expected claim");
  const blocker = {
    schema_version: TYPED_BLOCKER_SCHEMA,
    blocker_id: "blocker-crash",
    owner: "user" as const,
    code: "captcha_required" as const,
    evidence_ref: "blocker-crash-evidence",
    requested_action: "Complete the CAPTCHA in the visible browser.",
  };
  const evidence = {
    schema_version: BLOCKER_EVIDENCE_RECEIPT_SCHEMA,
    receipt_id: blocker.evidence_ref,
    producer: "runtime" as const,
    contract_id: selected.contract_id,
    workstream_id: stream.id,
    blocker_id: blocker.blocker_id,
    owner: "user" as const,
    code: blocker.code,
    requested_action: blocker.requested_action,
    verified: true,
    created_at: new Date(0).toISOString(),
  };
  const interrupted = new WorkStreamClaimStore(data).waitForUser({
    contract: selected,
    workstreamId: stream.id,
    expectedGeneration: claimed.record.record_generation!,
    turnId: "turn-a",
    blocker,
    blockerEvidenceReceipts: [evidence],
    faultAt: "after_artifacts_write",
  });
  expect(interrupted).toEqual({ ok: false, code: "workstream_blocker_persistence_interrupted" });
  const rawBeforeRestart = JSON.parse(readFileSync(join(data, "work-streams", `${stream.id}.json`), "utf8"));
  expect(rawBeforeRestart.state).toBe("executing");
  const receiptFiles = join(data, "workstream-claim-receipts");
  const waitReceipt = readdirSync(receiptFiles)
    .map((file) => JSON.parse(readFileSync(join(receiptFiles, file), "utf8")))
    .find((receipt) => receipt.operation === "wait_user");
  expect(waitReceipt).toMatchObject({ blocker_id: blocker.blocker_id, contract_id: selected.contract_id });
  const restarted = new WorkStreamClaimStore(data);
  const waiting = new WorkStreamStore(data).read(stream.id)!;
  expect(waiting).toMatchObject({ state: "waiting_user", active_blocker_evidence_id: evidence.receipt_id });
  const supply = compileTurnContract({
    decision: { schema_version: TURN_CONTRACT_DECISION_SCHEMA, decision_id: "supply-after-blocker-recovery", action: "supply_user_action", target_workstream_id: stream.id, target_project_id: "project-a", blocker_id: blocker.blocker_id, deliverables: [], public_summary: "Continue after CAPTCHA." },
    candidates: { workstreams: [{ workstream_id: stream.id, state: "waiting_user", waiting_user_blocker_id: blocker.blocker_id, unsatisfied_obligations: selected.required_evidence }] },
  });
  expect(restarted.supplyUserAction({ contract: supply, blockerId: blocker.blocker_id, workstreamId: stream.id, sessionId: "session-a", chatId: "chat-a", projectId: "project-a", turnId: "turn-b", expectedGeneration: waiting.record_generation! }))
    .toMatchObject({ ok: true, record: { state: "executing", active_contract_id: supply.contract_id } });
});

test("claim and supply reject wrong targets, projects, and terminal contracts", () => {
  const stream = createStream();
  const selected = contract(stream.id);
  const claims = new WorkStreamClaimStore(data);
  const base = { workstreamId: stream.id, sessionId: "session-a", chatId: "chat-a", projectId: "project-a", turnId: "turn-a", expectedGeneration: stream.record_generation! };
  expect(claims.claim({ ...base, contract: { ...selected, target_workstream_id: "ws-wrong" } }))
    .toEqual({ ok: false, code: "workstream_contract_target_mismatch" });
  expect(claims.claim({ ...base, contract: { ...selected, target_project_id: "project-wrong" } }))
    .toEqual({ ok: false, code: "workstream_contract_project_mismatch" });
  expect(claims.claim({ ...base, contract: { ...selected, state: "delivered" } }))
    .toEqual({ ok: false, code: "workstream_contract_terminal" });
});

test("late cancellation never rewrites complete, failed, or cancelled terminals", () => {
  const stream = createStream();
  const selected = contract(stream.id);
  const claimed = claim(stream, selected);
  expect(claimed.ok).toBe(true);
  if (!claimed.ok) return;
  new WorkStreamStore(data).applyTurnLocalOutcome({ sessionId: "session-a", turnId: "turn-a", outcome: "completed" });
  const complete = new WorkStreamStore(data).read(stream.id)!;
  const result = new WorkStreamClaimStore(data).cancel({ contract: cancellationContract(stream.id), workstreamId: stream.id, expectedGeneration: complete.record_generation!, turnId: "turn-a" });
  expect(result).toEqual({ ok: false, code: "workstream_terminal_complete" });
  expect(new WorkStreamStore(data).read(stream.id)?.state).toBe("complete");

  const failedStream = createStream({ listId: "failed-terminal" });
  const failedClaim = claim(failedStream, contract(failedStream.id, "decision-failed"));
  if (!failedClaim.ok) throw new Error("expected failed stream claim");
  new WorkStreamStore(data).applyTurnLocalOutcome({ sessionId: "session-a", turnId: "turn-a", outcome: "failed" });
  const failed = new WorkStreamStore(data).read(failedStream.id)!;
  expect(new WorkStreamClaimStore(data).cancel({ contract: cancellationContract(failed.id, "cancel-failed"), workstreamId: failed.id, expectedGeneration: failed.record_generation!, turnId: "turn-a" }))
    .toEqual({ ok: false, code: "workstream_terminal_failed" });

  const cancelledStream = createStream({ listId: "cancelled-terminal" });
  const cancelledClaim = claim(cancelledStream, contract(cancelledStream.id, "decision-cancelled"));
  if (!cancelledClaim.ok) throw new Error("expected cancelled stream claim");
  const firstCancel = cancellationContract(cancelledStream.id, "cancel-first");
  const cancelled = new WorkStreamClaimStore(data).cancel({ contract: firstCancel, workstreamId: cancelledStream.id, expectedGeneration: cancelledClaim.record.record_generation!, turnId: "turn-a" });
  if (!cancelled.ok) throw new Error("expected cancellation");
  expect(new WorkStreamClaimStore(data).cancel({ contract: cancellationContract(cancelledStream.id, "cancel-late"), workstreamId: cancelledStream.id, expectedGeneration: cancelled.record.record_generation!, turnId: "turn-late" }))
    .toEqual({ ok: false, code: "workstream_terminal_cancelled" });
});

test("cancellation receipt survives an interrupted release and replay finishes atomically", () => {
  const stream = createStream();
  const selected = contract(stream.id);
  const claimed = claim(stream, selected);
  expect(claimed.ok).toBe(true);
  if (!claimed.ok) return;
  const claims = new WorkStreamClaimStore(data);
  const cancellation = cancellationContract(stream.id);
  expect(() => claims.cancel({
    contract: cancellation,
    workstreamId: stream.id,
    expectedGeneration: claimed.record.record_generation!,
    turnId: "turn-a",
    faultAfterReceiptWrite: true,
  })).toThrow("injected_cancellation_failure");
  expect(new WorkStreamStore(data).read(stream.id)).toMatchObject({
    state: "executing",
    active_contract_id: selected.contract_id,
  });
  const replay = claims.cancel({
    contract: cancellation,
    workstreamId: stream.id,
    expectedGeneration: claimed.record.record_generation!,
    turnId: "turn-a",
  });
  expect(replay).toMatchObject({ ok: true, record: { state: "cancelled", active_contract_id: null }, receipt: { operation: "cancel" } });
});

test("cancel_work requires a durable cancellation receipt before terminal contract delivery", () => {
  const stream = createStream({ listId: "durable-cancel" });
  const selected = contract(stream.id, "resume-durable-cancel");
  const claimed = claim(stream, selected);
  if (!claimed.ok) throw new Error("expected claim");
  const cancellation = cancellationContract(stream.id, "cancel-durable");
  const contracts = new TurnContractStore(data);
  contracts.create(cancellation);
  expect(() => contracts.recordTerminalDelivery({ contractId: cancellation.contract_id, terminalState: "cancelled", expectedGeneration: cancellation.generation }))
    .toThrow("turn_contract_cancellation_receipt_required");
  const released = new WorkStreamClaimStore(data).cancel({ contract: cancellation, workstreamId: stream.id, expectedGeneration: claimed.record.record_generation!, turnId: "turn-cancel" });
  if (!released.ok) throw new Error("expected cancellation");
  const receipted = contracts.recordCancellationReceipt({
    contractId: cancellation.contract_id,
    receiptId: released.receipt.receipt_id,
    expectedGeneration: cancellation.generation,
  });
  const terminal = contracts.recordTerminalDelivery({ contractId: cancellation.contract_id, terminalState: "cancelled", expectedGeneration: receipted.generation });
  expect(terminal.contract).toMatchObject({ state: "cancelled", cancellation_receipt_id: released.receipt.receipt_id });
  expect(() => contracts.recordTerminalDelivery({ contractId: cancellation.contract_id, terminalState: "failed_system", expectedGeneration: terminal.contract.generation }))
    .toThrow("turn_contract_terminal_immutable");
});

test("fresh stores auto-recover after_todo_write without exposing a mixed revision", () => {
  const stream = createStream();
  const selected = contract(stream.id);
  const claimed = claim(stream, selected);
  expect(claimed.ok).toBe(true);
  if (!claimed.ok) return;
  const completedBefore = new TodoListStore(data).read("work")!.items[0]!;
  const plans = new WorkStreamPlanStore(data);
  const interrupted = plans.amend({
    workstreamId: stream.id,
    contractId: selected.contract_id,
    expectedGeneration: claimed.record.record_generation!,
    items: [item("done", "completed"), item("replacement", "in_progress")],
    faultAt: "after_todo_write",
  });
  expect(interrupted).toMatchObject({ ok: false, code: "workstream_plan_amendment_interrupted" });
  if (interrupted.ok || !interrupted.transactionId) throw new Error("expected interrupted amendment transaction");
  const recoveredTodo = new TodoListStore(data).read("work")!;
  const recovered = new WorkStreamStore(data).read(stream.id)!;
  expect(recovered).toMatchObject({ plan_revision: 2, active_contract_id: selected.contract_id, superseded_todo_ids: ["next"] });
  expect(recoveredTodo.items[0]).toEqual(completedBefore);
  const receiptPath = join(data, "workstream-plan-amendment-receipts", `${recovered.plan_revision_receipt_id}.json`);
  expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({ revision: 2, parent_revision: 1, preserved_completed_item_ids: ["done"] });
});

for (const faultAt of ["after_prepare", "after_workstream_write"] as const) {
  test(`plan amendment recovery handles ${faultAt}`, () => {
    const stream = createStream({ listId: faultAt });
    const selected = contract(stream.id, `decision-${faultAt}`);
    const claimed = claim(stream, selected);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const interrupted = new WorkStreamPlanStore(data).amend({
      workstreamId: stream.id,
      contractId: selected.contract_id,
      expectedGeneration: claimed.record.record_generation!,
      items: [item("done", "completed"), item(`replacement-${faultAt}`, "in_progress")],
      faultAt,
    });
    expect(interrupted).toMatchObject({ ok: false, code: "workstream_plan_amendment_interrupted" });
    if (interrupted.ok || !interrupted.transactionId) throw new Error("expected interrupted amendment transaction");
    expect(new WorkStreamStore(data).read(stream.id)).toMatchObject({
      active_contract_id: selected.contract_id,
      plan_revision: 2,
    });
  });
}

test("after_prepare amendment recovery never rolls forward over cancellation", () => {
  const stream = createStream({ listId: "amend-cancel-race" });
  const selected = contract(stream.id, "amend-cancel-resume");
  const claimed = claim(stream, selected);
  if (!claimed.ok) throw new Error("expected claim");
  const cancellations = new WorkStreamClaimStore(data);
  const interrupted = new WorkStreamPlanStore(data).amend({
    workstreamId: stream.id,
    contractId: selected.contract_id,
    expectedGeneration: claimed.record.record_generation!,
    items: [item("done", "completed"), item("replacement", "in_progress")],
    faultAt: "after_prepare",
  });
  if (interrupted.ok || !interrupted.transactionId) throw new Error("expected prepared amendment");
  const cancellation = cancellationContract(stream.id, "amend-cancel-decision");
  const cancelled = cancellations.cancel({
    contract: cancellation,
    workstreamId: stream.id,
    expectedGeneration: claimed.record.record_generation!,
    turnId: "turn-cancel",
  });
  expect(cancelled).toMatchObject({ ok: true, record: { state: "cancelled" } });
  expect(new WorkStreamStore(data).read(stream.id)).toMatchObject({ state: "cancelled", plan_revision: 1 });
  expect(JSON.parse(readFileSync(join(data, "workstream-plan-transactions", `${interrupted.transactionId}.json`), "utf8"))).toMatchObject({ state: "conflict" });
  expect(new TodoListStore(data).read("amend-cancel-race")?.items.map((todo) => todo.id)).toEqual(["done", "next"]);
});

test("claim after a stale read is preserved by locked legacy derivation", () => {
  const stream = createStream({ listId: "legacy-live-claim" });
  const stale = { ...stream, state: "recoverable" as const, record_generation: (stream.record_generation ?? 1) + 1 };
  const selected = contract(stream.id, "legacy-live-resume");
  const claimed = claim(stream, selected);
  if (!claimed.ok) throw new Error("expected claim");
  expect(() => withWorkStreamMutationAuthority({
    butlerData: data,
    workstreamId: stream.id,
    operation: "legacy_transition",
    ownerId: "stale-legacy-writer",
    action: (context) => commitWorkStreamMutation({ butlerData: data, context, record: stale, expectedGeneration: stream.record_generation! }),
  })).toThrow("workstream_mutation_generation_conflict");
  const updated = new WorkStreamStore(data).updateFromTodoList({
    id: stream.id,
    ownerSessionId: "session-a",
    originChatId: "chat-a",
    projectId: "project-a",
    listId: "legacy-live-claim",
    items: new TodoListStore(data).read("legacy-live-claim")!.items,
  });
  expect(updated).toMatchObject({ active_contract_id: selected.contract_id, active_claim_receipt_id: claimed.receipt.receipt_id });
  expect(updated.record_generation).toBe((claimed.record.record_generation ?? 1) + 1);
  expect(() => withWorkStreamMutationAuthority({
    butlerData: data,
    workstreamId: stream.id,
    operation: "legacy_link",
    ownerId: "unauthorized-tuple-writer",
    action: (context) => commitWorkStreamMutation({
      butlerData: data,
      context,
      record: { ...updated, active_claim_receipt_id: "forged", record_generation: (updated.record_generation ?? 1) + 1 },
      expectedGeneration: updated.record_generation!,
    }),
  })).toThrow("workstream_claim_tuple_authorization_required");
});
