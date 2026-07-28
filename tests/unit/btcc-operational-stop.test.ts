import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBtccComposition } from
  "../../packages/butler-agent/src/agent/composition/index.ts";
import type {
  BtccRuntimeDependencies,
  BtccTurnCommand,
} from "../../packages/butler-agent/src/agent/btcc/index.ts";

type SelectedModel = BtccRuntimeDependencies["model"];

test("Stop aborts an operational recovery wait without failing the Turn", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "butler-btcc-recovery-stop-"));
  const dbPath = join(dataRoot, "btcc.sqlite");
  const model = new ActionRequiredModel();
  const runtime = createBtccComposition({
    dbPath,
    ownerId: "btcc-recovery-stop-test",
    model,
    operations: neverOperations(),
    artifacts: neverArtifacts(),
    storageProfile: "ephemeral",
  });
  try {
    const command = runCommand();
    const running = runtime.runTurn(command);
    await model.started;
    await waitForRecoveryRecord(dbPath);

    expect(await runtime.stopTurn({ kind: "stop", turnId: command.turnId })).toEqual({
      kind: "cancelled",
      turnId: command.turnId,
    });
    expect(await running).toEqual({ kind: "cancelled", turnId: command.turnId });
    expect(readRecoveryStatus(dbPath)).toBe("interrupted");
  } finally {
    await runtime.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

class ActionRequiredModel implements SelectedModel {
  private markStarted!: () => void;
  readonly started = new Promise<void>((resolve) => { this.markStarted = resolve; });

  async runRound(): ReturnType<SelectedModel["runRound"]> {
    this.markStarted();
    return {
      kind: "interruption",
      code: "provider_auth_error",
      activation: { kind: "provider_action_required" },
    };
  }
}

function runCommand(): Extract<BtccTurnCommand, { kind: "run" }> {
  const controls = { reasoningEffort: "low" as const };
  return {
    kind: "run",
    turnId: "turn-stop-recovery",
    sessionId: "session-stop-recovery",
    triggerKey: "message:stop-recovery",
    message: { messageId: "message-stop-recovery", content: "작업을 시작해줘" },
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      controls,
      controlsHash: createHash("sha256").update(JSON.stringify(controls)).digest("hex"),
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

async function waitForRecoveryRecord(dbPath: string): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (readRecoveryStatus(dbPath)) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for an operational recovery record");
}

function readRecoveryStatus(dbPath: string): string | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<{ status: string }, []>(`
      SELECT status FROM btcc_operational_interruptions
    `).get()?.status ?? null;
  } finally {
    db.close();
  }
}

function neverOperations(): BtccRuntimeDependencies["operations"] {
  return { async perform() { throw new Error("operations must not run"); } };
}

function neverArtifacts(): BtccRuntimeDependencies["artifacts"] {
  return {
    async acquireProgramWorkspace() { throw new Error("artifacts must not run"); },
  };
}
