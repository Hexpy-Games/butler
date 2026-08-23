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
  parentAccessMode: "full_access" | "ask_first" | "read_only",
): Record<string, unknown> {
  return service
    ? {
        subsessionDelegation: service,
        anchorMessageId: turn.originalMessageId,
        modelRef: `${turn.modelSelection.provider}/${turn.modelSelection.model}`,
        reasoningEffort: turn.modelSelection.reasoningEffort,
        parentAccessMode,
        ...(turn.context.executionPolicy?.subsession
          ? { subsessionMutationScope: turn.context.executionPolicy.subsession.mutationScope }
          : {}),
      }
    : {};
}

export function stewardSafeBoundary(input: {
  service?: SubsessionDelegationService;
  turn: TurnRecord;
}): (() => Promise<string | undefined>) | undefined {
  if (!input.service || input.turn.context.executionPolicy?.role !== "steward") return undefined;
  return async () => {
    const direction = await input.service!.consumeStewardDirection({
      childSessionId: input.turn.sessionId,
      childTurnId: input.turn.turnId,
    });
    if (!direction) return undefined;
    return [
      "Butler direction update. Apply this at the next safe boundary without changing the immutable delegation packet, authority, workspace, or Work identity.",
      `Direction revision: ${direction.revision}`,
      `Instruction: ${direction.instruction}`,
      "Continue the same Work and record truthful progress, review, validation, and terminal evidence.",
    ].join("\n");
  };
}
