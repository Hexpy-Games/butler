import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BtccRunCommand } from
  "../../packages/butler-agent/src/agent/btcc/index.ts";
import type { TurnStateRepository } from
  "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import {
  createGuidedTurnRuntime,
  type GuidedTurnAgent,
} from "../../packages/butler-agent/src/agent/btcc/guided-turn/index.ts";
import { openBtccSqliteStores } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";

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
    expect(states).toEqual(["delivery_committed", "delivered", "delivered"]);

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
        throw new Error("provider disconnected before final answer");
      },
    },
  });
  try {
    expect(await runtime.runTurn(runCommand("guided-provider-failure-turn")))
      .toMatchObject({
        kind: "delivered",
        content: "요청을 처리하는 중 일시적인 문제가 발생했습니다. 작업은 안전하게 중단되었으며, 다시 요청해 주시면 이어서 처리하겠습니다.",
      });
  } finally {
    stores.close();
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
