import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { SqliteWorkLedgerStorage } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/work-ledger/index.ts";
import { discoverContinuationCandidates } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/continuation-candidate-discovery.ts";
import { openingAnswerCodec } from
  "../../packages/butler-agent/src/agent/btcc/conception/opening/opening-answer-codec.ts";
import { decideTransition } from
  "../../packages/butler-agent/src/agent/btcc/turn/state-machine/decide-transition.ts";
import type { TurnRecord } from
  "../../packages/butler-agent/src/agent/btcc/turn/contracts.ts";
import {
  bindAndContinue,
  freshContinuationCommand,
  seedStoppedProgram,
  taskStatuses,
} from "./support/btcc-stopped-work-fixture.ts";
import { canonicalMutationId } from "./support/btcc-project-ledger-fixture.ts";

test("Stop reloads a typed frontier and a fresh Turn continues only unfinished Tasks", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-stopped-program-"));
  const dbPath = join(root, "btcc.sqlite");
  try {
    let db = new Database(dbPath);
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    seedStoppedProgram(db);
    expect(taskStatuses(db)).toEqual(["accepted", "accepted", "selected", "planned"]);
    expect(terminalWakeRows(db)).toEqual([
      { turn_id: "turn-user-stopped", semantic_state: "cancelled" },
    ]);
    db.close();

    db = new Database(dbPath);
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    const storage = new SqliteWorkLedgerStorage(db);
    const candidates = await discoverContinuationCandidates(db, freshContinuationCommand());
    expect(candidates).toHaveLength(1);
    const continuation = candidates[0]!;
    expect(continuation.continuationKind).toBe("user_stopped");
    expect(continuation.sourceTurnId).toBe("turn-user-stopped");
    expect(continuation.context?.frontier.completedTasks?.map((item) =>
      item.task.taskLogicalId)).toEqual(["task-a", "task-b"]);
    expect(continuation.context?.frontier.interruptedTask?.task.taskLogicalId)
      .toBe("task-c");
    expect(continuation.context?.frontier.pendingTasks?.map((item) =>
      item.task.taskLogicalId)).toEqual(["task-d"]);

    bindAndContinue(storage, continuation);

    expect(taskStatuses(db)).toEqual(["accepted", "accepted", "planned", "planned"]);
    expect(await discoverContinuationCandidates(db, freshContinuationCommand())).toEqual([]);
    expect(stoppedCandidateStatus(db)).toBe("bound");
    expect(oldTurnState(db)).toBe("cancelled");
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancel_work consumes only the exact candidate and preserves accepted Tasks", async () => {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const storage = seedStoppedProgram(db);
  const candidates = await discoverContinuationCandidates(db, freshContinuationCommand());
  const candidate = candidates[0]!;
  const envelope = {
    binding: { turnId: "turn-cancel-work" },
    context: {
      originalMessageId: "message-cancel-work",
      continuationCandidates: candidates,
    },
  } as never;
  expect(() => openingAnswerCodec.decode({
    kind: "cancel_work",
    continuationCandidateId: "unrelated-candidate",
    reason: "Cancel it",
  }, envelope)).toThrow("unavailable Program");
  const product = openingAnswerCodec.decode({
    kind: "cancel_work",
    continuationCandidateId: candidate.candidateId,
    reason: "Abandon this exact Program",
  }, envelope);
  if (product.kind !== "opening_work_cancellation") {
    throw new Error("Opening cancellation product expected");
  }
  const turn = {
    turnId: "turn-cancel-work",
    sessionId: "session-fixture",
    revision: 0,
    semanticState: "conception_opening",
    continuationCandidates: candidates,
  } as TurnRecord;
  const decision = decideTransition(turn, { kind: "WorkCancellationAccepted", product });
  if (decision.kind !== "accepted" ||
    decision.transition.kind !== "accept_work_cancellation") {
    throw new Error("Work cancellation transition expected");
  }
  const forged = structuredClone(decision.transition.ledgerCommit);
  if (forged.mutation.kind !== "cancel_program") throw new Error("Cancellation expected");
  forged.mutation.continuationCandidateId = "another-candidate";
  const current = storage.loadProgram("program-session");
  if (!current) throw new Error("Program expected");
  forged.mutationId = canonicalMutationId(forged, current);
  expect(() => storage.commit(forged)).toThrow("cancellation candidate changed");
  const afterForgery = storage.loadProgram("program-session");
  expect(afterForgery?.planningState).toBe("reviewed");
  if (!afterForgery || afterForgery.planningState !== "reviewed") {
    throw new Error("Reviewed Program expected after rollback");
  }
  expect(afterForgery.frontier).toBe("implementation_open");
  expect(stoppedCandidateStatus(db)).toBe("eligible");

  storage.commit(decision.transition.ledgerCommit);

  expect(storage.loadProgram("program-session")).toMatchObject({
    frontier: "cancelled",
    tasks: [
      { status: "accepted" },
      { status: "accepted" },
      { status: "cancelled" },
      { status: "cancelled" },
    ],
    cancellation: {
      kind: "cancel_work",
      reason: "Abandon this exact Program",
    },
  });
  expect(await discoverContinuationCandidates(db, freshContinuationCommand())).toEqual([]);
  expect(stoppedCandidateStatus(db)).toBe("cancelled");
  expect(oldTurnState(db)).toBe("cancelled");
  db.close();
});

function stoppedCandidateStatus(db: Database): string | undefined {
  return db.query<{ status: string }, []>(
    "SELECT status FROM btcc_stopped_program_continuations",
  ).get()?.status;
}

function oldTurnState(db: Database): string | undefined {
  return db.query<{ semantic_state: string }, [string]>(
    "SELECT semantic_state FROM btcc_turns WHERE turn_id = ?",
  ).get("turn-user-stopped")?.semantic_state;
}

function terminalWakeRows(db: Database) {
  return db.query<{
    turn_id: string;
    semantic_state: string;
  }, []>(`
    SELECT turn_id, semantic_state FROM btcc_terminal_settlement_wakes
    ORDER BY turn_id
  `).all();
}
