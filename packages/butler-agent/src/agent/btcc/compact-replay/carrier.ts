import { REPLACE_PHASE_CONTINUITY_TOOL_NAME } from
  "../../tools/m1-compact-replay.ts";
import { validateToolCallArguments } from
  "../../tools/schema-validation.ts";
import type {
  ModelRoundRequest,
  ModelRoundResult,
  ModelRoundToolCall,
} from "../ports/model-round.ts";
import { parseCompactReplayPhaseContinuity } from "./phase-continuity.ts";

export const COMPACT_REPLAY_PHASE_CONTINUITY_REQUIRED_FIRST =
  "compact_replay_phase_continuity_required_first" as const;
export const COMPACT_REPLAY_PHASE_CONTINUITY_SCHEMA_INVALID =
  "compact_replay_phase_continuity_schema_invalid" as const;
export const COMPACT_REPLAY_PHASE_CONTINUITY_REWRITE_FAILED =
  "compact_replay_phase_continuity_rewrite_failed" as const;

export type CompactReplayCarrierRejectionReason =
  | "phase_continuity_required_first"
  | "phase_continuity_schema_invalid"
  | "phase_continuity_rewrite_failed";

export type CompactReplayCarrierPropertyType =
  | "array"
  | "boolean"
  | "null"
  | "number"
  | "object"
  | "string"
  | "unknown";

export type CompactReplayCarrierPropertyShape = {
  name: string;
  type: CompactReplayCarrierPropertyType;
};

export type CompactReplayCarrierDiagnostic = {
  schemaPath: string;
  reason: CompactReplayCarrierRejectionReason;
  properties: CompactReplayCarrierPropertyShape[];
};

export type CompactReplayToolBatchRejection = CompactReplayCarrierDiagnostic & {
  code:
    | typeof COMPACT_REPLAY_PHASE_CONTINUITY_REQUIRED_FIRST
    | typeof COMPACT_REPLAY_PHASE_CONTINUITY_SCHEMA_INVALID
    | typeof COMPACT_REPLAY_PHASE_CONTINUITY_REWRITE_FAILED;
  summary: string;
};

type CarrierCallShape = {
  name: string;
  validationError?: string | null;
  arguments?: Record<string, unknown>;
};

/** Rejects malformed model carriers before any source or effect can dispatch. */
export function compactReplayToolBatchRejection(input: {
  enabled: boolean;
  calls: readonly CarrierCallShape[];
}): CompactReplayToolBatchRejection | null {
  if (!input.enabled || input.calls.length === 0) return null;
  const replacements = input.calls.filter((call) =>
    call.name === REPLACE_PHASE_CONTINUITY_TOOL_NAME);
  if (replacements.length !== 1 ||
    input.calls[0]?.name !== REPLACE_PHASE_CONTINUITY_TOOL_NAME) {
    return {
      code: COMPACT_REPLAY_PHASE_CONTINUITY_REQUIRED_FIRST,
      schemaPath: "$.toolCalls[0].name",
      reason: "phase_continuity_required_first",
      properties: compactReplayArgumentPropertyShape(
        input.calls[0]?.arguments ?? {},
      ),
      summary: "Carrier rejected before execution: replace_phase_continuity must be the first call and appear exactly once.",
    };
  }
  if (input.calls[0].validationError) {
    return {
      code: COMPACT_REPLAY_PHASE_CONTINUITY_SCHEMA_INVALID,
      schemaPath: "$.toolCalls[0].arguments",
      reason: "phase_continuity_schema_invalid",
      properties: compactReplayArgumentPropertyShape(
        input.calls[0]?.arguments ?? {},
      ),
      summary: "Carrier rejected before execution: replace_phase_continuity arguments do not match its schema.",
    };
  }
  return null;
}

export function compactReplayContinuityRewriteFailure(
  arguments_: Record<string, unknown> = {},
):
  CompactReplayToolBatchRejection {
  return {
    code: COMPACT_REPLAY_PHASE_CONTINUITY_REWRITE_FAILED,
    schemaPath: "$.toolCalls[0]",
    reason: "phase_continuity_rewrite_failed",
    properties: compactReplayArgumentPropertyShape(arguments_),
    summary: "Carrier rejected before remainder execution: replace_phase_continuity did not complete its rewrite.",
  };
}

/**
 * Replaces a rejected provider carrier with a bounded structural observation
 * before route acceptance can persist provider-owned content.
 */
export function sanitizeCompactReplayCarrierForAcceptance(input: {
  request: Pick<ModelRoundRequest, "tools">;
  result: ModelRoundResult;
}): ModelRoundResult {
  const continuityTool = input.request.tools.find((tool) =>
    tool.name === REPLACE_PHASE_CONTINUITY_TOOL_NAME);
  if (!continuityTool || input.result.toolCalls.length === 0) {
    return input.result;
  }
  const shapedCalls = input.result.toolCalls.map((call) => {
    const tool = input.request.tools.find((candidate) => candidate.name === call.name);
    const validation = validateToolCallArguments({
      toolName: call.name,
      rawArguments: Object.hasOwn(call, "rawArguments")
        ? call.rawArguments
        : call.arguments,
      schema: tool?.parameters,
    });
    return {
      name: call.name,
      arguments: call.arguments,
      validationError: tool
        ? validation.error ?? phaseContinuitySemanticError(
          call.name,
          validation.arguments,
        )
        : null,
    };
  });
  const rejection = compactReplayToolBatchRejection({
    enabled: true,
    calls: shapedCalls,
  });
  if (!rejection) return input.result;
  return {
    toolCalls: input.result.toolCalls.slice(0, 32).map((call, index) =>
      rejectedCarrierToolCall(call, index, rejection)),
  };
}

function phaseContinuitySemanticError(
  toolName: string,
  arguments_: Record<string, unknown>,
): string | null {
  if (toolName !== REPLACE_PHASE_CONTINUITY_TOOL_NAME) return null;
  try {
    parseCompactReplayPhaseContinuity(arguments_);
    return null;
  } catch {
    return "compact_replay_phase_continuity_semantic_invalid";
  }
}

function rejectedCarrierToolCall(
  call: ModelRoundToolCall,
  index: number,
  rejection: CompactReplayToolBatchRejection,
): ModelRoundToolCall {
  return {
    id: `compact-replay-rejected-${index}`,
    name: boundedIdentifier(call.name, `invalid_tool_${index}`),
    arguments: {
      carrier_rejection: {
        schema_path: rejection.schemaPath,
        reason: rejection.reason,
        properties: compactReplayArgumentPropertyShape(call.arguments),
      },
    },
    rawArguments: "{}",
  };
}

export function compactReplayArgumentPropertyShape(
  value: Record<string, unknown>,
): CompactReplayCarrierPropertyShape[] {
  return Object.keys(value).sort().slice(0, 24).map((name, index) => ({
    name: boundedIdentifier(name, `property_${index}`, 80),
    type: argumentValueType(value[name]),
  }));
}

export function compactReplayCarrierDiagnostic(
  value: Record<string, unknown> | undefined,
): CompactReplayCarrierDiagnostic | null {
  if (!value || Object.keys(value).length !== 1) return null;
  const diagnostic = record(value.carrier_rejection);
  if (!diagnostic || Object.keys(diagnostic).some((key) =>
    !["schema_path", "reason", "properties"].includes(key))) return null;
  if (!isRejectionReason(diagnostic.reason) ||
    diagnostic.schema_path !== schemaPathForReason(diagnostic.reason) ||
    !Array.isArray(diagnostic.properties) || diagnostic.properties.length > 24) {
    return null;
  }
  const properties = diagnostic.properties.flatMap((property) => {
    const shape = record(property);
    return shape && Object.keys(shape).length === 2 &&
        typeof shape.name === "string" && isBoundedIdentifier(shape.name, 80) &&
        isPropertyType(shape.type)
      ? [{ name: shape.name, type: shape.type }]
      : [];
  });
  if (properties.length !== diagnostic.properties.length) return null;
  return {
    schemaPath: diagnostic.schema_path,
    reason: diagnostic.reason,
    properties,
  };
}

export function compactReplayRejectionForArguments(
  rejection: CompactReplayToolBatchRejection,
  arguments_: Record<string, unknown>,
): CompactReplayToolBatchRejection {
  const diagnostic = compactReplayCarrierDiagnostic(arguments_);
  return {
    ...rejection,
    ...(diagnostic ?? {
      properties: compactReplayArgumentPropertyShape(arguments_),
    }),
  };
}

function argumentValueType(value: unknown): CompactReplayCarrierPropertyType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  if (type === "boolean" || type === "number" || type === "string") {
    return type;
  }
  if (type === "object") return "object";
  return "unknown";
}

function schemaPathForReason(reason: CompactReplayCarrierRejectionReason): string {
  if (reason === "phase_continuity_required_first") {
    return "$.toolCalls[0].name";
  }
  if (reason === "phase_continuity_schema_invalid") {
    return "$.toolCalls[0].arguments";
  }
  return "$.toolCalls[0]";
}

function isRejectionReason(
  value: unknown,
): value is CompactReplayCarrierRejectionReason {
  return value === "phase_continuity_required_first" ||
    value === "phase_continuity_schema_invalid" ||
    value === "phase_continuity_rewrite_failed";
}

function isPropertyType(
  value: unknown,
): value is CompactReplayCarrierPropertyType {
  return value === "array" || value === "boolean" || value === "null" ||
    value === "number" || value === "object" || value === "string" ||
    value === "unknown";
}

function isBoundedIdentifier(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength &&
    /^[A-Za-z0-9_.:-]+$/u.test(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedIdentifier(
  value: string,
  fallback: string,
  maxLength = 120,
): string {
  const bounded = value.slice(0, maxLength).replace(/[^A-Za-z0-9_.:-]/gu, "_");
  return bounded || fallback;
}
