import { cancelActiveWorkStreamBestEffort } from "./native/turn-runner/workstream-finalizers.ts";
import {
  clearTurnContextAtom,
  turnContextAtomsForTurn,
} from "./turn-continuation-context.ts";
import { TurnContractStore } from "./turn-contract-store.ts";
import { WorkStreamStore } from "../work/work-stream.ts";
import { WorkStreamClaimStore } from "../work/work-stream-claim-store.ts";
import { recordPrincipalTurnCancellation } from "./principal-turn-cancellation-registry.ts";

export function cancelPersistedRuntimeTurn(input: {
  butlerData: string;
  turnId: string;
}): void {
  recordPrincipalTurnCancellation(input);
  const contracts = new TurnContractStore(input.butlerData);
  const atoms = turnContextAtomsForTurn(input);
  const streams = new WorkStreamStore(input.butlerData, { autoRecover: false })
    .recordsForTurn(input.turnId);
  const contractIds = new Set([
    ...atoms.flatMap((atom) => atom.contractId ? [atom.contractId] : []),
    ...streams.flatMap((stream) => stream.active_contract_id ? [stream.active_contract_id] : []),
  ]);
  const claims = new WorkStreamClaimStore(input.butlerData);
  for (const stream of streams) {
    if (!stream.active_contract_id) continue;
    claims.cancelByPrincipalTurn({
      workstreamId: stream.id,
      contractId: stream.active_contract_id,
      turnId: input.turnId,
      expectedGeneration: stream.record_generation ?? 1,
    });
  }
  for (const contractId of contractIds) {
    try {
      contracts.recordPrincipalTurnCancellation({
        contractId,
        turnId: input.turnId,
      });
    } catch {
      // App cancellation must still clear the retry path if contract storage is damaged.
    }
  }
  const sessionIds = new Set([
    ...atoms.map((atom) => atom.sessionId),
    ...streams.flatMap((stream) => stream.owner_session_id ? [stream.owner_session_id] : []),
  ]);
  for (const sessionId of sessionIds) {
    cancelActiveWorkStreamBestEffort({
      butlerData: input.butlerData,
      sessionId,
      turnId: input.turnId,
    });
  }
  for (const atom of atoms) {
    clearTurnContextAtom({
      butlerData: input.butlerData,
      sessionId: atom.sessionId,
      turnId: input.turnId,
    });
  }
}
