import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { SqliteCanonicalMessageStore } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/canonical-message-store.ts";
import { digest } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/identity.ts";
import { SqliteRuntimeOwnerRegistry } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/runtime-owner/index.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { SqliteGuidedTurnStateRepository } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/sqlite-guided-turn-state-repository.ts";
import { SqliteGuidedToolJournal } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/guided-tool-journal.ts";
import {
  createTurnContinuationBudgetState,
  TurnContinuationBudgetExhaustedError,
  type TurnContinuationBudgetLimits,
} from
  "../../packages/butler-agent/src/agent/btcc/turn/continuation-budget.ts";
import type {
  AcceptedTurnTransition,
  TurnRecord,
} from "../../packages/butler-agent/src/agent/btcc/turn/contracts.ts";

test("R3 final and canonical delivery each commit exactly once", async () => {
  const fixture = createFixture("guided-exactly-once");
  try {
    insertTurn(fixture.db, "turn-exactly-once", "admitted");
    const admitted = await requireTurn(fixture.turns, "turn-exactly-once");
    const admittedClaim = await fixture.turns.acquireStateExecutionClaim(admitted);
    const finalTransition = acceptGuidedFinal(admitted, "one durable answer");

    await fixture.turns.commitTransition({
      turn: admitted,
      claim: admittedClaim,
      transition: finalTransition,
    });
    const committed = await requireTurn(fixture.turns, admitted.turnId);
    expect(committed).toMatchObject({
      semanticState: "delivery_committed",
      revision: 1,
      finalPayload: { content: "one durable answer" },
      deliveryOutbox: { status: "pending" },
    });
    expect(rowCount(fixture.db, "btcc_records")).toBe(1);
    expect(rowCount(fixture.db, "btcc_delivery_outbox")).toBe(1);
    expect(claimStatus(fixture.db, admittedClaim.claimId)).toBe("consumed");

    await expect(fixture.turns.commitTransition({
      turn: admitted,
      claim: admittedClaim,
      transition: finalTransition,
    })).rejects.toThrow("exact Turn claim");
    expect(rowCount(fixture.db, "btcc_records")).toBe(1);
    expect(rowCount(fixture.db, "btcc_delivery_outbox")).toBe(1);

    const messages = new SqliteCanonicalMessageStore(fixture.db);
    const messageInput = {
      turnId: committed.turnId,
      sessionId: committed.sessionId,
      outboxId: committed.deliveryOutbox!.outboxId,
      expectedMessageId: committed.deliveryOutbox!.expectedMessageId,
      payloadRef: committed.deliveryOutbox!.finalPayloadRef,
      content: committed.deliveryOutbox!.content,
    };
    const firstMessage = await messages.insertCanonicalAssistantMessage(messageInput);
    const replayedMessage = await messages.insertCanonicalAssistantMessage(messageInput);
    expect(replayedMessage).toEqual(firstMessage);

    const deliveryClaim = await fixture.turns.acquireStateExecutionClaim(committed);
    await fixture.turns.commitTransition({
      turn: committed,
      claim: deliveryClaim,
      transition: {
        kind: "observe_delivery",
        successor: "delivered",
        assistantMessageId: firstMessage.messageId,
      },
    });
    expect(await requireTurn(fixture.turns, committed.turnId)).toMatchObject({
      semanticState: "delivered",
      revision: 2,
      canonicalAssistantMessageId: firstMessage.messageId,
      deliveryOutbox: { status: "observed" },
    });
    expect(rowCount(fixture.db, "btcc_messages", "role = 'assistant'")).toBe(1);
    expect(rowCount(fixture.db, "btcc_canonical_deliveries")).toBe(1);
    expect(await fixture.turns.stopTurn(committed.turnId)).toEqual({
      kind: "already_delivered",
      turnId: committed.turnId,
      messageId: firstMessage.messageId,
      content: "one durable answer",
    });
  } finally {
    fixture.close();
  }
});

test("R3 Stop wins by exact Turn CAS and revokes an active claim", async () => {
  const fixture = createFixture("guided-stop-cas");
  try {
    insertTurn(fixture.db, "turn-stop-cas", "admitted");
    const admitted = await requireTurn(fixture.turns, "turn-stop-cas");
    const claim = await fixture.turns.acquireStateExecutionClaim(admitted);

    expect(await fixture.turns.stopTurn(admitted.turnId)).toEqual({
      kind: "cancelled",
      turnId: admitted.turnId,
    });
    expect(await fixture.turns.stopTurn(admitted.turnId)).toEqual({
      kind: "already_cancelled",
      turnId: admitted.turnId,
    });
    expect(await requireTurn(fixture.turns, admitted.turnId)).toMatchObject({
      semanticState: "cancelled",
      revision: 1,
      executionFence: 1,
      finalDisposition: "cancelled",
    });
    expect(claimStatus(fixture.db, claim.claimId)).toBe("revoked");
    expect(activeCheckpointCount(fixture.db, admitted.turnId)).toBe(0);
    expect(stopRequest(fixture.db, admitted.turnId)).toEqual({
      status: "already_cancelled",
      observed_turn_revision: 1,
    });

    await expect(fixture.turns.commitTransition({
      turn: admitted,
      claim,
      transition: acceptGuidedFinal(admitted, "must not commit after Stop"),
    })).rejects.toThrow("exact Turn claim");
    expect(rowCount(fixture.db, "btcc_delivery_outbox")).toBe(0);
  } finally {
    fixture.close();
  }
});

test("R3 Stop preserves a committed Outbox for canonical delivery", async () => {
  const fixture = createFixture("guided-stop-outbox");
  try {
    insertTurn(fixture.db, "turn-stop-outbox", "admitted");
    const admitted = await requireTurn(fixture.turns, "turn-stop-outbox");
    await fixture.turns.commitTransition({
      turn: admitted,
      claim: await fixture.turns.acquireStateExecutionClaim(admitted),
      transition: acceptGuidedFinal(admitted, "finish committed delivery"),
    });

    expect(await fixture.turns.stopTurn(admitted.turnId)).toEqual({
      kind: "already_finalizing",
      turnId: admitted.turnId,
    });
    const committed = await requireTurn(fixture.turns, admitted.turnId);
    expect(committed).toMatchObject({
      semanticState: "delivery_committed",
      deliveryOutbox: { status: "pending" },
    });
  } finally {
    fixture.close();
  }
});

test("R3 schema rejects legacy states and repository rejects R2 transitions", async () => {
  const fixture = createFixture("guided-state-boundary");
  try {
    expect(() => insertTurn(fixture.db, "turn-legacy-state", "planning"))
      .toThrow("CHECK constraint failed");

    insertTurn(fixture.db, "turn-r2-transition", "admitted");
    const admitted = await requireTurn(fixture.turns, "turn-r2-transition");
    const claim = await fixture.turns.acquireStateExecutionClaim(admitted);
    const legacyTransition = {
      kind: "activate_opening",
      successor: "conception_opening",
      successorCheckpointKind: "phase",
    } as unknown as AcceptedTurnTransition;
    await expect(fixture.turns.commitTransition({
      turn: admitted,
      claim,
      transition: legacyTransition,
    })).rejects.toThrow("does not support transition");
    expect(claimStatus(fixture.db, claim.claimId)).toBe("active");
    expect(activeCheckpointCount(fixture.db, admitted.turnId)).toBe(1);
  } finally {
    fixture.close();
  }
});

test("Turn continuation budget increments atomically with the first route dispatch and hydrates", async () => {
  const fixture = createFixture("guided-continuation-budget");
  try {
    insertTurn(fixture.db, "turn-continuation-budget", "admitted");
    const turn = await requireTurn(fixture.turns, "turn-continuation-budget");
    const claim = await fixture.turns.acquireStateExecutionClaim(turn);
    const limits = {
        maxModelRequests: 3,
        maxToolRounds: 4,
        maxPromptTokens: 5,
        maxOutputTokens: 6,
        maxElapsedMs: 7_000,
        maxIdleMs: 8_000,
    };
    setContinuationBudget(fixture.db, turn.turnId, limits);
    const input = {
      turnId: turn.turnId,
      expectedRevision: turn.revision,
      executionFence: turn.executionFence,
      claimId: claim.claimId,
      event: {
        type: "model.attempt.started",
        roundId: "round-1",
        candidateIndex: 0,
        transportAttempt: 1,
        modelRef: "openai/gpt-5.6-sol",
        continuationBudgetEnabled: true,
        requestHash: "a".repeat(64),
        serializedRequestBytes: 100,
      },
    };
    await fixture.turns.recordModelRouteEvent(input);
    expect((await requireTurn(fixture.turns, turn.turnId)).continuationBudget)
      .toMatchObject({
        turnId: turn.turnId,
        consumedModelRequests: 1,
        limits,
        terminal: { status: "active" },
      });
    await fixture.turns.recordModelRouteEvent(input);
    expect((await requireTurn(fixture.turns, turn.turnId)).continuationBudget)
      .toMatchObject({ consumedModelRequests: 1 });
  } finally {
    fixture.close();
  }
});

test("Turn continuation same-size no-progress persists before redispatch", async () => {
  const fixture = createFixture("guided-continuation-no-progress");
  try {
    insertTurn(fixture.db, "turn-continuation-no-progress", "admitted");
    const turn = await requireTurn(fixture.turns, "turn-continuation-no-progress");
    const claim = await fixture.turns.acquireStateExecutionClaim(turn);
    const limits = continuationLimits();
    setContinuationBudget(fixture.db, turn.turnId, limits);
    const record = (roundId: string, requestHash: string) =>
      fixture.turns.recordModelRouteEvent({
        turnId: turn.turnId,
        expectedRevision: turn.revision,
        executionFence: turn.executionFence,
        claimId: claim.claimId,
        event: {
          type: "model.attempt.started",
          roundId,
          candidateIndex: 0,
          transportAttempt: 1,
          modelRef: "openai/gpt-5.6-sol",
          continuationBudgetEnabled: true,
          requestHash,
          serializedRequestBytes: 100,
        },
      });

    await record("round-1", "a".repeat(64));
    await expect(record("round-2", "b".repeat(64)))
      .rejects.toBeInstanceOf(TurnContinuationBudgetExhaustedError);
    expect((await requireTurn(fixture.turns, turn.turnId)).continuationBudget)
      .toMatchObject({
        consumedModelRequests: 1,
        terminal: { status: "exhausted", reason: "no_progress" },
      });
    expect(rowCount(
      fixture.db,
      "btcc_model_route_events",
      "event_type = 'model.attempt.started'",
    )).toBe(1);
  } finally {
    fixture.close();
  }
});

test("Turn continuation admits one same-size request after a novel durable ref", async () => {
  const fixture = createFixture("guided-continuation-novel-ref");
  try {
    insertTurn(fixture.db, "turn-continuation-novel-ref", "admitted");
    const turn = await requireTurn(fixture.turns, "turn-continuation-novel-ref");
    const claim = await fixture.turns.acquireStateExecutionClaim(turn);
    setContinuationBudget(fixture.db, turn.turnId, continuationLimits());
    const record = (roundId: string) => fixture.turns.recordModelRouteEvent({
      turnId: turn.turnId,
      expectedRevision: turn.revision,
      executionFence: turn.executionFence,
      claimId: claim.claimId,
      event: {
        type: "model.attempt.started",
        roundId,
        candidateIndex: 0,
        transportAttempt: 1,
        modelRef: "openai/gpt-5.6-sol",
        continuationBudgetEnabled: true,
        requestHash: roundId.repeat(8),
        serializedRequestBytes: 100,
      },
    });
    await record("round-1");
    const journal = new SqliteGuidedToolJournal(fixture.db);
    journal.start({
      turnId: turn.turnId,
      callId: "novel-ref-call",
      toolName: "read_file",
      rawArguments: '{"path":"a.txt"}',
      arguments: { path: "a.txt" },
      operationBatchId: "novel-ref-batch",
      operationBatchOrdinal: 0,
      continuationBudgetClaim: claim,
    });
    journal.finish({
      callId: "novel-ref-call",
      status: "completed",
      result: { content: "bounded" },
      continuationBudgetClaim: claim,
    });
    await expect(record("round-2")).resolves.toMatchObject({ status: "recorded" });
    await expect(record("round-3"))
      .rejects.toBeInstanceOf(TurnContinuationBudgetExhaustedError);
    expect((await requireTurn(fixture.turns, turn.turnId)).continuationBudget)
      .toMatchObject({
        consumedModelRequests: 2,
        seenDurableResultRefs: [expect.any(String)],
        terminal: { status: "exhausted", reason: "no_progress" },
      });
  } finally {
    fixture.close();
  }
});

test("accepted replay survives token exhaustion and nullable usage is counted once", async () => {
  const fixture = createFixture("guided-continuation-acceptance");
  try {
    insertTurn(fixture.db, "turn-continuation-acceptance", "admitted");
    const turn = await requireTurn(fixture.turns, "turn-continuation-acceptance");
    const claim = await fixture.turns.acquireStateExecutionClaim(turn);
    const routeDigest = "route-acceptance";
    setContinuationBudget(fixture.db, turn.turnId, {
      ...continuationLimits(),
      maxOutputTokens: 4,
    });
    await fixture.turns.recordModelRouteEvent({
      turnId: turn.turnId,
      expectedRevision: turn.revision,
      executionFence: turn.executionFence,
      claimId: claim.claimId,
      event: {
        type: "model.attempt.started",
        roundId: "round-1",
        candidateIndex: 0,
        transportAttempt: 1,
        modelRef: "openai/gpt-5.6-sol",
        continuationBudgetEnabled: true,
        requestHash: "c".repeat(64),
        serializedRequestBytes: 101,
      },
    });
    const acceptance = {
      turnId: turn.turnId,
      expectedRevision: turn.revision,
      executionFence: turn.executionFence,
      claimId: claim.claimId,
      checkpointId: claim.checkpointId,
      checkpointRevision: claim.checkpointRevision,
      roundId: "round-1",
      routeDigest,
      candidateIndex: 0,
      transportAttempt: 1,
      modelRef: "openai/gpt-5.6-sol",
      continuationBudgetEnabled: true,
      requestHash: "c".repeat(64),
      serializedRequestBytes: 101,
      result: {
        text: "accepted",
        toolCalls: [],
        usage: {
          model: "openai/gpt-5.6-sol",
          promptTokens: null,
          cachedTokens: 0,
          outputTokens: 4,
          totalTokens: 4,
        },
      },
    };
    await fixture.turns.recordModelRoundAcceptance(acceptance);
    await fixture.turns.recordModelRoundAcceptance(acceptance);
    const beforeReplay = (await requireTurn(fixture.turns, turn.turnId))
      .continuationBudget;
    await expect(fixture.turns.loadModelRoundAcceptance({
      turnId: turn.turnId,
      roundId: "round-1",
      routeDigest,
      candidateIndex: 0,
      modelRef: "openai/gpt-5.6-sol",
      checkpointId: claim.checkpointId,
      checkpointRevision: claim.checkpointRevision,
    })).resolves.toMatchObject({ text: "accepted" });
    expect((await requireTurn(fixture.turns, turn.turnId)).continuationBudget)
      .toEqual(beforeReplay);
    expect(beforeReplay).toMatchObject({
      consumedModelRequests: 1,
      consumedPromptTokens: 0,
      consumedOutputTokens: 4,
      terminal: { status: "exhausted", reason: "max_output_tokens" },
    });
  } finally {
    fixture.close();
  }
});

test("one tool round is counted per durable operation batch across journal restart", async () => {
  const fixture = createFixture("guided-continuation-tool-batch");
  try {
    insertTurn(fixture.db, "turn-continuation-tool-batch", "admitted");
    const turn = await requireTurn(fixture.turns, "turn-continuation-tool-batch");
    const claim = await fixture.turns.acquireStateExecutionClaim(turn);
    setContinuationBudget(fixture.db, turn.turnId, continuationLimits());
    await fixture.turns.recordModelRouteEvent({
      turnId: turn.turnId,
      expectedRevision: turn.revision,
      executionFence: turn.executionFence,
      claimId: claim.claimId,
      event: {
        type: "model.attempt.started",
        roundId: "round-1",
        candidateIndex: 0,
        transportAttempt: 1,
        modelRef: "openai/gpt-5.6-sol",
        continuationBudgetEnabled: true,
        requestHash: "d".repeat(64),
        serializedRequestBytes: 102,
      },
    });
    const start = (journal: SqliteGuidedToolJournal, callId: string, ordinal: number) =>
      journal.start({
        turnId: turn.turnId,
        callId,
        toolName: "read_file",
        rawArguments: '{"path":"a.txt"}',
        arguments: { path: "a.txt" },
        operationBatchId: "durable-batch-1",
        operationBatchOrdinal: ordinal,
        continuationBudgetClaim: claim,
      });
    const firstJournal = new SqliteGuidedToolJournal(fixture.db);
    start(firstJournal, "call-batch-1", 0);
    start(firstJournal, "call-batch-2", 1);
    const restartedJournal = new SqliteGuidedToolJournal(fixture.db);
    start(restartedJournal, "call-batch-3", 2);
    expect((await requireTurn(fixture.turns, turn.turnId)).continuationBudget)
      .toMatchObject({ consumedToolRounds: 1 });
  } finally {
    fixture.close();
  }
});

function createFixture(ownerId: string) {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const owner = new SqliteRuntimeOwnerRegistry(db, {
    ownerId,
    hostId: "test-host",
    processId: 100,
    processStartedAtMs: 1,
  }, {
    isAlive: () => false,
  });
  const turns = new SqliteGuidedTurnStateRepository(db, owner);
  return {
    db,
    turns,
    close() {
      owner.close();
      db.close();
    },
  };
}

function continuationLimits(): TurnContinuationBudgetLimits {
  return {
    maxModelRequests: 10,
    maxToolRounds: 10,
    maxPromptTokens: 10_000,
    maxOutputTokens: 10_000,
    maxElapsedMs: 60_000,
    maxIdleMs: 60_000,
  };
}

function setContinuationBudget(
  db: Database,
  turnId: string,
  limits: TurnContinuationBudgetLimits,
): void {
  db.query(`
    UPDATE btcc_turns SET continuation_budget_json = ? WHERE turn_id = ?
  `).run(JSON.stringify(createTurnContinuationBudgetState({
    turnId,
    limits,
    nowMs: Date.now(),
  })), turnId);
}

function insertTurn(
  db: Database,
  turnId: string,
  semanticState: string,
): void {
  const checkpointId = digest(
    `btcc-checkpoint.v1\x00${turnId}\x00${0}\x00${semanticState}`,
  );
  db.query(`
    INSERT INTO btcc_turns (
      turn_id, session_id, inbox_id, trigger_key, original_message_id,
      original_message, admission_snapshot_ref, model_selection_json,
      context_json, semantic_state, active_checkpoint_id, revision,
      execution_fence
    ) VALUES (?, 'session', ?, ?, ?, 'request', 'snapshot', ?, ?, ?, ?, 0, 0)
  `).run(
    turnId,
    `inbox:${turnId}`,
    `trigger:${turnId}`,
    `message:${turnId}`,
    JSON.stringify({
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      controls: { accessMode: "full_access" },
      controlsHash: "controls",
    }),
    JSON.stringify({
      userRef: "local-user",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: [],
    }),
    semanticState,
    checkpointId,
  );
  db.query(`
    INSERT INTO btcc_checkpoints (
      checkpoint_id, turn_id, turn_revision, semantic_state, kind,
      checkpoint_revision, is_active
    ) VALUES (?, ?, 0, ?, 'runtime', 1, 1)
  `).run(checkpointId, turnId, semanticState);
}

function acceptGuidedFinal(
  turn: TurnRecord,
  content: string,
): Extract<AcceptedTurnTransition, { kind: "accept_guided_final" }> {
  const contentSha256 = digest(content);
  const finalPayload = {
    ref: {
      id: digest(`payload:${turn.turnId}:${contentSha256}`),
      sha256: contentSha256,
    },
    content,
    contentSha256,
  };
  const outboxId = digest(`outbox:${turn.turnId}:${turn.revision + 1}:${contentSha256}`);
  return {
    kind: "accept_guided_final",
    successor: "delivery_committed",
    successorCheckpointKind: "runtime",
    route: "direct",
    finalPayload,
    deliveryOutbox: {
      outboxId,
      finalPayloadRef: finalPayload.ref,
      expectedMessageId: digest(`assistant:${outboxId}`),
      content,
      status: "pending",
    },
  };
}

async function requireTurn(
  turns: SqliteGuidedTurnStateRepository,
  turnId: string,
): Promise<TurnRecord> {
  const turn = await turns.findTurn(turnId);
  if (!turn) throw new Error(`missing Turn fixture: ${turnId}`);
  return turn;
}

function rowCount(db: Database, table: string, where?: string): number {
  return db.query<{ count: number }, []>(
    `SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ""}`,
  ).get()?.count ?? 0;
}

function claimStatus(db: Database, claimId: string): string | null {
  return db.query<{ status: string }, [string]>(
    "SELECT status FROM btcc_state_claims WHERE claim_id = ?",
  ).get(claimId)?.status ?? null;
}

function activeCheckpointCount(db: Database, turnId: string): number {
  return db.query<{ count: number }, [string]>(`
    SELECT COUNT(*) AS count FROM btcc_checkpoints
    WHERE turn_id = ? AND is_active = 1
  `).get(turnId)?.count ?? 0;
}

function stopRequest(
  db: Database,
  turnId: string,
): { status: string; observed_turn_revision: number } | null {
  return db.query<{
    status: string;
    observed_turn_revision: number;
  }, [string]>(`
    SELECT status, observed_turn_revision
    FROM btcc_stop_requests WHERE turn_id = ?
  `).get(turnId) ?? null;
}
