import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBtccComposition } from "../../packages/butler-agent/src/agent/composition/index.ts";
import { stopTurn } from "../../packages/butler-agent/src/agent/btcc/turn/stop-turn.ts";
import { DirectHarnessModel } from "../../packages/butler-agent/src/interfaces/btcc-harness/direct-harness-model.ts";
import type {
  BtccRuntimeDependencies,
  BtccTurnCommand,
} from "../../packages/butler-agent/src/agent/btcc/index.ts";
import type { TurnExecutionSupervisor } from "../../packages/butler-agent/src/agent/btcc/recovery/index.ts";
import type { TurnStateRepository } from "../../packages/butler-agent/src/agent/btcc/turn/index.ts";

type SelectedModel = BtccRuntimeDependencies["model"];

test("Stop aborts the active model owner and converges run plus repeat Stop", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "butler-btcc-stop-"));
  try {
    const model = new BlockingModel();
    const dbPath = join(dataRoot, "btcc.sqlite");
    const runtime = createBtccComposition({
      dbPath,
      ownerId: "btcc-stop-test",
      model,
      operations: neverOperations(),
      artifacts: neverArtifacts(),
    });
    const command = runCommand();
    const running = runtime.handle(command);
    await model.started;
    const concurrentReplay = runtime.handle(command);

    const stopped = await runtime.handle({ kind: "stop", turnId: command.turnId });
    const runningOutcome = await running;
    const replayOutcome = await concurrentReplay;
    const repeated = await runtime.handle({ kind: "stop", turnId: command.turnId });

    expect(stopped).toEqual({ kind: "cancelled", turnId: command.turnId });
    expect(runningOutcome).toEqual({ kind: "cancelled", turnId: command.turnId });
    expect(replayOutcome).toEqual(runningOutcome);
    expect(repeated).toEqual({ kind: "already_cancelled", turnId: command.turnId });
    expect(model.signalWasAborted).toBe(true);
    expect(model.callCount).toBe(1);

    const db = new Database(dbPath, { readonly: true });
    try {
      const turn = db.query<{
        semantic_state: string;
        final_disposition: string;
        execution_fence: number;
      }, []>(`
        SELECT semantic_state, final_disposition, execution_fence FROM btcc_turns
      `).get();
      const claims = db.query<{ status: string }, []>(`
        SELECT status FROM btcc_state_claims ORDER BY rowid
      `).all();
      const stopRequests = db.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM btcc_stop_requests
      `).get();
      expect(turn).toEqual({
        semantic_state: "cancelled",
        final_disposition: "cancelled",
        execution_fence: 1,
      });
      expect(claims.at(-1)?.status).toBe("revoked");
      expect(stopRequests?.count).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("Stop has one explicit outcome for every semantic state", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "butler-btcc-stop-states-"));
  const dbPath = join(dataRoot, "btcc.sqlite");
  try {
    const seedRuntime = runtimeFor(dbPath, new DirectHarnessModel(), "seed-owner");
    const command = { ...runCommand(), turnId: "turn-stop-state-table" };
    const delivered = await seedRuntime.handle(command);
    expect(delivered.kind).toBe("delivered");

    const cancellableStates = [
      "admitted", "conception_opening", "conception_deliberation", "contract_review",
      "planning", "planning_review", "work_frontier", "task_execution", "task_review",
      "feedback_conception", "feedback_planning", "feedback_planning_review",
      "consolidation", "reporting",
    ];
    for (const [index, state] of cancellableStates.entries()) {
      resetTurn(dbPath, command.turnId, state);
      const runtime = runtimeFor(dbPath, new DirectHarnessModel(), `state-owner:${index}`);
      expect(await runtime.handle({ kind: "stop", turnId: command.turnId })).toEqual({
        kind: "cancelled",
        turnId: command.turnId,
      });
    }

    resetTurn(dbPath, command.turnId, "delivery_committed");
    setDeliveryOutboxStatus(dbPath, command.turnId, "inserted");
    const finalizingRuntime = runtimeFor(dbPath, new DirectHarnessModel(), "finalizing-owner");
    expect(await finalizingRuntime.handle({ kind: "stop", turnId: command.turnId })).toEqual({
      kind: "already_finalizing",
      turnId: command.turnId,
    });
    const finalized = await finalizingRuntime.handle(command);
    expect(finalized.kind).toBe("delivered");

    resetTurn(dbPath, command.turnId, "delivered", "completed");
    const deliveredRuntime = runtimeFor(dbPath, new DirectHarnessModel(), "delivered-owner");
    expect((await deliveredRuntime.handle({ kind: "stop", turnId: command.turnId })).kind)
      .toBe("already_delivered");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("Stop keeps the in-memory fence when durable persistence is unavailable", async () => {
  const installed: string[] = [];
  const supervisor: TurnExecutionSupervisor = {
    enter() { throw new Error("not used"); },
    installStop(turnId) { installed.push(turnId); },
    allowFinalizing() { throw new Error("not used"); },
  };
  const turns: TurnStateRepository = {
    async findTurn() { return null; },
    async activateCommittedSuccessor() { throw new Error("not used"); },
    async acquireStateExecutionClaim() { throw new Error("not used"); },
    async commitTransition() { throw new Error("not used"); },
    async stopTurn() { throw new Error("storage unavailable"); },
  };

  const outcome = await stopTurn({ kind: "stop", turnId: "turn-fence-only" }, turns, supervisor);

  expect(installed).toEqual(["turn-fence-only"]);
  expect(outcome).toEqual({
    kind: "fenced_pending_persistence",
    turnId: "turn-fence-only",
  });
});

test("one runtime owns a persisted state while a concurrent runtime is excluded", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "butler-btcc-owner-"));
  try {
    const dbPath = join(dataRoot, "btcc.sqlite");
    const owner = new DelayedDirectModel();
    const firstRuntime = runtimeFor(dbPath, owner, "first-owner");
    const secondRuntime = runtimeFor(dbPath, new DirectHarnessModel(), "second-owner");
    const command = { ...runCommand(), turnId: "turn-concurrent-owner" };

    const first = firstRuntime.handle(command);
    await owner.started;
    await expect(secondRuntime.handle(command)).rejects.toThrow(
      "BTCC state is actively owned by another live runtime",
    );
    owner.release();
    expect((await first).kind).toBe("delivered");

    const db = new Database(dbPath, { readonly: true });
    try {
      const activeClaims = db.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM btcc_state_claims WHERE status = 'active'
      `).get();
      const deliveries = db.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM btcc_canonical_deliveries
      `).get();
      expect(activeClaims?.count).toBe(0);
      expect(deliveries?.count).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

class BlockingModel implements SelectedModel {
  callCount = 0;
  signalWasAborted = false;
  private markStarted!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });

  async runRound(
    _envelope: Parameters<BtccRuntimeDependencies["model"]["runRound"]>[0],
    signal?: AbortSignal,
  ): ReturnType<BtccRuntimeDependencies["model"]["runRound"]> {
    this.callCount += 1;
    this.markStarted();
    await new Promise<void>((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        this.signalWasAborted = true;
        reject(new Error("model request aborted by Stop"));
      }, { once: true });
    });
    throw new Error("unreachable model completion");
  }
}

class DelayedDirectModel implements SelectedModel {
  private readonly delegate = new DirectHarnessModel();
  private markStarted!: () => void;
  private continueRound!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });
  private readonly released = new Promise<void>((resolve) => {
    this.continueRound = resolve;
  });

  release(): void {
    this.continueRound();
  }

  async runRound(
    envelope: Parameters<SelectedModel["runRound"]>[0],
    signal?: AbortSignal,
  ): ReturnType<SelectedModel["runRound"]> {
    this.markStarted();
    await this.released;
    if (signal?.aborted) throw new Error("delayed model aborted");
    return this.delegate.runRound(envelope);
  }
}

function runCommand(): Extract<BtccTurnCommand, { kind: "run" }> {
  const controls = { reasoningEffort: "low" as const };
  return {
    kind: "run",
    turnId: "turn-stop-active-model",
    sessionId: "session-stop",
    triggerKey: "message:stop-test",
    message: { messageId: "message-stop-test", content: "멈출 수 있는 작업을 시작해줘" },
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      controls,
      controlsHash: digest(JSON.stringify(controls)),
    },
    context: {
      userRef: "user:stop-test",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: [],
    },
  };
}

function neverOperations(): BtccRuntimeDependencies["operations"] {
  return { async perform() { throw new Error("Stop test must not execute an operation"); } };
}

function neverArtifacts(): BtccRuntimeDependencies["artifacts"] {
  return {
    async acquireProgramWorkspace() {
      throw new Error("Stop test must not acquire an artifact workspace");
    },
  };
}

function runtimeFor(
  dbPath: string,
  model: SelectedModel,
  ownerId: string,
) {
  return createBtccComposition({
    dbPath,
    ownerId,
    model,
    operations: neverOperations(),
    artifacts: neverArtifacts(),
  });
}

function resetTurn(
  dbPath: string,
  turnId: string,
  semanticState: string,
  finalDisposition: string | null = null,
): void {
  const db = new Database(dbPath);
  try {
    const current = db.query<{ revision: number }, [string]>(
      "SELECT revision FROM btcc_turns WHERE turn_id = ?",
    ).get(turnId);
    if (!current) throw new Error(`Stop test Turn is missing: ${turnId}`);
    const revision = current.revision + 1;
    const terminal = semanticState === "delivered" || semanticState === "cancelled";
    const checkpointId = terminal
      ? null
      : digest(`btcc-checkpoint.v1\0${turnId}\0${revision}\0${semanticState}`);
    db.query("DELETE FROM btcc_stop_requests WHERE turn_id = ?").run(turnId);
    db.query("UPDATE btcc_checkpoints SET is_active = 0 WHERE turn_id = ?").run(turnId);
    if (checkpointId) {
      const runtimeStates = ["admitted", "work_frontier", "delivery_committed"];
      db.query(`
        INSERT INTO btcc_checkpoints (
          checkpoint_id, turn_id, turn_revision, semantic_state, kind,
          checkpoint_revision, is_active
        ) VALUES (?, ?, ?, ?, ?, 1, 1)
      `).run(
        checkpointId,
        turnId,
        revision,
        semanticState,
        runtimeStates.includes(semanticState) ? "runtime" : "phase",
      );
    }
    db.query(`
      UPDATE btcc_turns SET semantic_state = ?, active_checkpoint_id = ?,
        final_disposition = ?, revision = ?, execution_fence = execution_fence + 1
      WHERE turn_id = ?
    `).run(semanticState, checkpointId, finalDisposition, revision, turnId);
  } finally {
    db.close();
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function setDeliveryOutboxStatus(
  dbPath: string,
  turnId: string,
  status: "pending" | "inserted" | "observed",
): void {
  const db = new Database(dbPath);
  try {
    db.query(`
      UPDATE btcc_delivery_outbox SET status = ? WHERE turn_id = ?
    `).run(status, turnId);
  } finally {
    db.close();
  }
}
