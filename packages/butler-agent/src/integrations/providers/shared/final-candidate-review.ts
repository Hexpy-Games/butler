import type {
  FunctionToolPromptOptions,
  ProviderFinalCandidateReview,
} from "../runtime-contracts.ts";

export type ProviderFinalCandidateDisposition =
  | { kind: "final"; text: string }
  | { kind: "continue"; observation: string };

export async function reviewProviderFinalCandidate(input: {
  options: Pick<FunctionToolPromptOptions, "reviewFinalCandidate">;
  text: string;
  roundIndex: number;
}): Promise<ProviderFinalCandidateDisposition> {
  const text = input.text.trim();
  if (!input.options.reviewFinalCandidate) return { kind: "final", text };
  const review: ProviderFinalCandidateReview = await input.options.reviewFinalCandidate({
    text,
    roundIndex: input.roundIndex,
  });
  if (review.status === "accepted") {
    return { kind: "final", text: review.text?.trim() || text };
  }
  const observation = review.observation.trim();
  if (!observation) throw new Error("provider_final_candidate_continuation_observation_missing");
  return { kind: "continue", observation };
}
