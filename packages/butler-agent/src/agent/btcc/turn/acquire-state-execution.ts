import { isSqliteContention } from "../../../foundation/sqlite-contention.ts";
import type { BtccTurnProgressObserver } from "../contracts.ts";
import type { ExecutionPermit } from "../recovery/index.ts";
import type { StateExecutionClaim, TurnRecord } from "./contracts.ts";
import { publishOperationalNotice } from "./turn-progress.ts";

import type { CommittedSuccessorReadiness } from "../recovery/contracts.ts";
import type { TurnStateRepository } from "./contracts.ts";

type StateClaimDependencies = {
  turns: TurnStateRepository;
  committedSuccessorReadiness?: CommittedSuccessorReadiness;
  progress?: BtccTurnProgressObserver;
};

export async function acquireStateExecution(
  turn: TurnRecord,
  dependencies: StateClaimDependencies,
  permit: ExecutionPermit,
): Promise<StateExecutionClaim> {
  let recoveringStorage = false;

  while (true) {
    permit.assertActive();
    try {
      const claim = await dependencies.turns.acquireStateExecutionClaim(turn);
      if (recoveringStorage)
        await publishStorageNotice(turn, dependencies, "cleared");
      return claim;
    } catch (error) {
      if (
        !isSqliteContention(error) ||
        !dependencies.committedSuccessorReadiness
      ) {
        throw error;
      }
      if (!recoveringStorage) {
        recoveringStorage = true;
        await publishStorageNotice(turn, dependencies, "recovering");
      }
      await dependencies.committedSuccessorReadiness.waitForStorageReadiness(
        permit.signal,
      );
    }
  }
}

function publishStorageNotice(
  turn: TurnRecord,
  dependencies: StateClaimDependencies,
  status: "recovering" | "cleared",
): Promise<void> {
  return publishOperationalNotice(dependencies.progress, {
    turnId: turn.turnId,
    semanticState: turn.semanticState,
    status,
    code: "sqlite_write_contention",
    activationKind: "automatic_storage_recovery",
  });
}
