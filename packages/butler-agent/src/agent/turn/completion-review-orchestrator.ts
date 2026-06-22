import {
  classifyRuntimeFailureDelivery,
  deliveredWithLimitationsState,
  type RuntimeDeliveryClassification,
} from "./runtime-delivery-state.ts";

export interface CompletionReviewProgressFrame<TProgress> {
  progress: TProgress;
  successfulToolCount: number;
}

export interface CompletionReviewOrchestratorInput<TProgress> {
  currentFinalText: string;
  initialReviewPromptText: string;
  reviewMaxToolRounds: number;
  continuationMaxToolRounds: number;
  maxContinuationAttempts: number;
  runToolPrompt: (
    promptText: string,
    maxToolRounds: number,
    phase: "goal_completion_review" | "goal_completion_continuation",
  ) => Promise<string>;
  incompleteReason: (text: string) => string | null;
  buildContinuationPrompt: (input: {
    previousAnswer: string;
    incompleteReason: string;
  }) => string;
  buildReviewPrompt: (input: {
    candidateFinalText: string;
  }) => string;
  captureProgress: () => CompletionReviewProgressFrame<TProgress>;
  didProgressAdvance: (
    before: CompletionReviewProgressFrame<TProgress>,
    after: CompletionReviewProgressFrame<TProgress>,
  ) => boolean;
}

export type CompletionReviewOrchestratorOutcome =
  | {
    kind: "deliverable";
    text: string;
    reviewAttempts: number;
    continuationAttempts: number;
  }
  | {
    kind: "delivered_with_limitations";
    text: string;
    reason: string;
    delivery: RuntimeDeliveryClassification;
    reviewAttempts: number;
    continuationAttempts: number;
  }
  | {
    kind: "waiting_user";
    text: string;
    reason: string;
    delivery: RuntimeDeliveryClassification;
    reviewAttempts: number;
    continuationAttempts: number;
  };

export class CompletionReviewOrchestrator<TProgress> {
  async run(input: CompletionReviewOrchestratorInput<TProgress>): Promise<CompletionReviewOrchestratorOutcome> {
    const initialIncompleteReason = input.incompleteReason(input.currentFinalText);
    let candidateFinalText = input.currentFinalText;
    let safeCandidateFinalText = initialIncompleteReason
      ? fallbackLimitedAnswer()
      : input.currentFinalText;
    let candidateNeedsReviewText = Boolean(initialIncompleteReason);
    let nextReviewPromptText = input.initialReviewPromptText;
    let continuationAttempts = 0;

    for (let reviewAttempt = 0;; reviewAttempt += 1) {
      const reviewBefore = input.captureProgress();
      const reviewText = await input.runToolPrompt(
        nextReviewPromptText,
        input.reviewMaxToolRounds,
        "goal_completion_review",
      );
      const reviewAfter = input.captureProgress();
      const incompleteReason = input.incompleteReason(reviewText);
      const reviewAdvancedTheTurn = input.didProgressAdvance(reviewBefore, reviewAfter);
      if (!incompleteReason) {
        return {
          kind: "deliverable",
          text: reviewAdvancedTheTurn || candidateNeedsReviewText ? reviewText : candidateFinalText,
          reviewAttempts: reviewAttempt + 1,
          continuationAttempts,
        };
      }
      if (continuationAttempts >= input.maxContinuationAttempts) {
        return limitedOrWaitingOutcome({
          candidateFinalText: safeCandidateFinalText,
          reason: incompleteReason,
          reviewAttempts: reviewAttempt + 1,
          continuationAttempts,
        });
      }

      const continuationBefore = input.captureProgress();
      const continuationText = await input.runToolPrompt(input.buildContinuationPrompt({
        previousAnswer: reviewText,
        incompleteReason,
      }), input.continuationMaxToolRounds, "goal_completion_continuation");
      continuationAttempts += 1;
      const continuationAfter = input.captureProgress();
      const continuationAdvancedTheTurn = input.didProgressAdvance(
        continuationBefore,
        continuationAfter,
      );
      const continuationIncompleteReason = input.incompleteReason(continuationText);
      if (continuationIncompleteReason && !continuationAdvancedTheTurn) {
        return limitedOrWaitingOutcome({
          candidateFinalText: safeCandidateFinalText,
          reason: continuationIncompleteReason,
          reviewAttempts: reviewAttempt + 1,
          continuationAttempts,
        });
      }

      candidateFinalText = continuationText;
      candidateNeedsReviewText = Boolean(continuationIncompleteReason);
      if (!candidateNeedsReviewText) {
        safeCandidateFinalText = continuationText;
      }
      nextReviewPromptText = input.buildReviewPrompt({
        candidateFinalText,
      });
    }
  }
}

function fallbackLimitedAnswer(): string {
  return "I could not complete the answer with the available evidence.";
}

function limitedOrWaitingOutcome(input: {
  candidateFinalText: string;
  reason: string;
  reviewAttempts: number;
  continuationAttempts: number;
}): Extract<CompletionReviewOrchestratorOutcome, { kind: "delivered_with_limitations" | "waiting_user" }> {
  const delivery = classifyRuntimeFailureDelivery({
    code: "completion_review_incomplete",
    message: input.reason,
    retryable: true,
  });
  if (delivery.issue_kind === "user_action_blocker") {
    return {
      kind: "waiting_user",
      text: input.candidateFinalText,
      reason: input.reason,
      delivery,
      reviewAttempts: input.reviewAttempts,
      continuationAttempts: input.continuationAttempts,
    };
  }
  return {
    kind: "delivered_with_limitations",
    text: input.candidateFinalText,
    reason: input.reason,
    delivery: deliveredWithLimitationsState({
      limitationCodes: [delivery.limitation_codes[0] ?? "completion_review_incomplete"],
      limitations: [input.reason],
    }),
    reviewAttempts: input.reviewAttempts,
    continuationAttempts: input.continuationAttempts,
  };
}
