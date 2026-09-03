import type { ModelRoundPort } from "../ports/model-round.ts";
import type { BtccAgentLoopInput } from "./contracts.ts";

export function withStewardDirection(input: {
  modelRound: ModelRoundPort;
  safeBoundary?: () => Promise<string | undefined>;
  reviewFinalCandidate: NonNullable<BtccAgentLoopInput["reviewFinalCandidate"]>;
  afterToolBatch: NonNullable<BtccAgentLoopInput["afterToolBatch"]>;
}): {
  modelRound: ModelRoundPort;
  beforeModelRound?: BtccAgentLoopInput["beforeModelRound"];
  reviewFinalCandidate: NonNullable<BtccAgentLoopInput["reviewFinalCandidate"]>;
  afterToolBatch: NonNullable<BtccAgentLoopInput["afterToolBatch"]>;
} {
  if (!input.safeBoundary) return input;
  const pendingDirections: string[] = [];
  return {
    modelRound: input.modelRound,
    beforeModelRound: async () => {
      const observation = (await input.safeBoundary!())?.trim();
      if (observation) pendingDirections.push(observation);
      return pendingDirections.splice(0);
    },
    reviewFinalCandidate: async (candidate) => {
      const observation = (await input.safeBoundary!())?.trim();
      if (observation) {
        pendingDirections.push(observation);
        return { status: "continue" as const, observation: "A new user direction is available for the next model round." };
      }
      return input.reviewFinalCandidate(candidate);
    },
    afterToolBatch: async (batch) => {
      const disposition = await input.afterToolBatch(batch);
      if (disposition !== "wait") return disposition;
      const observation = (await input.safeBoundary!())?.trim();
      if (!observation) return "wait";
      pendingDirections.push(observation);
      return "continue";
    },
  };
}
