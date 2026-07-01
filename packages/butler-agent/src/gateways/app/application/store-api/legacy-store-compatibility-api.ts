import type { AppStoreKernel } from "../kernel/app-store-kernel.ts";

type EventSequenceMaps = {
  sessionTurnEventSequences: Map<string, number>;
  turnEventSequences: Map<string, number>;
};

export function createLegacyStoreCompatibilityApi(kernel: AppStoreKernel): {
  insertTurn: AppStoreKernel["insertTurn"];
  updateTurnState: AppStoreKernel["updateTurnState"];
  insertMessage: AppStoreKernel["insertMessage"];
  sessionTurnEventSequences: Map<string, number>;
  turnEventSequences: Map<string, number>;
} {
  const eventSequences = kernel.events as unknown as EventSequenceMaps;
  return {
    insertTurn: kernel.insertTurn,
    updateTurnState: kernel.updateTurnState,
    insertMessage: kernel.insertMessage,
    sessionTurnEventSequences: eventSequences.sessionTurnEventSequences,
    turnEventSequences: eventSequences.turnEventSequences,
  };
}
