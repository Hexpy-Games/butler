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
import {
  boundedCompactReplayIdentifier,
  compactReplayArgumentPropertyShape,
  compactReplayCarrierDiagnostic,
  type CompactReplayCarrierDiagnostic,
  type CompactReplayCarrierRejectionReason,
} from "./carrier-diagnostic.ts";

export const COMPACT_REPLAY_PHASE_CONTINUITY_REQUIRED_FIRST =
  "compact_replay_phase_continuity_required_first" as const;
export const COMPACT_REPLAY_PHASE_CONTINUITY_SCHEMA_INVALID =
  "compact_replay_phase_continuity_schema_invalid" as const;
export const COMPACT_REPLAY_PHASE_CONTINUITY_REWRITE_FAILED =
  "compact_replay_phase_continuity_rewrite_failed" as const;
export const COMPACT_REPLAY_OPERATION_REQUIRED =
  "compact_replay_operation_required" as const;
export const COMPACT_REPLAY_OPERATION_CARRIER_MIXED =
  "compact_replay_operation_carrier_mixed" as const;

export type CompactReplayToolBatchRejection = CompactReplayCarrierDiagnostic & {
  code:
    | typeof COMPACT_REPLAY_PHASE_CONTINUITY_REQUIRED_FIRST
    | typeof COMPACT_REPLAY_PHASE_CONTINUITY_SCHEMA_INVALID
    | typeof COMPACT_REPLAY_PHASE_CONTINUITY_REWRITE_FAILED
    | typeof COMPACT_REPLAY_OPERATION_REQUIRED
    | typeof COMPACT_REPLAY_OPERATION_CARRIER_MIXED;
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
  const embeddedOperations = input.calls[0]?.arguments?.operations;
  if (input.calls.length > 1 && Array.isArray(embeddedOperations) &&
    embeddedOperations.length > 0) {
    return {
      code: COMPACT_REPLAY_OPERATION_CARRIER_MIXED,
      schemaPath: "$.toolCalls[1]",
      reason: "operation_carrier_mixed",
      properties: compactReplayArgumentPropertyShape(
        input.calls[0]?.arguments ?? {},
      ),
      summary: "Carrier rejected before execution: nested operations cannot be mixed with separate top-level operation calls.",
    };
  }
  if (input.calls.length === 1 &&
    (!Array.isArray(embeddedOperations) || embeddedOperations.length === 0)) {
    return {
      code: COMPACT_REPLAY_OPERATION_REQUIRED,
      schemaPath: "$.toolCalls[0].arguments.operations",
      reason: "operation_required",
      properties: compactReplayArgumentPropertyShape(
        input.calls[0]?.arguments ?? {},
      ),
      summary: "Carrier rejected before execution: replace_phase_continuity requires at least one nested operation in its operations array.",
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
  if (input.calls.length === 1) return null;
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
    name: boundedCompactReplayIdentifier(call.name, `invalid_tool_${index}`),
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

export function compactReplayRejectionForArguments(
  rejection: CompactReplayToolBatchRejection,
  arguments_: Record<string, unknown>,
): CompactReplayToolBatchRejection {
  const diagnostic = compactReplayCarrierDiagnostic(arguments_);
  if (diagnostic) {
    return {
      ...rejection,
      ...diagnostic,
      code: rejectionCodeForReason(diagnostic.reason),
      summary: rejectionSummaryForReason(diagnostic.reason),
    };
  }
  return {
    ...rejection,
    properties: compactReplayArgumentPropertyShape(arguments_),
  };
}

function rejectionCodeForReason(
  reason: CompactReplayCarrierRejectionReason,
): CompactReplayToolBatchRejection["code"] {
  if (reason === "phase_continuity_required_first") {
    return COMPACT_REPLAY_PHASE_CONTINUITY_REQUIRED_FIRST;
  }
  if (reason === "phase_continuity_schema_invalid") {
    return COMPACT_REPLAY_PHASE_CONTINUITY_SCHEMA_INVALID;
  }
  if (reason === "phase_continuity_rewrite_failed") {
    return COMPACT_REPLAY_PHASE_CONTINUITY_REWRITE_FAILED;
  }
  if (reason === "operation_carrier_mixed") {
    return COMPACT_REPLAY_OPERATION_CARRIER_MIXED;
  }
  return COMPACT_REPLAY_OPERATION_REQUIRED;
}

function rejectionSummaryForReason(
  reason: CompactReplayCarrierRejectionReason,
): string {
  if (reason === "phase_continuity_required_first") {
    return "Carrier rejected before execution: replace_phase_continuity must be the only top-level call.";
  }
  if (reason === "phase_continuity_schema_invalid") {
    return "Carrier rejected before execution: replace_phase_continuity arguments do not match its schema.";
  }
  if (reason === "phase_continuity_rewrite_failed") {
    return "Carrier rejected before remainder execution: replace_phase_continuity did not complete its rewrite.";
  }
  if (reason === "operation_carrier_mixed") {
    return "Carrier rejected before execution: nested operations cannot be mixed with separate top-level operation calls.";
  }
  return "Carrier rejected before execution: replace_phase_continuity requires at least one nested operation in its operations array.";
}
