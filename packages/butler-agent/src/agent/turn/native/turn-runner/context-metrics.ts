import type { RuntimeTurnInput } from "../../../../test-support/harness/contracts.ts";
import { appendRuntimeTurnContextMetric } from "../../../../operations/metrics/context-monitor.ts";
import { recordOperationalMetric } from "../../../../operations/metrics/operational-metrics.ts";
import type { normalizeTurnPrompt } from "../context/turn-prompt.ts";
import type { NativeTurnRunnerDeps } from "./turn-runner-types.ts";

export function recordContextMetric(
  input: { turnInput: RuntimeTurnInput; deps: NativeTurnRunnerDeps },
  normalizedPrompt: ReturnType<typeof normalizeTurnPrompt>,
  prompt: string,
): void {
  try {
    appendRuntimeTurnContextMetric({
      butlerData: input.deps.butlerData,
      sessionId: input.turnInput.handle.sessionId,
      model: input.turnInput.model,
      totalPromptChars: prompt.length,
      promptContextChars: normalizedPrompt.promptContextChars,
      compactionContextChars: normalizedPrompt.compactionContextChars,
      feedbackBufferContextChars: normalizedPrompt.feedbackBufferContextChars,
      workingMemoryContextChars: normalizedPrompt.workingMemoryContextChars,
      recentConversationChars: normalizedPrompt.recentConversationChars,
      recallContextChars: normalizedPrompt.recallContextChars,
      inboundMessageChars: normalizedPrompt.inboundMessageChars,
    });
  } catch (error) {
    recordTurnContextBestEffortFailure(input, "turn_context_metric_failed", error);
  }
}

export function recordTurnContextBestEffortFailure(
  input: { turnInput: RuntimeTurnInput; deps: NativeTurnRunnerDeps },
  name: string,
  error: unknown,
): void {
  try {
    recordOperationalMetric({
      category: "runtime",
      name,
      status: "error",
      dimensions: {
        runtime: input.deps.runtimeId,
        model: input.turnInput.model,
        error_name: error instanceof Error ? error.name : "UnknownError",
      },
    }, { butlerData: input.deps.butlerData });
  } catch {
    // The active user turn must survive even if best-effort telemetry cannot be written.
  }
}
