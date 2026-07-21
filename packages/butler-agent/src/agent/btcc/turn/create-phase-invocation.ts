import type { BtccRuntimeDependencies } from "../contracts.ts";
import type { PhaseInvocation } from "../core/index.ts";
import type { StateExecutionClaim, TurnRecord } from "./contracts.ts";
import type { ExecutionPermit } from "../recovery/index.ts";

export function createPhaseInvocation(
  turn: TurnRecord,
  claim: StateExecutionClaim,
  dependencies: BtccRuntimeDependencies,
  executionPermit: ExecutionPermit,
): PhaseInvocation {
  return {
    binding: {
      turnId: turn.turnId,
      turnRevision: turn.revision,
      semanticState: claim.semanticState as PhaseInvocation["binding"]["semanticState"],
      checkpointId: claim.checkpointId,
      checkpointRevision: claim.checkpointRevision,
      claimId: claim.claimId,
      executionFence: claim.executionFence,
    },
    modelSelection: turn.modelSelection,
    context: {
      originalMessageId: turn.originalMessageId,
      originalMessage: turn.originalMessage,
      ...turn.context,
      continuationCandidates: turn.continuationCandidates,
    },
    store: dependencies.phaseConversations,
    model: dependencies.model,
    operations: dependencies.operations,
    operationAuthority: {
      observationScopeRefs: turn.context.baselineObservationScopeRefs,
      mutation: { kind: "forbidden" },
    },
    executionPermit,
  };
}
