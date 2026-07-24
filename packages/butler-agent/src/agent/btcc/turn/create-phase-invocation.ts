import type { BtccRuntimeDependencies } from "../contracts.ts";
import type { PhaseInvocation } from "../core/index.ts";
import type { StateExecutionClaim, TurnRecord } from "./contracts.ts";
import type { ExecutionPermit } from "../recovery/index.ts";
import type { ProviderCorrection } from "../core/index.ts";

export function createPhaseInvocation(
  turn: TurnRecord,
  claim: StateExecutionClaim,
  dependencies: BtccRuntimeDependencies,
  executionPermit: ExecutionPermit,
  providerCorrection?: ProviderCorrection,
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
      sessionId: turn.sessionId,
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
    ...(dependencies.progress?.phaseActivityChanged ||
        dependencies.progress?.modelRoundWaiting
      ? {
          activity: {
            publish: (update) => dependencies.progress?.phaseActivityChanged?.({
              turnId: update.turnId,
              semanticState: update.semanticState,
              ...update.activity,
            }),
            modelRoundWaiting: (update) =>
              dependencies.progress?.modelRoundWaiting?.(update),
          },
        }
      : {}),
    ...(providerCorrection ? { providerCorrection } : {}),
  };
}
