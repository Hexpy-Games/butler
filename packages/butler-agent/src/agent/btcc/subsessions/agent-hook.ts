import type { TurnRecord } from "../turn/index.ts";
import type { SubsessionDelegationService } from "./contracts.ts";

export async function ensureSubsessionChildRootWork(input: {
  service: SubsessionDelegationService;
  turn: TurnRecord;
}): Promise<void> {
  await input.service.ensureChildRootWork({
    childSessionId: input.turn.sessionId,
    childTurnId: input.turn.turnId,
    objective: input.turn.originalMessage.split("\n")
      .find((line) => line.startsWith("objective: "))
      ?.slice("objective: ".length) ?? "Complete the bounded Steward task.",
  });
}

export function subsessionToolInput(
  service: SubsessionDelegationService | undefined,
  turn: TurnRecord,
): Record<string, unknown> {
  return service
    ? {
        subsessionDelegation: service,
        anchorMessageId: turn.originalMessageId,
        modelRef: `${turn.modelSelection.provider}/${turn.modelSelection.model}`,
        reasoningEffort: turn.modelSelection.reasoningEffort,
        ...(turn.context.executionPolicy?.subsession
          ? {
              subsessionMutationScope: turn.context.executionPolicy.subsession.mutationScope,
              subsessionAllowedToolsAndEffects: turn.context.executionPolicy.subsession.allowedToolsAndEffects,
            }
          : {}),
      }
    : {};
}
