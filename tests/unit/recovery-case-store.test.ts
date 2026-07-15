import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentConversationStore,
  conversationStorePath,
} from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { BtccRecoveryCaseStore } from "../../packages/butler-agent/src/agent/turn/interruption/recovery-case-store.ts";
import {
  routeTurnInterruption,
  runtimeInterruptionFromUnknown,
} from "../../packages/butler-agent/src/agent/turn/interruption/turn-interruption-router.ts";
import { TURN_INTERRUPTION_ENVELOPE_SCHEMA } from "../../packages/butler-agent/src/agent/turn/interruption/turn-interruption-types.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function tempData(): string {
  const path = mkdtempSync(join(tmpdir(), "butler-btcc-recovery-"));
  tempDirs.push(path);
  return path;
}

function beginConversationTurn(
  store: AgentConversationStore,
  turnId: string,
  sessionId: string,
): void {
  store.beginTurn({
    gateway: "app",
    externalSessionId: sessionId,
    sessionId,
    workspaceId: "workspace-1",
    projectId: "butler",
    actor: "user",
    turnId,
    now: "2026-07-15T00:00:00.000Z",
  });
}

describe("BtccRecoveryCaseStore", () => {
  test("atomically opens one durable runtime wait and replays idempotently", () => {
    const butlerData = tempData();
    const conversations = new AgentConversationStore({ butlerData });
    const store = new BtccRecoveryCaseStore({ butlerData });
    beginConversationTurn(conversations, "turn-1", "session-1");
    const admitted = store.admitTurn({
      turnId: "turn-1",
      sessionId: "session-1",
      attemptId: "attempt-1",
      now: "2026-07-15T00:00:01.000Z",
    });
    const directive = routeTurnInterruption(runtimeInterruptionFromUnknown({
      error: new Error("opaque runtime exception"),
      interruptionId: "interruption-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      origin: "phase_runtime",
      currentGeneration: admitted.generation,
      lastStableCheckpointRef: "checkpoint-1",
      createdAt: "2026-07-15T00:00:02.000Z",
      pendingOperationRef: "operation-1",
      sideEffectState: "indeterminate",
      resumePredicateRef: "runtime-revision-changed",
      wakeRevisionRef: "runtime-revision-1",
      diagnosticRefs: ["diagnostic-1"],
    }));

    const waiting = store.applyDirective(directive);
    const replayed = store.applyDirective(directive);
    const recovery = store.readRecoveryCase(waiting.activeRecoveryCaseId!);
    const events = conversations.readProjectionBatch(null, 100);

    expect(waiting).toMatchObject({
      turnId: "turn-1",
      attemptId: "attempt-1",
      state: "waiting_runtime",
      generation: 2,
      lastStableCheckpointRef: "checkpoint-1",
    });
    expect(replayed).toEqual(waiting);
    expect(recovery).toMatchObject({
      turnId: "turn-1",
      attemptId: "attempt-1",
      interruptionId: "interruption-1",
      status: "open",
      sideEffectState: "indeterminate",
    });
    expect(events.filter((event) => event.kind === "runtime.interruption.recorded"))
      .toHaveLength(1);
    expect(events.filter((event) => event.kind === "recovery.case.opened"))
      .toHaveLength(1);

    store.close();
    conversations.close();
  });

  test("unchanged recovery evidence makes no attempt and changed evidence resumes the same turn", () => {
    const butlerData = tempData();
    const conversations = new AgentConversationStore({ butlerData });
    const store = new BtccRecoveryCaseStore({ butlerData });
    beginConversationTurn(conversations, "turn-2", "session-2");
    store.admitTurn({
      turnId: "turn-2",
      sessionId: "session-2",
      attemptId: "attempt-2",
    });
    const waiting = store.applyDirective(routeTurnInterruption({
      schemaVersion: TURN_INTERRUPTION_ENVELOPE_SCHEMA,
      kind: "runtime_interruption",
      interruptionId: "interruption-2",
      turnId: "turn-2",
      attemptId: "attempt-2",
      origin: "continuation_handoff",
      currentGeneration: 1,
      lastStableCheckpointRef: "checkpoint-2",
      createdAt: "2026-07-15T00:00:02.000Z",
      diagnosticCode: "queue_claim_invariant_violation",
      sideEffectState: "known_not_applied",
      resumePredicateRef: "queue-claim-revision-changed",
      wakeRevisionRef: "queue-revision-1",
      diagnosticRefs: ["queue-diagnostic-1"],
    }));
    const unchanged = store.resolveRecoveryCase({
      recoveryCaseId: waiting.activeRecoveryCaseId!,
      observedWakeRevisionRef: "queue-revision-1",
    });
    const changed = store.resolveRecoveryCase({
      recoveryCaseId: waiting.activeRecoveryCaseId!,
      observedWakeRevisionRef: "queue-revision-2",
    });

    expect(unchanged).toMatchObject({
      changed: false,
      state: { generation: 2, state: "waiting_runtime", attemptId: "attempt-2" },
    });
    expect(changed).toMatchObject({
      changed: true,
      state: { generation: 3, state: "continuing", attemptId: "attempt-2" },
      recoveryCase: { status: "resolved", wakeRevisionRef: "queue-revision-2" },
    });

    store.close();
    conversations.close();
  });

  test("persists continuation and typed wait ownership without terminal aliases", () => {
    const butlerData = tempData();
    const conversations = new AgentConversationStore({ butlerData });
    const store = new BtccRecoveryCaseStore({ butlerData });
    beginConversationTurn(conversations, "turn-waits", "session-waits");
    store.admitTurn({
      turnId: "turn-waits",
      sessionId: "session-waits",
      attemptId: "attempt-waits",
    });
    const continuing = store.applyDirective(routeTurnInterruption({
      schemaVersion: TURN_INTERRUPTION_ENVELOPE_SCHEMA,
      kind: "internal_incompletion",
      interruptionId: "incompletion-1",
      turnId: "turn-waits",
      attemptId: "attempt-waits",
      origin: "phase_runtime",
      currentGeneration: 1,
      lastStableCheckpointRef: "checkpoint-1",
      continuationCheckpointRef: "checkpoint-2",
      createdAt: "2026-07-15T00:00:01.000Z",
    }));
    const waitingUser = store.applyDirective(routeTurnInterruption({
      schemaVersion: TURN_INTERRUPTION_ENVELOPE_SCHEMA,
      kind: "user_authority_required",
      interruptionId: "user-wait-1",
      turnId: "turn-waits",
      attemptId: "attempt-waits",
      origin: "phase_runtime",
      currentGeneration: continuing.generation,
      lastStableCheckpointRef: "checkpoint-2",
      ownerRef: "typed-user-blocker-1",
      createdAt: "2026-07-15T00:00:02.000Z",
    }));
    beginConversationTurn(conversations, "turn-external", "session-waits");
    store.admitTurn({
      turnId: "turn-external",
      sessionId: "session-waits",
      attemptId: "attempt-external",
    });
    const waitingExternal = store.applyDirective(routeTurnInterruption({
      schemaVersion: TURN_INTERRUPTION_ENVELOPE_SCHEMA,
      kind: "external_authority_required",
      interruptionId: "external-wait-1",
      turnId: "turn-external",
      attemptId: "attempt-external",
      origin: "continuation_handoff",
      currentGeneration: 1,
      lastStableCheckpointRef: "checkpoint-external",
      ownerRef: "external-job-1",
      wakeRevisionRef: "external-revision-1",
      createdAt: "2026-07-15T00:00:03.000Z",
    }));

    expect(continuing).toMatchObject({
      state: "continuing",
      lastStableCheckpointRef: "checkpoint-2",
    });
    expect(waitingUser).toMatchObject({
      state: "waiting_user",
      activeWaitOwnerRef: "typed-user-blocker-1",
    });
    expect(waitingExternal).toMatchObject({
      state: "waiting_external",
      activeWaitOwnerRef: "external-job-1",
      activeWakeRevisionRef: "external-revision-1",
    });
    expect(waitingExternal.attemptId).toBe("attempt-external");
    expect(() => store.applyDirective(routeTurnInterruption({
      schemaVersion: TURN_INTERRUPTION_ENVELOPE_SCHEMA,
      kind: "internal_incompletion",
      interruptionId: "user-wait-bypass",
      turnId: "turn-waits",
      attemptId: "attempt-waits",
      origin: "phase_runtime",
      currentGeneration: waitingUser.generation,
      lastStableCheckpointRef: "checkpoint-2",
      continuationCheckpointRef: "checkpoint-3",
      createdAt: "2026-07-15T00:00:04.000Z",
    }))).toThrow("btcc_turn_wait_requires_resume_receipt");

    store.close();
    conversations.close();
  });

  test("database constraints reject failure aliases and protect interruption receipts", () => {
    const butlerData = tempData();
    const conversations = new AgentConversationStore({ butlerData });
    const store = new BtccRecoveryCaseStore({ butlerData });
    beginConversationTurn(conversations, "turn-3", "session-3");
    store.admitTurn({
      turnId: "turn-3",
      sessionId: "session-3",
      attemptId: "attempt-3",
    });
    const waiting = store.applyDirective(routeTurnInterruption({
      schemaVersion: TURN_INTERRUPTION_ENVELOPE_SCHEMA,
      kind: "runtime_interruption",
      interruptionId: "interruption-3",
      turnId: "turn-3",
      attemptId: "attempt-3",
      origin: "phase_runtime",
      currentGeneration: 1,
      lastStableCheckpointRef: "checkpoint-3",
      createdAt: "2026-07-15T00:00:03.000Z",
      diagnosticCode: "storage_invariant_violation",
      sideEffectState: "none",
      resumePredicateRef: "storage-revision-changed",
      diagnosticRefs: ["storage-diagnostic-1"],
    }));
    const db = new Database(conversationStorePath(butlerData));

    expect(() => db.query(
      "UPDATE btcc_turn_states SET state = 'failed' WHERE turn_id = ?",
    ).run("turn-3")).toThrow();
    expect(() => db.query(`
      UPDATE btcc_interruption_receipts
      SET diagnostic_code = 'rewritten'
      WHERE interruption_id = ?
    `).run("interruption-3")).toThrow("btcc_interruption_receipt_immutable");
    expect(store.readTurnState("turn-3")).toEqual(waiting);

    db.close();
    store.close();
    conversations.close();
  });

  test("only a matching principal cancellation generation can terminalize", () => {
    const butlerData = tempData();
    const conversations = new AgentConversationStore({ butlerData });
    const store = new BtccRecoveryCaseStore({ butlerData });
    beginConversationTurn(conversations, "turn-4", "session-4");
    store.admitTurn({
      turnId: "turn-4",
      sessionId: "session-4",
      attemptId: "attempt-4",
    });
    const cancelled = store.applyDirective(routeTurnInterruption({
      schemaVersion: TURN_INTERRUPTION_ENVELOPE_SCHEMA,
      kind: "user_cancellation",
      interruptionId: "interruption-4",
      turnId: "turn-4",
      attemptId: "attempt-4",
      origin: "admission",
      currentGeneration: 1,
      lastStableCheckpointRef: "checkpoint-4",
      createdAt: "2026-07-15T00:00:04.000Z",
      cancellationGeneration: 1,
      cancellationReceiptRef: "principal-cancel-4",
    }));

    expect(cancelled).toMatchObject({
      state: "cancelled",
      terminalOutcomeId: "principal-cancel-4",
      generation: 2,
    });
    expect(() => store.applyDirective(routeTurnInterruption({
      schemaVersion: TURN_INTERRUPTION_ENVELOPE_SCHEMA,
      kind: "internal_incompletion",
      interruptionId: "interruption-late",
      turnId: "turn-4",
      attemptId: "attempt-4",
      origin: "phase_runtime",
      currentGeneration: 2,
      lastStableCheckpointRef: "checkpoint-4",
      createdAt: "2026-07-15T00:00:05.000Z",
      continuationCheckpointRef: "checkpoint-5",
    }))).toThrow("btcc_turn_terminal_immutable");

    store.close();
    conversations.close();
  });
});
