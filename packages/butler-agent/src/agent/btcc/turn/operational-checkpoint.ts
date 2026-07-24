import type { BtccRuntimeDependencies } from "../contracts.ts";
import {
  type ExecutionPermit,
  type OperationalCheckpointAnchor,
  type OperationalInterruptionError,
} from "../recovery/index.ts";
import type {
  StateExecutionClaim,
  TurnRecord,
} from "./contracts.ts";
import { publishOperationalNotice } from "./turn-progress.ts";

export function currentCheckpointBinding(
  claim: StateExecutionClaim,
): OperationalCheckpointAnchor {
  return {
    turnId: claim.turnId,
    turnRevision: claim.turnRevision,
    semanticState: claim.semanticState,
    checkpointId: claim.checkpointId,
    checkpointRevision: claim.checkpointRevision,
    claimId: claim.claimId,
    executionFence: claim.executionFence,
  };
}

export async function recoverPersistedInterruption(
  dependencies: BtccRuntimeDependencies,
  anchor: OperationalCheckpointAnchor,
  permit: ExecutionPermit,
): Promise<OperationalInterruptionError | null> {
  const record = await dependencies.operationalRecovery?.pending(anchor);
  if (!record) return null;
  if (record.status === "interrupted") {
    await waitForOperationalReentry(dependencies, record.interruption, permit);
  } else {
    await publishOperationalNotice(dependencies.progress, {
      turnId: anchor.turnId,
      semanticState: anchor.semanticState,
      status: "cleared",
      code: record.interruption.code,
      activationKind: record.interruption.activation.kind,
    });
  }
  permit.assertActive();
  return record.interruption;
}

export async function waitForOperationalReentry(
  dependencies: BtccRuntimeDependencies,
  interruption: OperationalInterruptionError,
  permit: ExecutionPermit,
): Promise<void> {
  await publishOperationalNotice(dependencies.progress, {
    turnId: interruption.anchor.turnId,
    semanticState: interruption.anchor.semanticState,
    status: "recovering",
    code: interruption.code,
    activationKind: interruption.activation.kind,
  });
  await dependencies.operationalRecovery?.awaitReentry(
    interruption,
    permit.signal,
  );
  await publishOperationalNotice(dependencies.progress, {
    turnId: interruption.anchor.turnId,
    semanticState: interruption.anchor.semanticState,
    status: "cleared",
    code: interruption.code,
    activationKind: interruption.activation.kind,
  });
  const turn = await dependencies.turns.findTurn(interruption.anchor.turnId);
  if (turn && !isTerminal(turn)) {
    assertSameOperationalCheckpoint(turn, interruption.anchor);
  }
}

export async function resolveOperationalInterruption(
  dependencies: BtccRuntimeDependencies,
  anchor: OperationalCheckpointAnchor,
): Promise<void> {
  if (!dependencies.operationalRecovery) return;
  try {
    const resolved = await dependencies.operationalRecovery.resolve(anchor);
    if (resolved) {
      await publishOperationalNotice(dependencies.progress, {
        turnId: anchor.turnId,
        semanticState: anchor.semanticState,
        status: "cleared",
      });
    }
  } catch {
    // A consumed claim prevents stale interruption records from reactivating.
  }
}

function assertSameOperationalCheckpoint(
  turn: TurnRecord,
  anchor: OperationalCheckpointAnchor,
): void {
  const checkpoint = turn.checkpoint;
  if (
    turn.turnId !== anchor.turnId ||
    turn.revision !== anchor.turnRevision ||
    turn.semanticState !== anchor.semanticState ||
    turn.executionFence !== anchor.executionFence ||
    checkpoint?.checkpointId !== anchor.checkpointId ||
    checkpoint.checkpointRevision !== anchor.checkpointRevision
  ) {
    throw new Error("BTCC operational recovery lost its exact checkpoint binding");
  }
}

function isTerminal(turn: TurnRecord): boolean {
  return turn.semanticState === "delivered" || turn.semanticState === "cancelled";
}
