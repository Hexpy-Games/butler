import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BtccRunCommand } from
  "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import type { TurnStateRepository } from
  "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import {
  createTurnRuntime as createGuidedTurnRuntime,
} from "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import type { BtccAgentLoop as GuidedTurnAgent } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/index.ts";
import { runBtccAgentLoop } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/index.ts";
import type { ModelRoundPort } from
  "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import { openBtccSqliteStores } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { buildModelRoute } from
  "../../packages/butler-agent/src/agent/btcc/model-route/index.ts";
import { ModelProviderRequestError } from
  "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";

const executionWindowEchoTool = {
  name: "echo",
  description: "Echo a message.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { message: { type: "string" } },
    required: ["message"],
  },
};

test("Guided Turn answers directly through only durable admission and delivery states", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-guided-direct-"));
  const dbPath = join(root, "btcc.sqlite");
  const stores = openBtccSqliteStores({
    dbPath,
    ownerId: "guided-direct",
    storageProfile: "ephemeral",
  });
  const states: string[] = [];
  let calls = 0;
  const runtime = createGuidedTurnRuntime({
    admission: stores.admission,
    turns: stores.turns,
    messages: stores.messages,
    committedSuccessorReadiness: stores.committedSuccessorReadiness,
    progress: { stateChanged(update) { states.push(update.semanticState); } },
    agent: {
      async run() {
        calls += 1;
        return { route: "direct", content: "안녕하세요. 무엇을 도와드릴까요?" };
      },
    },
  });
  try {
    const command = runCommand("guided-direct-turn");
    const first = await runtime.runTurn(command);
    const replay = await runtime.runTurn(command);

    expect(first).toMatchObject({
      kind: "delivered",
      turnId: command.turnId,
      content: "안녕하세요. 무엇을 도와드릴까요?",
    });
    expect(replay).toEqual(first);
    expect(calls).toBe(1);
    expect(states).toEqual([
      "admitted",
      "delivery_committed",
      "delivered",
      "delivered",
    ]);

    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.query<{ semantic_state: string }, []>(`
        SELECT semantic_state FROM btcc_turns
      `).get()?.semantic_state).toBe("delivered");
      expect(db.query<{ semantic_state: string }, []>(`
        SELECT semantic_state FROM btcc_checkpoints ORDER BY turn_revision
      `).all().map((row) => row.semantic_state)).toEqual([
        "admitted",
        "delivery_committed",
      ]);
    } finally {
      db.close();
    }
  } finally {
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Guided execution windows stay in one Turn and commit one canonical answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-guided-same-turn-window-"));
  const dbPath = join(root, "btcc.sqlite");
  const stores = openBtccSqliteStores({
    dbPath,
    ownerId: "guided-same-turn-window",
    storageProfile: "ephemeral",
  });
  const turnIds: string[] = [];
  let agentRuns = 0;
  let modelCalls = 0;
  const runtime = createGuidedTurnRuntime({
    admission: stores.admission,
    turns: stores.turns,
    messages: stores.messages,
    agent: {
      async run({ turn }) {
        agentRuns += 1;
        turnIds.push(turn.turnId);
        const modelRound: ModelRoundPort = {
          async runRound() {
            modelCalls += 1;
            return modelCalls === 1
              ? {
                  toolCalls: [{
                    id: "same-turn-window-tool",
                    name: "echo",
                    arguments: { message: "checkpoint" },
                    rawArguments: '{"message":"checkpoint"}',
                  }],
                }
              : { text: "완료된 단일 최종 답변입니다.", toolCalls: [] };
          },
        };
        const loop = await runBtccAgentLoop({
          prompt: turn.originalMessage,
          turnId: turn.turnId,
          tools: [executionWindowEchoTool],
          maxIterations: 1,
          modelRound,
          executeTool: async (call) => ({
            message: call.arguments.message,
          }),
          onExecutionWindowBoundary: () =>
            "Execution checkpoint: use the existing evidence and finish the original request.",
        });
        return { route: "direct", content: loop.finalText };
      },
    },
  });
  const command = runCommand("guided-same-turn-window");
  try {
    const result = await runtime.runTurn(command);
    expect(result).toMatchObject({
      kind: "delivered",
      turnId: command.turnId,
      content: "완료된 단일 최종 답변입니다.",
    });
    expect(agentRuns).toBe(1);
    expect(modelCalls).toBe(2);
    expect(turnIds).toEqual([command.turnId]);
    expect((await stores.turns.findTurn(command.turnId))?.semanticState)
      .toBe("delivered");
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM btcc_messages
        WHERE turn_id = ? AND role = 'assistant'
      `).get(command.turnId)?.count).toBe(1);
      expect(db.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM btcc_turns WHERE turn_id = ?
      `).get(command.turnId)?.count).toBe(1);
      expect(db.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM btcc_canonical_deliveries WHERE turn_id = ?
      `).get(command.turnId)?.count).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Guided Turn retries only the same final commit after SQLite contention", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-guided-final-contention-"));
  const stores = openBtccSqliteStores({
    dbPath: join(root, "btcc.sqlite"),
    ownerId: "guided-final-contention",
    storageProfile: "ephemeral",
  });
  let modelCalls = 0;
  let finalCommitAttempts = 0;
  let readinessWaits = 0;
  let firstFinalCommit:
    Parameters<TurnStateRepository["commitTransition"]>[0] | undefined;
  const turns = overrideTransitionCommit(stores.turns, async (input) => {
    if (input.transition.kind === "accept_guided_final") {
      finalCommitAttempts += 1;
      if (finalCommitAttempts === 1) {
        firstFinalCommit = input;
        const error = new Error("database is locked");
        error.name = "SQLiteError";
        throw error;
      }
      if (!firstFinalCommit) throw new Error("missing first final commit attempt");
      expect(input.claim === firstFinalCommit.claim).toBe(true);
      expect(input.transition === firstFinalCommit.transition).toBe(true);
    }
    await stores.turns.commitTransition(input);
  });
  const runtime = createGuidedTurnRuntime({
    admission: stores.admission,
    turns,
    messages: stores.messages,
    committedSuccessorReadiness: {
      async waitForStorageReadiness() {
        readinessWaits += 1;
      },
    },
    agent: {
      async run() {
        modelCalls += 1;
        return { route: "direct", content: "same in-memory answer" };
      },
    },
  });
  try {
    expect(await runtime.runTurn(runCommand("guided-final-contention-turn")))
      .toMatchObject({ kind: "delivered", content: "same in-memory answer" });
    expect(modelCalls).toBe(1);
    expect(finalCommitAttempts).toBe(2);
    expect(readinessWaits).toBe(1);
  } finally {
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Guided Turn does not retry a non-contention final commit failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-guided-final-invalid-"));
  const stores = openBtccSqliteStores({
    dbPath: join(root, "btcc.sqlite"),
    ownerId: "guided-final-invalid",
    storageProfile: "ephemeral",
  });
  let modelCalls = 0;
  let finalCommitAttempts = 0;
  let readinessWaits = 0;
  const turns = overrideTransitionCommit(stores.turns, async (input) => {
    if (input.transition.kind === "accept_guided_final") {
      finalCommitAttempts += 1;
      throw new Error("final transition invariant failed");
    }
    await stores.turns.commitTransition(input);
  });
  const runtime = createGuidedTurnRuntime({
    admission: stores.admission,
    turns,
    messages: stores.messages,
    committedSuccessorReadiness: {
      async waitForStorageReadiness() {
        readinessWaits += 1;
      },
    },
    agent: {
      async run() {
        modelCalls += 1;
        return { route: "direct", content: "must not be recalled" };
      },
    },
  });
  try {
    await expect(runtime.runTurn(runCommand("guided-final-invalid-turn")))
      .rejects.toThrow("final transition invariant failed");
    expect(modelCalls).toBe(1);
    expect(finalCommitAttempts).toBe(1);
    expect(readinessWaits).toBe(0);
  } finally {
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Guided Turn delivers an explicit operational failure when the model produces no final answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-guided-provider-failure-"));
  const stores = openBtccSqliteStores({
    dbPath: join(root, "btcc.sqlite"),
    ownerId: "guided-provider-failure",
    storageProfile: "ephemeral",
  });
  const runtime = createGuidedTurnRuntime({
    admission: stores.admission,
    turns: stores.turns,
    messages: stores.messages,
    agent: {
      async run() {
        throw new ModelProviderRequestError({
          code: "provider_network_error",
          message: "provider disconnected before final answer",
          provider: "test-provider",
          retryable: true,
        });
      },
    },
  });
  try {
    expect(await runtime.runTurn(runCommand("guided-provider-failure-turn")))
      .toMatchObject({
        kind: "delivered",
        content: "모델 연결이 일시적으로 중단되어 이 Turn의 답변을 완료하지 못했습니다. 저장된 작업과 확인된 결과는 변경하지 않았습니다.",
      });
  } finally {
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Guided Turn reports a permanent provider failure without a retry request", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-guided-provider-permanent-"));
  const stores = openBtccSqliteStores({
    dbPath: join(root, "btcc.sqlite"),
    ownerId: "guided-provider-permanent",
    storageProfile: "ephemeral",
  });
  const runtime = createGuidedTurnRuntime({
    admission: stores.admission,
    turns: stores.turns,
    messages: stores.messages,
    agent: {
      async run() {
        throw new ModelProviderRequestError({
          code: "provider_auth_error",
          message: "provider credentials rejected",
          provider: "test-provider",
          retryable: false,
        });
      },
    },
  });
  try {
    const result = await runtime.runTurn(runCommand("guided-provider-permanent-turn"));
    expect(result).toMatchObject({
      kind: "delivered",
      content: "모델 제공자 설정 또는 요청이 승인되지 않아 이 Turn의 답변을 완료하지 못했습니다. 저장된 작업과 확인된 결과는 변경하지 않았습니다.",
    });
    expect(JSON.stringify(result)).not.toMatch(/다시 요청|이어|retry|continue/iu);
  } finally {
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Guided Turn preserves an admitted Turn when route durability fails before dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-guided-route-durability-"));
  const dbPath = join(root, "btcc.sqlite");
  const stores = openBtccSqliteStores({
    dbPath,
    ownerId: "guided-route-durability",
    storageProfile: "ephemeral",
  });
  const turns: TurnStateRepository = {
    findTurn: (turnId) => stores.turns.findTurn(turnId),
    activateCommittedSuccessor: (turnId) => stores.turns.activateCommittedSuccessor(turnId),
    acquireStateExecutionClaim: (turn) => stores.turns.acquireStateExecutionClaim(turn),
    commitTransition: (input) => stores.turns.commitTransition(input),
    stopTurn: (turnId) => stores.turns.stopTurn(turnId),
    recordModelRouteEvent: async () => {
      throw new Error("database is locked");
    },
  };
  const runtime = createGuidedTurnRuntime({
    admission: stores.admission,
    turns,
    messages: stores.messages,
    agent: {
      async run({ recordModelRouteEvent }) {
        await recordModelRouteEvent?.({
          type: "model.attempt.started",
          roundId: "durability-round",
          candidateIndex: 0,
          transportAttempt: 1,
          modelRef: "openai/gpt-5.6-sol",
        });
        return { route: "direct", content: "must not dispatch" };
      },
    },
  });
  const command = runCommand("guided-route-durability-turn");
  try {
    await expect(runtime.runTurn(command)).rejects.toMatchObject({
      name: "ModelRouteDurabilityError",
      code: "model_route_durability_failure",
      phase: "attempt_event_write",
    });
    expect((await stores.turns.findTurn(command.turnId))?.semanticState).toBe("admitted");
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.query<{ active: number }, []>(`
        SELECT COUNT(*) AS active FROM btcc_checkpoints WHERE is_active = 1
      `).get()?.active).toBe(1);
      expect(db.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM btcc_model_route_events
        WHERE turn_id = 'guided-route-durability-turn'
      `).get()?.count).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Guided Turn retries SQLite route-journal contention before dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-guided-route-contention-"));
  const dbPath = join(root, "btcc.sqlite");
  const stores = openBtccSqliteStores({
    dbPath,
    ownerId: "guided-route-contention",
    storageProfile: "ephemeral",
  });
  try {
    let journalCalls = 0;
    const turns = overrideModelRouteEvent(stores.turns, async (input) => {
      journalCalls += 1;
      if (journalCalls <= 2) throw sqliteBusyError();
      return stores.turns.recordModelRouteEvent(input);
    });
    let providerCalls = 0;
    const runtime = createGuidedTurnRuntime({
      admission: stores.admission,
      turns,
      messages: stores.messages,
      agent: {
        async run({ recordModelRouteEvent }) {
          await recordModelRouteEvent?.({
            type: "model.attempt.started",
            roundId: "contention-round",
            candidateIndex: 0,
            transportAttempt: 1,
            modelRef: "openai/gpt-5.6-sol",
          });
          providerCalls += 1;
          return { route: "direct", content: "after contention" };
        },
      },
    });
    const command = runCommand("guided-route-contention-turn");
    expect(await runtime.runTurn(command)).toMatchObject({
      kind: "delivered",
      content: "after contention",
    });
    expect(journalCalls).toBe(3);
    expect(providerCalls).toBe(1);
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM btcc_model_route_events WHERE turn_id = ?
      `).get(command.turnId)?.count).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Guided Turn retries transient acceptance contention without duplicating the accepted row", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-guided-acceptance-contention-"));
  const dbPath = join(root, "btcc.sqlite");
  const stores = openBtccSqliteStores({
    dbPath,
    ownerId: "guided-acceptance-contention",
    storageProfile: "ephemeral",
  });
  let acceptanceCalls = 0;
  const turns = overrideModelRoundAcceptance(stores.turns, async (input) => {
    acceptanceCalls += 1;
    if (acceptanceCalls === 1) throw sqliteBusyError();
    return stores.turns.recordModelRoundAcceptance(input);
  });
  let providerCalls = 0;
  const runtime = createGuidedTurnRuntime({
    admission: stores.admission,
    turns,
    messages: stores.messages,
    agent: {
      async run({ recordModelRouteEvent, recordModelRoundAcceptance }) {
        await recordModelRouteEvent?.({
          type: "model.attempt.started",
          roundId: "acceptance-contention-round",
          candidateIndex: 0,
          transportAttempt: 1,
          modelRef: "openai/gpt-5.6-sol",
        });
        providerCalls += 1;
        await recordModelRoundAcceptance?.({
          roundId: "acceptance-contention-round",
          candidateIndex: 0,
          transportAttempt: 1,
          modelRef: "openai/gpt-5.6-sol",
          result: { text: "accepted once", toolCalls: [] },
        });
        return { route: "direct", content: "accepted once" };
      },
    },
  });
  const command = runCommand("guided-acceptance-contention-turn");
  try {
    expect(await runtime.runTurn(command)).toMatchObject({
      kind: "delivered",
      content: "accepted once",
    });
    expect(acceptanceCalls).toBe(2);
    expect(providerCalls).toBe(1);
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM btcc_model_round_acceptances WHERE turn_id = ?
      `).get(command.turnId)?.count).toBe(1);
      expect(db.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM btcc_model_route_events WHERE turn_id = ?
      `).get(command.turnId)?.count).toBe(2);
    } finally {
      db.close();
    }
  } finally {
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Guided Turn exhausts bounded contention retries with the original cause", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-guided-route-contention-exhausted-"));
  const dbPath = join(root, "btcc.sqlite");
  const stores = openBtccSqliteStores({
    dbPath,
    ownerId: "guided-route-contention-exhausted",
    storageProfile: "ephemeral",
  });
  const cause = sqliteBusyError();
  let journalCalls = 0;
  const turns = overrideModelRouteEvent(stores.turns, async () => {
    journalCalls += 1;
    throw cause;
  });
  let providerCalls = 0;
  const runtime = createGuidedTurnRuntime({
    admission: stores.admission,
    turns,
    messages: stores.messages,
    agent: {
      async run({ recordModelRouteEvent }) {
        await recordModelRouteEvent?.({
          type: "model.attempt.started",
          roundId: "contention-exhausted-round",
          candidateIndex: 0,
          transportAttempt: 1,
          modelRef: "openai/gpt-5.6-sol",
        });
        providerCalls += 1;
        return { route: "direct", content: "unreachable" };
      },
    },
  });
  const command = runCommand("guided-route-contention-exhausted-turn");
  try {
    const failure = await runtime.runTurn(command).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "ModelRouteDurabilityError",
      code: "model_route_durability_failure",
      phase: "attempt_event_write",
    });
    expect((failure as Error).cause).toBe(cause);
    expect(journalCalls).toBe(3);
    expect(providerCalls).toBe(0);
    expect((await stores.turns.findTurn(command.turnId))?.semanticState).toBe("admitted");
  } finally {
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Guided Turn does not retry non-contention route integrity failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-guided-route-integrity-"));
  const stores = openBtccSqliteStores({
    dbPath: join(root, "btcc.sqlite"),
    ownerId: "guided-route-integrity",
    storageProfile: "ephemeral",
  });
  const cause = new Error("BTCC model route event lost exact Turn claim");
  let journalCalls = 0;
  const turns = overrideModelRouteEvent(stores.turns, async () => {
    journalCalls += 1;
    throw cause;
  });
  const runtime = createGuidedTurnRuntime({
    admission: stores.admission,
    turns,
    messages: stores.messages,
    agent: {
      async run({ recordModelRouteEvent }) {
        await recordModelRouteEvent?.({
          type: "model.attempt.started",
          roundId: "integrity-round",
          candidateIndex: 0,
          transportAttempt: 1,
          modelRef: "openai/gpt-5.6-sol",
        });
        return { route: "direct", content: "unreachable" };
      },
    },
  });
  const command = runCommand("guided-route-integrity-turn");
  try {
    const failure = await runtime.runTurn(command).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "ModelRouteDurabilityError",
      code: "model_route_durability_failure",
      phase: "attempt_event_write",
    });
    expect((failure as Error).cause).toBe(cause);
    expect(journalCalls).toBe(1);
  } finally {
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Guided Turn preserves an admitted Turn for acceptance and history faults before dispatch", async () => {
  for (const phase of ["response_acceptance_read", "attempt_history_read"] as const) {
    const root = mkdtempSync(join(tmpdir(), `btcc-guided-${phase}-`));
    const dbPath = join(root, "btcc.sqlite");
    const stores = openBtccSqliteStores({
      dbPath,
      ownerId: `guided-${phase}`,
      storageProfile: "ephemeral",
    });
    const turns: TurnStateRepository = {
      findTurn: (turnId) => stores.turns.findTurn(turnId),
      activateCommittedSuccessor: (turnId) => stores.turns.activateCommittedSuccessor(turnId),
      acquireStateExecutionClaim: (turn) => stores.turns.acquireStateExecutionClaim(turn),
      commitTransition: (input) => stores.turns.commitTransition(input),
      stopTurn: (turnId) => stores.turns.stopTurn(turnId),
      ...(phase === "response_acceptance_read"
        ? {
            loadModelRoundAcceptance: async () => {
              throw new Error("checkpoint read failed");
            },
          }
        : {
            loadModelRouteAttemptHistory: async () => {
              throw new Error("route history read failed");
            },
          }),
    };
    const runtime = createGuidedTurnRuntime({
      admission: stores.admission,
      turns,
      messages: stores.messages,
      agent: {
        async run(input) {
          if (phase === "response_acceptance_read") {
            await input.loadModelRoundAcceptance?.({
              roundId: "durability-round",
              candidateIndex: 0,
              modelRef: "openai/gpt-5.6-sol",
            });
          } else {
            await input.loadModelRouteAttemptHistory?.({
              roundId: "durability-round",
              candidateIndex: 0,
              modelRef: "openai/gpt-5.6-sol",
            });
          }
          return { route: "direct", content: "must not dispatch" };
        },
      },
    });
    const command = runCommand(`guided-${phase}-turn`);
    try {
      await expect(runtime.runTurn(command)).rejects.toMatchObject({
        name: "ModelRouteDurabilityError",
        code: "model_route_durability_failure",
        phase,
      });
      expect((await stores.turns.findTurn(command.turnId))?.semanticState).toBe("admitted");
      const db = new Database(dbPath, { readonly: true });
      try {
        expect(db.query<{ count: number }, []>(`
          SELECT COUNT(*) AS count FROM btcc_model_route_events
          WHERE turn_id = '${command.turnId}'
        `).get()?.count).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      stores.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("Guided Turn reclaims a route-durability interruption and dispatches exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-guided-route-recovery-"));
  const dbPath = join(root, "btcc.sqlite");
  const command = runCommand("guided-route-recovery-turn");
  command.modelSelection.modelRoute = buildModelRoute({
    primaryModelRef: "openai/gpt-5.6-sol",
    backupModelRefs: ["openai/gpt-5.6-luna"],
    reasoningEffort: "low",
    retryCeiling: 1,
    catalogGeneration: "route-recovery",
  });
  const firstStores = openBtccSqliteStores({
    dbPath,
    ownerId: "guided-route-recovery-first",
    storageProfile: "ephemeral",
  });
  const firstTurns: TurnStateRepository = {
    findTurn: (turnId) => firstStores.turns.findTurn(turnId),
    activateCommittedSuccessor: (turnId) => firstStores.turns.activateCommittedSuccessor(turnId),
    acquireStateExecutionClaim: (turn) => firstStores.turns.acquireStateExecutionClaim(turn),
    commitTransition: (input) => firstStores.turns.commitTransition(input),
    stopTurn: (turnId) => firstStores.turns.stopTurn(turnId),
    recordModelRouteEvent: async () => {
      throw new Error("route journal unavailable");
    },
  };
  const firstRuntime = createGuidedTurnRuntime({
    admission: firstStores.admission,
    turns: firstTurns,
    messages: firstStores.messages,
    agent: {
      async run({ recordModelRouteEvent }) {
        await recordModelRouteEvent?.({
          type: "model.attempt.started",
          roundId: "btcc-model-round-0",
          candidateIndex: 0,
          transportAttempt: 1,
          modelRef: "openai/gpt-5.6-sol",
        });
        throw new Error("unreachable");
      },
    },
  });
  await expect(firstRuntime.runTurn(command)).rejects.toMatchObject({
    name: "ModelRouteDurabilityError",
    phase: "attempt_event_write",
  });
  expect((await firstStores.turns.findTurn(command.turnId))?.semanticState).toBe("admitted");
  firstStores.close();

  const secondStores = openBtccSqliteStores({
    dbPath,
    ownerId: "guided-route-recovery-second",
    storageProfile: "ephemeral",
  });
  let providerCalls = 0;
  const secondRuntime = createGuidedTurnRuntime({
    admission: secondStores.admission,
    turns: secondStores.turns,
    messages: secondStores.messages,
    agent: {
      async run({ recordModelRouteEvent, recordModelRoundAcceptance }) {
        await recordModelRouteEvent?.({
          type: "model.attempt.started",
          roundId: "btcc-model-round-0",
          candidateIndex: 0,
          transportAttempt: 1,
          modelRef: "openai/gpt-5.6-sol",
        });
        providerCalls += 1;
        await recordModelRoundAcceptance?.({
          roundId: "btcc-model-round-0",
          candidateIndex: 0,
          transportAttempt: 1,
          modelRef: "openai/gpt-5.6-sol",
          result: { text: "recovered answer", toolCalls: [] },
        });
        return { route: "direct", content: "recovered answer" };
      },
    },
  });
  try {
    await expect(secondRuntime.runTurn(command)).resolves.toMatchObject({
      kind: "delivered",
      content: "recovered answer",
    });
    expect(providerCalls).toBe(1);
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM btcc_model_round_acceptances
        WHERE turn_id = 'guided-route-recovery-turn'
      `).get()?.count).toBe(1);
      expect(db.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM btcc_model_route_events
        WHERE turn_id = 'guided-route-recovery-turn'
      `).get()?.count).toBe(2);
    } finally {
      db.close();
    }
  } finally {
    secondStores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Guided Turn resumes a committed delivery without another model call", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-guided-delivery-resume-"));
  const dbPath = join(root, "btcc.sqlite");
  const command = runCommand("guided-delivery-resume-turn");
  const firstStores = openBtccSqliteStores({
    dbPath,
    ownerId: "guided-resume-first",
    storageProfile: "ephemeral",
  });
  let firstCalls = 0;
  const firstRuntime = createGuidedTurnRuntime({
    admission: firstStores.admission,
    turns: firstStores.turns,
    messages: {
      async insertCanonicalAssistantMessage() {
        throw new Error("simulated delivery interruption");
      },
    },
    agent: {
      async run() {
        firstCalls += 1;
        return { route: "direct", content: "persisted final" };
      },
    },
  });
  try {
    await expect(firstRuntime.runTurn(command)).rejects.toThrow("simulated delivery interruption");
    expect(firstCalls).toBe(1);
    expect((await firstStores.turns.findTurn(command.turnId))?.semanticState)
      .toBe("delivery_committed");
  } finally {
    firstStores.close();
  }

  const resumedStores = openBtccSqliteStores({
    dbPath,
    ownerId: "guided-resume-second",
    storageProfile: "ephemeral",
  });
  let resumedCalls = 0;
  const resumedRuntime = createGuidedTurnRuntime({
    admission: resumedStores.admission,
    turns: resumedStores.turns,
    messages: resumedStores.messages,
    agent: {
      async run() {
        resumedCalls += 1;
        throw new Error("model must not run after final commit");
      },
    },
  });
  try {
    expect(await resumedRuntime.runTurn({ kind: "resume", turnId: command.turnId }))
      .toMatchObject({ kind: "delivered", content: "persisted final" });
    expect(resumedCalls).toBe(0);
  } finally {
    resumedStores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Guided Turn recovers a crash after canonical insertion without a duplicate message", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-guided-delivery-insert-crash-"));
  const dbPath = join(root, "btcc.sqlite");
  const command = runCommand("guided-delivery-insert-crash-turn");
  const firstStores = openBtccSqliteStores({
    dbPath,
    ownerId: "guided-insert-crash-first",
    storageProfile: "ephemeral",
  });
  let inserted = false;
  const firstRuntime = createGuidedTurnRuntime({
    admission: firstStores.admission,
    turns: firstStores.turns,
    messages: {
      async insertCanonicalAssistantMessage(input) {
        const message = await firstStores.messages.insertCanonicalAssistantMessage(input);
        if (!inserted) {
          inserted = true;
          throw new Error("simulated crash after canonical insert");
        }
        return message;
      },
    },
    agent: {
      async run() {
        return { route: "direct", content: "one canonical answer" };
      },
    },
  });
  try {
    await expect(firstRuntime.runTurn(command))
      .rejects.toThrow("simulated crash after canonical insert");
    expect((await firstStores.turns.findTurn(command.turnId))?.semanticState)
      .toBe("delivery_committed");
  } finally {
    firstStores.close();
  }

  const resumedStores = openBtccSqliteStores({
    dbPath,
    ownerId: "guided-insert-crash-second",
    storageProfile: "ephemeral",
  });
  const resumedRuntime = createGuidedTurnRuntime({
    admission: resumedStores.admission,
    turns: resumedStores.turns,
    messages: resumedStores.messages,
    agent: {
      async run() {
        throw new Error("model must not rerun after delivery commit");
      },
    },
  });
  try {
    expect(await resumedRuntime.runTurn({ kind: "resume", turnId: command.turnId }))
      .toMatchObject({ kind: "delivered", content: "one canonical answer" });
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM btcc_messages
        WHERE turn_id = 'guided-delivery-insert-crash-turn' AND role = 'assistant'
      `).get()?.count).toBe(1);
      expect(db.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM btcc_canonical_deliveries
        WHERE turn_id = 'guided-delivery-insert-crash-turn'
      `).get()?.count).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    resumedStores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stop during committed delivery lets the immutable Outbox finish once", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-guided-stop-delivery-"));
  const dbPath = join(root, "btcc.sqlite");
  const stores = openBtccSqliteStores({
    dbPath,
    ownerId: "guided-stop-delivery",
    storageProfile: "ephemeral",
  });
  let releaseInserted!: () => void;
  let announceInserted!: () => void;
  const inserted = new Promise<void>((resolve) => { announceInserted = resolve; });
  const released = new Promise<void>((resolve) => { releaseInserted = resolve; });
  const runtime = createGuidedTurnRuntime({
    admission: stores.admission,
    turns: stores.turns,
    messages: {
      async insertCanonicalAssistantMessage(input) {
        const result = await stores.messages.insertCanonicalAssistantMessage(input);
        announceInserted();
        await released;
        return result;
      },
    },
    agent: {
      async run() {
        return { route: "direct", content: "committed before Stop" };
      },
    },
  });
  const command = runCommand("guided-stop-delivery-turn");
  try {
    const running = runtime.runTurn(command);
    await inserted;
    expect(await runtime.stopTurn({ kind: "stop", turnId: command.turnId }))
      .toEqual({ kind: "already_finalizing", turnId: command.turnId });
    releaseInserted();
    expect(await running).toMatchObject({
      kind: "delivered",
      content: "committed before Stop",
    });
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM btcc_messages
        WHERE turn_id = 'guided-stop-delivery-turn' AND role = 'assistant'
      `).get()?.count).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    releaseInserted();
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Guided Turn Stop aborts the model and durably cancels the Turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-guided-stop-"));
  const stores = openBtccSqliteStores({
    dbPath: join(root, "btcc.sqlite"),
    ownerId: "guided-stop",
    storageProfile: "ephemeral",
  });
  let releaseStarted!: () => void;
  const started = new Promise<void>((resolve) => { releaseStarted = resolve; });
  let observedAbort = false;
  const agent: GuidedTurnAgent = {
    async run({ signal }) {
      releaseStarted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          observedAbort = true;
          reject(new Error("aborted"));
        }, { once: true });
      });
      return { route: "direct", content: "unreachable" };
    },
  };
  const runtime = createGuidedTurnRuntime({
    admission: stores.admission,
    turns: stores.turns,
    messages: stores.messages,
    agent,
  });
  try {
    const command = runCommand("guided-stop-turn");
    const running = runtime.runTurn(command);
    await started;
    expect(await runtime.stopTurn({ kind: "stop", turnId: command.turnId }))
      .toEqual({ kind: "cancelled", turnId: command.turnId });
    expect(await running).toEqual({ kind: "cancelled", turnId: command.turnId });
    expect(observedAbort).toBe(true);
  } finally {
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function runCommand(turnId: string): Extract<BtccRunCommand, { kind: "run" }> {
  return {
    kind: "run",
    turnId,
    sessionId: "guided-session",
    triggerKey: `message:${turnId}`,
    message: { messageId: `message:${turnId}`, content: "안녕" },
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      controls: { accessMode: "full_access" },
      controlsHash: "controls",
    },
    context: {
      userRef: "local-user",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: ["workspace:/tmp"],
    },
  };
}

function overrideTransitionCommit(
  turns: TurnStateRepository,
  commitTransition: TurnStateRepository["commitTransition"],
): TurnStateRepository {
  return {
    findTurn: (turnId) => turns.findTurn(turnId),
    activateCommittedSuccessor: (turnId) => turns.activateCommittedSuccessor(turnId),
    acquireStateExecutionClaim: (turn) => turns.acquireStateExecutionClaim(turn),
    commitTransition,
    stopTurn: (turnId) => turns.stopTurn(turnId),
  };
}

function overrideModelRouteEvent(
  turns: TurnStateRepository,
  recordModelRouteEvent: NonNullable<TurnStateRepository["recordModelRouteEvent"]>,
): TurnStateRepository {
  return {
    findTurn: (turnId) => turns.findTurn(turnId),
    activateCommittedSuccessor: (turnId) => turns.activateCommittedSuccessor(turnId),
    acquireStateExecutionClaim: (turn) => turns.acquireStateExecutionClaim(turn),
    commitTransition: (input) => turns.commitTransition(input),
    stopTurn: (turnId) => turns.stopTurn(turnId),
    recordModelRouteEvent,
  };
}

function overrideModelRoundAcceptance(
  turns: TurnStateRepository,
  recordModelRoundAcceptance: NonNullable<TurnStateRepository["recordModelRoundAcceptance"]>,
): TurnStateRepository {
  return {
    findTurn: (turnId) => turns.findTurn(turnId),
    activateCommittedSuccessor: (turnId) => turns.activateCommittedSuccessor(turnId),
    acquireStateExecutionClaim: (turn) => turns.acquireStateExecutionClaim(turn),
    commitTransition: (input) => turns.commitTransition(input),
    stopTurn: (turnId) => turns.stopTurn(turnId),
    ...(turns.recordModelRouteEvent
      ? { recordModelRouteEvent: turns.recordModelRouteEvent.bind(turns) }
      : {}),
    ...(turns.loadModelRoundAcceptance
      ? { loadModelRoundAcceptance: turns.loadModelRoundAcceptance.bind(turns) }
      : {}),
    recordModelRoundAcceptance,
  };
}

function sqliteBusyError(): Error & { code: string; errno: number } {
  return Object.assign(new Error("database is locked"), {
    name: "SQLiteError",
    code: "SQLITE_BUSY",
    errno: 5,
  });
}
