import { expect, test } from "bun:test";
import {
  CompletionReviewOrchestrator,
  type CompletionReviewProgressFrame,
} from "../../packages/butler-agent/src/agent/turn/completion-review-orchestrator.ts";

interface TestProgress {
  workStep: number;
}

function frame(workStep: number, successfulToolCount: number): CompletionReviewProgressFrame<TestProgress> {
  return {
    progress: { workStep },
    successfulToolCount,
  };
}

test("completion review orchestrator repairs missing evidence and returns continuation text", async () => {
  const prompts: string[] = [];
  const progressFrames = [
    frame(0, 1),
    frame(0, 1),
    frame(0, 1),
    frame(1, 2),
    frame(1, 2),
    frame(1, 2),
  ];
  const outcome = await new CompletionReviewOrchestrator<TestProgress>().run({
    currentFinalText: "draft answer",
    initialReviewPromptText: "review draft answer",
    reviewMaxToolRounds: 4,
    continuationMaxToolRounds: 2,
    maxContinuationAttempts: 2,
    runToolPrompt: async (promptText, _maxToolRounds, phase) => {
      prompts.push(`${phase}:${promptText}`);
      if (phase === "goal_completion_review" && prompts.length === 1) {
        return "INCOMPLETE: missing source evidence.";
      }
      if (phase === "goal_completion_continuation") {
        return "repaired answer with source evidence";
      }
      return "review approved after repair";
    },
    incompleteReason: (text) => text.startsWith("INCOMPLETE:") ? text.slice("INCOMPLETE:".length).trim() : null,
    buildContinuationPrompt: ({ incompleteReason }) => `continue because ${incompleteReason}`,
    buildReviewPrompt: ({ candidateFinalText }) => `review ${candidateFinalText}`,
    captureProgress: () => progressFrames.shift() ?? frame(1, 2),
    didProgressAdvance: (before, after) =>
      after.progress.workStep > before.progress.workStep ||
      after.successfulToolCount > before.successfulToolCount,
  });

  expect(outcome).toMatchObject({
    kind: "deliverable",
    text: "repaired answer with source evidence",
    reviewAttempts: 2,
    continuationAttempts: 1,
  });
  expect(prompts).toEqual([
    "goal_completion_review:review draft answer",
    "goal_completion_continuation:continue because missing source evidence.",
    "goal_completion_review:review repaired answer with source evidence",
  ]);
});

test("completion review orchestrator falls back to limitations when repair budget is exhausted", async () => {
  const outcome = await new CompletionReviewOrchestrator<TestProgress>().run({
    currentFinalText: "best available answer",
    initialReviewPromptText: "review best available answer",
    reviewMaxToolRounds: 4,
    continuationMaxToolRounds: 2,
    maxContinuationAttempts: 0,
    runToolPrompt: async () => "INCOMPLETE: source verification remained unavailable.",
    incompleteReason: (text) => text.startsWith("INCOMPLETE:") ? text.slice("INCOMPLETE:".length).trim() : null,
    buildContinuationPrompt: () => "should not continue",
    buildReviewPrompt: ({ candidateFinalText }) => `review ${candidateFinalText}`,
    captureProgress: () => frame(0, 0),
    didProgressAdvance: () => false,
  });

  expect(outcome).toMatchObject({
    kind: "delivered_with_limitations",
    text: "best available answer",
    reason: "source verification remained unavailable.",
    delivery: {
      delivery_state: "delivered_with_limitations",
      visibility: "assistant_output",
      failure_notice: false,
      limitations: ["source verification remained unavailable."],
    },
    reviewAttempts: 1,
    continuationAttempts: 0,
  });
});

test("completion review orchestrator stops as user-action blocker when repair requires credentials", async () => {
  const outcome = await new CompletionReviewOrchestrator<TestProgress>().run({
    currentFinalText: "credential-dependent answer",
    initialReviewPromptText: "review credential-dependent answer",
    reviewMaxToolRounds: 4,
    continuationMaxToolRounds: 2,
    maxContinuationAttempts: 0,
    runToolPrompt: async () => "INCOMPLETE: login required for the private account.",
    incompleteReason: (text) => text.startsWith("INCOMPLETE:") ? text.slice("INCOMPLETE:".length).trim() : null,
    buildContinuationPrompt: () => "should not continue",
    buildReviewPrompt: ({ candidateFinalText }) => `review ${candidateFinalText}`,
    captureProgress: () => frame(0, 0),
    didProgressAdvance: () => false,
  });

  expect(outcome).toMatchObject({
    kind: "waiting_user",
    text: "credential-dependent answer",
    reason: "login required for the private account.",
    delivery: {
      delivery_state: "waiting_user",
      visibility: "user_action_required",
      failure_notice: false,
    },
  });
});

test("completion review orchestrator falls back when continuation stays incomplete without progress", async () => {
  const progressFrames = [
    frame(0, 0),
    frame(0, 0),
    frame(0, 0),
    frame(0, 0),
  ];
  const outcome = await new CompletionReviewOrchestrator<TestProgress>().run({
    currentFinalText: "partial answer",
    initialReviewPromptText: "review partial answer",
    reviewMaxToolRounds: 4,
    continuationMaxToolRounds: 2,
    maxContinuationAttempts: 2,
    runToolPrompt: async (_promptText, _maxToolRounds, phase) =>
      phase === "goal_completion_review"
        ? "INCOMPLETE: missing chart artifact."
        : "INCOMPLETE: chart artifact still missing.",
    incompleteReason: (text) => text.startsWith("INCOMPLETE:") ? text.slice("INCOMPLETE:".length).trim() : null,
    buildContinuationPrompt: ({ incompleteReason }) => `continue because ${incompleteReason}`,
    buildReviewPrompt: ({ candidateFinalText }) => `review ${candidateFinalText}`,
    captureProgress: () => progressFrames.shift() ?? frame(0, 0),
    didProgressAdvance: (before, after) =>
      after.progress.workStep > before.progress.workStep ||
      after.successfulToolCount > before.successfulToolCount,
  });

  expect(outcome).toMatchObject({
    kind: "delivered_with_limitations",
    text: "partial answer",
    reason: "chart artifact still missing.",
    reviewAttempts: 1,
    continuationAttempts: 1,
  });
});

test("completion review orchestrator does not deliver incomplete continuation text after progress", async () => {
  const progressFrames = [
    frame(0, 0),
    frame(0, 0),
    frame(0, 0),
    frame(1, 1),
    frame(1, 1),
    frame(1, 1),
  ];
  const outcome = await new CompletionReviewOrchestrator<TestProgress>().run({
    currentFinalText: "partial answer",
    initialReviewPromptText: "review partial answer",
    reviewMaxToolRounds: 4,
    continuationMaxToolRounds: 2,
    maxContinuationAttempts: 2,
    runToolPrompt: async (_promptText, _maxToolRounds, phase) => {
      if (phase === "goal_completion_review" && progressFrames.length > 4) {
        return "INCOMPLETE: validation evidence missing.";
      }
      if (phase === "goal_completion_continuation") {
        return "INCOMPLETE: validation was run, but final summary is not rewritten yet.";
      }
      return "final answer after validation evidence";
    },
    incompleteReason: (text) => text.startsWith("INCOMPLETE:") ? text.slice("INCOMPLETE:".length).trim() : null,
    buildContinuationPrompt: ({ incompleteReason }) => `continue because ${incompleteReason}`,
    buildReviewPrompt: ({ candidateFinalText }) => `review ${candidateFinalText}`,
    captureProgress: () => progressFrames.shift() ?? frame(1, 1),
    didProgressAdvance: (before, after) =>
      after.progress.workStep > before.progress.workStep ||
      after.successfulToolCount > before.successfulToolCount,
  });

  expect(outcome).toMatchObject({
    kind: "deliverable",
    text: "final answer after validation evidence",
    reviewAttempts: 2,
    continuationAttempts: 1,
  });
  expect(outcome.text).not.toContain("INCOMPLETE:");
});

test("completion review orchestrator does not use incomplete continuation text for limitation fallback", async () => {
  const progressFrames = [
    frame(0, 0),
    frame(0, 0),
    frame(0, 0),
    frame(1, 1),
    frame(1, 1),
    frame(1, 1),
  ];
  const outcome = await new CompletionReviewOrchestrator<TestProgress>().run({
    currentFinalText: "safe prior partial answer",
    initialReviewPromptText: "review partial answer",
    reviewMaxToolRounds: 4,
    continuationMaxToolRounds: 2,
    maxContinuationAttempts: 1,
    runToolPrompt: async (_promptText, _maxToolRounds, phase) =>
      phase === "goal_completion_continuation"
        ? "INCOMPLETE: validation was run, but summary is still incomplete."
        : "INCOMPLETE: validation summary still missing.",
    incompleteReason: (text) => text.startsWith("INCOMPLETE:") ? text.slice("INCOMPLETE:".length).trim() : null,
    buildContinuationPrompt: ({ incompleteReason }) => `continue because ${incompleteReason}`,
    buildReviewPrompt: ({ candidateFinalText }) => `review ${candidateFinalText}`,
    captureProgress: () => progressFrames.shift() ?? frame(1, 1),
    didProgressAdvance: (before, after) =>
      after.progress.workStep > before.progress.workStep ||
      after.successfulToolCount > before.successfulToolCount,
  });

  expect(outcome).toMatchObject({
    kind: "delivered_with_limitations",
    text: "safe prior partial answer",
    reason: "validation summary still missing.",
    reviewAttempts: 2,
    continuationAttempts: 1,
  });
  expect(outcome.text).not.toContain("INCOMPLETE:");
});

test("completion review orchestrator does not use initial incomplete text for limitation fallback", async () => {
  const outcome = await new CompletionReviewOrchestrator<TestProgress>().run({
    currentFinalText: "INCOMPLETE: source verification was not available.",
    initialReviewPromptText: "review initial incomplete answer",
    reviewMaxToolRounds: 4,
    continuationMaxToolRounds: 2,
    maxContinuationAttempts: 0,
    runToolPrompt: async () => "INCOMPLETE: source verification was not available.",
    incompleteReason: (text) => text.startsWith("INCOMPLETE:") ? text.slice("INCOMPLETE:".length).trim() : null,
    buildContinuationPrompt: ({ incompleteReason }) => `continue because ${incompleteReason}`,
    buildReviewPrompt: ({ candidateFinalText }) => `review ${candidateFinalText}`,
    captureProgress: () => frame(0, 0),
    didProgressAdvance: () => false,
  });

  expect(outcome).toMatchObject({
    kind: "delivered_with_limitations",
    text: "I could not complete the answer with the available evidence.",
    reason: "source verification was not available.",
    reviewAttempts: 1,
    continuationAttempts: 0,
  });
  expect(outcome.text).not.toContain("INCOMPLETE:");
});
