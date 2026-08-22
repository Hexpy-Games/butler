import type { ModelRoundPort } from "../ports/model-round.ts";
import type { BtccAgentLoopInput } from "./contracts.ts";

export function withStewardDirection(input: {
  modelRound: ModelRoundPort;
  safeBoundary?: () => Promise<string | undefined>;
  reviewFinalCandidate: NonNullable<BtccAgentLoopInput["reviewFinalCandidate"]>;
}): {
  modelRound: ModelRoundPort;
  reviewFinalCandidate: NonNullable<BtccAgentLoopInput["reviewFinalCandidate"]>;
} {
  if (!input.safeBoundary) return input;
  const carriedDirections: string[] = [];
  return {
    modelRound: {
      ...input.modelRound,
      async runRound(request) {
        const observation = (await input.safeBoundary!())?.trim();
        if (observation) carriedDirections.push(observation);
        return input.modelRound.runRound(carriedDirections.length > 0
          ? { ...request, messages: [...request.messages, ...carriedDirections.map((content) => ({ role: "user" as const, content }))] }
          : request);
      },
    },
    reviewFinalCandidate: async (candidate) => {
      const observation = (await input.safeBoundary!())?.trim();
      return observation
        ? { status: "continue" as const, observation }
        : input.reviewFinalCandidate(candidate);
    },
  };
}
