import { randomUUID } from "crypto";
import {
  safeOptionalPublicText,
  safePublicText,
} from "../../../output/evidence/transcript-sanitizers.ts";
import type { ObservationKind, TurnObservation } from "../../turn-kernel.ts";
import type { NativeToolCall } from "./audited-executor-types.ts";

const MODEL_VISIBLE_OUTPUT_LIMIT = 2_400;
const TOOL_FAILURE_FALLBACK = "Tool execution failed with redacted private details.";

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
  const message = error instanceof Error ? error.message : String(error);
  if (/validation|schema|argument|required|invalid/iu.test(message)) {
    return "tool_invalid_arguments";
  }
  if (toolName === "run_command" && /\brequires?\s+\w+|\bmissing\b/iu.test(message)) {
    return "tool_invalid_arguments";
  }
  if (toolName === "run_command") {
    return "command_failed";
  }
  return "validation_failed";
}

function failedToolResultKind(toolName: string, result: unknown): ObservationKind {
  if (toolName === "run_command") {
    const commandText = valueAt(result, "command");
    const suiteText = valueAt(result, "validation_suite") ?? valueAt(result, "suite");
    if (suiteText || /\b(?:bun|npm|pnpm|yarn)\s+(?:test|run\s+test)|\btest\b/iu.test(commandText ?? "")) {
      return "test_failed";
    }
    return "command_failed";
  }
  return "validation_failed";
}

function failedToolResultSummary(toolName: string, result: unknown): string {
  const exitCode = valueAt(result, "exit_code");
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
  const output = summarizedResult(input.result);
  if (output) {
    parts.push("Relevant output:", output);
  }
  parts.push("Use this observation to repair arguments, choose a different tool, or continue with a bounded limitation.");
  return parts.join("\n");
}

function summarizedResult(result: unknown): string {
  if (!result || typeof result !== "object" || Array.isArray(result)) return "";
  const record = result as Record<string, unknown>;
  const fields = ["stderr", "stdout", "error", "message", "validation"];
  const lines: string[] = [];
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) {
      const safeValue = safeOptionalPublicText(value);
      if (safeValue) {
        lines.push(`${field}: ${safeValue}`);
      }
    }
  }
  const exitCode = record.exit_code;
  if (typeof exitCode === "number") lines.unshift(`exit_code: ${exitCode}`);
  return limitModelVisibleContent(lines.join("\n"));
}

function valueAt(result: unknown, key: string): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const value = (result as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function limitModelVisibleContent(value: string): string {
  if (value.length <= MODEL_VISIBLE_OUTPUT_LIMIT) return value;
  return `${value.slice(0, MODEL_VISIBLE_OUTPUT_LIMIT)}\n...[observation truncated]`;
}

function safeToolFailureText(value: string): string {
  return safePublicText(value, TOOL_FAILURE_FALLBACK);
}
