import { isSqliteContention } from "../../../foundation/sqlite-contention.ts";
import type { BtccRuntimeDependencies } from "../contracts.ts";
import type { ExecutionPermit } from "../recovery/index.ts";
import type { TurnRecord, TurnSemanticState } from "./contracts.ts";
import { publishOperationalNotice } from "./turn-progress.ts";

export async function activateCommittedSuccessor(input: {
  turnId: string;
  expectedState: TurnSemanticState;
  dependencies: BtccRuntimeDependencies;
  permit: ExecutionPermit;
}): Promise<TurnRecord> {
  let recoveringStorage = false;

  while (true) {
    input.permit.assertActive();
    try {
      const successor = await input.dependencies.turns.activateCommittedSuccessor(
        input.turnId,
      );
      if (recoveringStorage) await publishStorageNotice(input, "cleared");
      return successor;
    } catch (error) {
      if (
        !isSqliteContention(error) ||
        !input.dependencies.committedSuccessorReadiness
      ) {
        throw error;
      }
      if (!recoveringStorage) {
        recoveringStorage = true;
        await publishStorageNotice(input, "recovering");
      }
      await input.dependencies.committedSuccessorReadiness
        .waitForStorageReadiness(input.permit.signal);
    }
  }
}

function publishStorageNotice(
  input: {
    turnId: string;
    expectedState: TurnSemanticState;
    dependencies: BtccRuntimeDependencies;
  },
  status: "recovering" | "cleared",
): Promise<void> {
  return publishOperationalNotice(input.dependencies.progress, {
    turnId: input.turnId,
    semanticState: input.expectedState,
    status,
    code: "sqlite_write_contention",
    activationKind: "automatic_storage_recovery",
  });
}
