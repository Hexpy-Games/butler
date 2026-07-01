import { randomUUID } from "crypto";
import {
  safePublicText,
} from "../../../output/evidence/transcript-sanitizers.ts";
import type { ObservationKind, TurnObservation } from "../../turn-kernel.ts";
import type { NativeToolCall } from "./audited-executor-types.ts";
import { summarizedToolResultForObservation } from "./tool-result-observation-summary.ts";

const MODEL_VISIBLE_OUTPUT_LIMIT = 2_400;
const TOOL_FAILURE_FALLBACK = "Tool execution failed with redacted private details.";
const TOOL_ARGUMENT_ERROR_CODES = new Set([
  "tool_arguments_validation_failed",
  "invalid_tool_arguments",
]);
const TOOL_UNAVAILABLE_ERROR_CODES = new Set([
  "disabled_tool",
  "tool_unavailable",
  "unknown_tool",
]);

export class ToolObservationError extends Error {
  readonly observationKind: ObservationKind;
  readonly toolResult: unknown;

  constructor(input: {
    message: string;
    observationKind: ObservationKind;
    toolResult: unknown;
  }) {
    super(input.message);
    this.name = "ToolObservationError";
    this.observationKind = input.observationKind;
    this.toolResult = input.toolResult;
  }
}

export function publicDecisionRequiredObservation(input: {
  turnId: string;
  call: NativeToolCall;
}): TurnObservation {
  return createToolObservation({
    turnId: input.turnId,
    kind: "public_decision_required",
    summary: `A public decision is required before executing ${input.call.name}.`,
    modelVisibleContent: [
      "Tool execution was paused before running the requested visible tool batch.",
      `Tool: ${input.call.name}`,
      "Reason: the same assistant response did not include a complete authored public decision for this tool call.",
      "Continue by authoring summary, rationale, and next_step fields for the immediate tool action, then call the tool again.",
    ].join("\n"),
  });
}

export function repeatedToolFamilyObservation(input: {
  turnId: string;
  call: NativeToolCall;
  family: string;
}): TurnObservation {
  return createToolObservation({
    turnId: input.turnId,
    kind: "validation_failed",
    summary: `Repeated ${input.family} tool-family pressure was observed.`,
    modelVisibleContent: [
      `Tool-family pressure was observed before re-running ${input.call.name}.`,
      `Family: ${input.family}`,
      "Use the latest available evidence, choose a distinct verification path, or continue with a bounded limitation.",
    ].join("\n"),
  });
}

export function toolObservationForFailure(input: {
  turnId: string;
  call: NativeToolCall;
  error: unknown;
  toolCallId?: string;
}): TurnObservation {
  if (input.error instanceof ToolObservationError) {
    const safeMessage = safeToolFailureText(input.error.message);
    return createToolObservation({
      turnId: input.turnId,
      kind: input.error.observationKind,
      summary: safeMessage,
      modelVisibleContent: modelVisibleFailureContent({
        toolName: input.call.name,
        message: safeMessage,
        result: input.error.toolResult,
      }),
      causedByToolCallId: input.toolCallId,
    });
  }
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const safeMessage = safeToolFailureText(message);
  return createToolObservation({
    turnId: input.turnId,
    kind: toolFailureKind(input.call.name, input.error),
    summary: `${input.call.name} could not complete: ${safeMessage}`,
    modelVisibleContent: modelVisibleFailureContent({
      toolName: input.call.name,
      message: safeMessage,
      result: null,
    }),
    causedByToolCallId: input.toolCallId,
  });
}

export function throwIfToolResultNeedsObservation(input: {
  call: NativeToolCall;
  result: unknown;
}): void {
  if (!toolResultFailed(input.result)) return;
  throw new ToolObservationError({
    message: failedToolResultSummary(input.call.name, input.result),
    observationKind: failedToolResultKind(input.call.name, input.result),
    toolResult: input.result,
  });
}

export function toolObservationResult(observation: TurnObservation): Record<string, unknown> {
  return {
    ok: false,
    observation,
    observation_kind: observation.kind,
    summary: observation.summary,
    model_visible_content: observation.modelVisibleContent,
  };
}

function createToolObservation(input: {
  turnId: string;
  kind: ObservationKind;
  summary: string;
  modelVisibleContent: string;
  causedByToolCallId?: string;
}): TurnObservation {
  return {
    observationId: `obs-${randomUUID().slice(0, 8)}`,
    turnId: input.turnId,
    kind: input.kind,
    visibility: "model",
    summary: input.summary,
    modelVisibleContent: limitModelVisibleContent(input.modelVisibleContent),
    causedByToolCallId: input.causedByToolCallId,
    createdAt: new Date().toISOString(),
  };
}

function toolFailureKind(toolName: string, error: unknown): ObservationKind {
  const errorCode = codeAt(error);
  if (errorCode && TOOL_ARGUMENT_ERROR_CODES.has(errorCode)) return "tool_invalid_arguments";
  if (errorCode && TOOL_UNAVAILABLE_ERROR_CODES.has(errorCode)) return "tool_unavailable";
  if (toolName === "run_command") {
    return "command_failed";
  }
  return "validation_failed";
}

function failedToolResultKind(toolName: string, result: unknown): ObservationKind {
  const explicitObservationKind = observationKindAt(result);
  if (explicitObservationKind) return explicitObservationKind;
  if (toolName === "run_command") {
    if (hasFailedValidationEvidence(result)) {
      return "test_failed";
    }
    return "command_failed";
  }
  return "validation_failed";
}

function failedToolResultSummary(toolName: string, result: unknown): string {
  const exitCode = numberAt(result, "exit_code");
  if (toolName === "run_command" && typeof exitCode === "number") {
    return `run_command exited with code ${exitCode}.`;
  }
  return `${toolName} returned an unsuccessful result.`;
}

function toolResultFailed(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  return (result as Record<string, unknown>).ok === false;
}

function modelVisibleFailureContent(input: {
  toolName: string;
  message: string;
  result: unknown;
}): string {
  const parts = [
    `Tool: ${input.toolName}`,
    `Observation: ${input.message}`,
  ];
  const output = summarizedToolResultForObservation(input.result);
  if (output) {
    parts.push("Relevant output:", output);
  }
  parts.push("Use this observation to repair arguments, choose a different tool, or continue with a bounded limitation.");
  return parts.join("\n");
}

function valueAt(result: unknown, key: string): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const value = (result as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function numberAt(result: unknown, key: string): number | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const value = (result as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function codeAt(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const code = (value as Record<string, unknown>).code;
  return typeof code === "string" && code.trim() ? code.trim() : null;
}

function observationKindAt(result: unknown): ObservationKind | null {
  const kind = valueAt(result, "observation_kind") ?? valueAt(result, "observationKind");
  if (
    kind === "tool_invalid_arguments" ||
    kind === "tool_unavailable" ||
    kind === "command_failed" ||
    kind === "test_failed" ||
    kind === "validation_failed" ||
    kind === "completion_gap" ||
    kind === "public_decision_required"
  ) {
    return kind;
  }
  return null;
}

function hasFailedValidationEvidence(result: unknown): boolean {
  if (valueAt(result, "validation_suite") || valueAt(result, "suite")) return true;
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const receipts = (result as Record<string, unknown>).evidence_capability_receipts;
  if (!Array.isArray(receipts)) return false;
  return receipts.some((receipt) => {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
    const record = receipt as Record<string, unknown>;
    if (record.capability !== "validation_passed") return false;
    if (record.verified === false) return true;
    const scope = record.scope;
    if (!scope || typeof scope !== "object" || Array.isArray(scope)) return false;
    const validationResult = (scope as Record<string, unknown>).result;
    return validationResult === "failed" || validationResult === "partial";
  });
}

function limitModelVisibleContent(value: string): string {
  if (value.length <= MODEL_VISIBLE_OUTPUT_LIMIT) return value;
  return `${value.slice(0, MODEL_VISIBLE_OUTPUT_LIMIT)}\n...[observation truncated]`;
}

function safeToolFailureText(value: string): string {
  return safePublicText(value, TOOL_FAILURE_FALLBACK);
}
