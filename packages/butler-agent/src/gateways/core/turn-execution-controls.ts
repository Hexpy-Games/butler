import { createHash } from "node:crypto";
import type { ModelRef } from "./contracts.ts";

export const TURN_EXECUTION_CONTROLS_SCHEMA =
  "butler.turn-execution-controls.v1" as const;

export type TurnReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type TurnAccessMode = "full_access" | "ask_first" | "read_only";

export type TurnExecutionControlSource =
  | "message_override"
  | "session_override"
  | "global_default";

export interface TurnControlResolution {
  controls: {
    model: ModelRef;
    reasoning_effort: TurnReasoningEffort;
    access_mode: TurnAccessMode;
    plan_mode: boolean;
  };
  source: TurnExecutionControlSource;
  sessionControlRevision: number;
  catalogGeneration: string;
  model_fallback?: {
    enabled: boolean;
    models: ModelRef[];
  };
}

export interface TurnExecutionControlsV1 {
  schema_version: typeof TURN_EXECUTION_CONTROLS_SCHEMA;
  turn_id: string;
  session_id: string;
  model_ref: ModelRef;
  reasoning_effort: TurnReasoningEffort;
  access_mode: TurnAccessMode;
  plan_mode: boolean;
  source: TurnExecutionControlSource;
  session_control_revision: number;
  catalog_generation: string;
  resolved_at: string;
  integrity_hash: string;
  model_fallback?: {
    enabled: boolean;
    models: ModelRef[];
  };
}

type UnsignedTurnExecutionControls = Omit<
  TurnExecutionControlsV1,
  "integrity_hash"
>;

export function createTurnExecutionControls(input: {
  turnId: string;
  sessionId: string;
  resolution: TurnControlResolution;
  resolvedAt?: string;
}): TurnExecutionControlsV1 {
  const unsigned: UnsignedTurnExecutionControls = {
    schema_version: TURN_EXECUTION_CONTROLS_SCHEMA,
    turn_id: input.turnId,
    session_id: input.sessionId,
    model_ref: input.resolution.controls.model,
    reasoning_effort: input.resolution.controls.reasoning_effort,
    access_mode: input.resolution.controls.access_mode,
    plan_mode: input.resolution.controls.plan_mode,
    source: input.resolution.source,
    session_control_revision: input.resolution.sessionControlRevision,
    catalog_generation: input.resolution.catalogGeneration,
    resolved_at: input.resolvedAt ?? new Date().toISOString(),
    model_fallback: {
      enabled: input.resolution.model_fallback?.enabled === true,
      models: [...(input.resolution.model_fallback?.models ?? [])],
    },
  };
  return {
    ...unsigned,
    integrity_hash: turnExecutionControlsIntegrityHash(unsigned),
  };
}

export function verifyTurnExecutionControls(
  value: unknown,
): TurnExecutionControlsV1 {
  if (!isTurnExecutionControls(value)) {
    throw new Error("turn_execution_controls_invalid");
  }
  const { integrity_hash, ...unsigned } = value;
  if (turnExecutionControlsIntegrityHash(unsigned) !== integrity_hash) {
    throw new Error("turn_execution_controls_integrity_mismatch");
  }
  return structuredClone(value);
}

export function turnExecutionControlsIntegrityHash(
  input: UnsignedTurnExecutionControls,
): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}

function isTurnExecutionControls(
  value: unknown,
): value is TurnExecutionControlsV1 {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<TurnExecutionControlsV1>;
  return (
    input.schema_version === TURN_EXECUTION_CONTROLS_SCHEMA &&
    nonEmptyString(input.turn_id) &&
    nonEmptyString(input.session_id) &&
    isModelRef(input.model_ref) &&
    ["none", "low", "medium", "high", "xhigh", "max"].includes(
      input.reasoning_effort ?? "",
    ) &&
    ["full_access", "ask_first", "read_only"].includes(
      input.access_mode ?? "",
    ) &&
    typeof input.plan_mode === "boolean" &&
    ["message_override", "session_override", "global_default"].includes(
      input.source ?? "",
    ) &&
    Number.isSafeInteger(input.session_control_revision) &&
    (input.session_control_revision ?? -1) >= 0 &&
    nonEmptyString(input.catalog_generation) &&
    nonEmptyString(input.resolved_at) &&
    nonEmptyString(input.integrity_hash)
    && (input.model_fallback === undefined || isModelFallback(input.model_fallback))
  );
}

function isModelFallback(value: unknown): value is { enabled: boolean; models: ModelRef[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as { enabled?: unknown; models?: unknown };
  return typeof input.enabled === "boolean" &&
    Array.isArray(input.models) &&
    input.models.every((model) => isModelRef(model));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isModelRef(value: unknown): value is ModelRef {
  return nonEmptyString(value) && value.includes("/");
}
