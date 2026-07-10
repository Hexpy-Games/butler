import { recordOperationalMetric } from "../../../../operations/metrics/operational-metrics.ts";
import type { ToolStagnationDecision } from "../../tool-loop-guards.ts";

export function appendToolStagnationObservation(input: {
  result: unknown;
  decision: ToolStagnationDecision | null;
  turnId: string;
  toolCallId: string;
  toolName: string;
  butlerData: string;
  sessionRole: string;
  startedAt: number;
}): unknown {
  if (!input.decision?.stagnant) return input.result;
  const observation = {
    observationId: `obs-stagnation-${safeId(input.toolCallId)}`,
    turnId: safeId(input.turnId),
    kind: "stagnation" as const,
    visibility: "model" as const,
    summary: `The ${input.decision.family} call returned the same result without a state revision change.`,
    modelVisibleContent: [
      `The executed ${input.toolName} call produced the same result fingerprint and state revision as the previous ${input.decision.family} call.`,
      "Choose a narrower read, perform the mutation implied by the established evidence, or provide a typed retry reason with the concrete change you expect.",
      "This is advisory: the runtime did not block or fail the tool call.",
    ].join("\n"),
    causedByToolCallId: safeId(input.toolCallId),
    createdAt: new Date().toISOString(),
  };
  recordOperationalMetric({
    category: "runtime",
    name: "tool_stagnation_observed",
    status: "ok",
    durationMs: Date.now() - input.startedAt,
    dimensions: {
      sessionRole: input.sessionRole,
      toolName: input.toolName,
      repeatFamily: input.decision.family,
      repeatCount: String(input.decision.count),
    },
  }, { butlerData: input.butlerData });
  if (input.result && typeof input.result === "object" && !Array.isArray(input.result)) {
    return {
      ...(input.result as Record<string, unknown>),
      butler_stagnation_observation: observation,
    };
  }
  return {
    value: input.result,
    butler_stagnation_observation: observation,
  };
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]/gu, "-").slice(0, 120) || "unknown";
}
