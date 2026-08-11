import type {
  BtccAgentLoopInput,
  BtccAgentLoopToolCall,
  BtccAgentLoopToolDefinition,
  BtccAgentLoopToolResult,
} from "./contracts.ts";
import {
  TurnContinuationBudgetExhaustedError,
  TurnContinuationBudgetStorageError,
} from "../turn/continuation-budget.ts";
import { validateToolCallArguments } from "../../tools/schema-validation.ts";
import type { BtccCompactReplayMetadata } from
  "./compact-replay-messages.ts";
import {
  compactReplayCarrierDiagnostic,
  compactReplayContinuityRewriteFailure,
  compactReplayRejectionForArguments,
  compactReplayToolBatchRejection,
  expandCompactReplayOperationCarrierCalls,
  withoutCompactReplayCarrierOperations,
  type CompactReplayToolBatchRejection,
} from "../compact-replay/index.ts";
import { REPLACE_PHASE_CONTINUITY_TOOL_NAME } from
  "../../tools/m1-compact-replay.ts";

const BTCC_TOOL_EXECUTION_ENVELOPE = Symbol("btcc-tool-execution-envelope");

export type BtccToolExecutionEnvelope = {
  [BTCC_TOOL_EXECUTION_ENVELOPE]: true;
  output: unknown;
  compactReplay: BtccCompactReplayMetadata;
};

export function createBtccToolExecutionEnvelope(
  output: unknown,
  compactReplay: BtccCompactReplayMetadata,
): BtccToolExecutionEnvelope {
  return { [BTCC_TOOL_EXECUTION_ENVELOPE]: true, output, compactReplay };
}

function createBtccOperationRejectedResult(input: {
  call: BtccAgentLoopToolCall;
} & CompactReplayToolBatchRejection): BtccAgentLoopToolResult {
  const summary = input.summary.slice(0, 1_000);
  return {
    toolCallId: input.call.id,
    name: input.call.name,
    ok: false,
    error: summary,
    output: {
      ok: false,
      observation: {
        kind: "operation_rejected",
        visibility: "model",
        code: input.code,
        tool_name: input.call.name,
        summary,
      },
      observation_kind: "operation_rejected",
      summary,
    },
    compactReplay: {
      kind: "operation_rejected",
      code: input.code,
      toolName: input.call.name,
      summary,
      schemaPath: input.schemaPath,
      reason: input.reason,
      properties: input.properties,
    },
  };
}

export interface PreparedBtccToolCall {
  call: BtccAgentLoopToolCall;
  tool: BtccAgentLoopToolDefinition | undefined;
  validationError: string | null;
  compactReplayExecutionGate?: CompactReplayExecutionGate;
}

interface CompactReplayExecutionGate {
  rejection: CompactReplayToolBatchRejection | null;
  phaseContinuityRewritten: boolean;
}

export function prepareBtccToolBatch(
  input: Pick<BtccAgentLoopInput, "tools" | "compactReplay">,
  calls: readonly BtccAgentLoopToolCall[],
): PreparedBtccToolCall[] {
  const executableCalls = expandCompactReplayOperationCarrierCalls({
    enabled: input.compactReplay?.enabled === true,
    calls,
  });
  const prepared = executableCalls.map((call) =>
    prepareBtccToolCall(input, call));
  const rawCarrierArguments = calls[0]?.arguments;
  const hasMixedProviderCarrier = calls.length > 1 &&
    calls[0]?.name === REPLACE_PHASE_CONTINUITY_TOOL_NAME &&
    Array.isArray(rawCarrierArguments?.operations) &&
    rawCarrierArguments.operations.length > 0;
  const rejection = compactReplayToolBatchRejection({
    enabled: input.compactReplay?.enabled === true,
    calls: prepared.map((item, index) => ({
      name: item.call.name,
      arguments: hasMixedProviderCarrier && index === 0
        ? rawCarrierArguments
        : item.call.arguments,
      validationError: item.validationError,
    })),
  });
  if (input.compactReplay?.enabled !== true || prepared.length === 0) {
    return prepared;
  }
  const compactReplayExecutionGate: CompactReplayExecutionGate = {
    rejection,
    phaseContinuityRewritten: false,
  };
  return prepared.map((item) => ({ ...item, compactReplayExecutionGate }));
}

export function canExecutePreparedBtccToolBatchConcurrently(
  prepared: readonly PreparedBtccToolCall[],
): boolean {
  return prepared.length > 1 && prepared.every((item) =>
    !item.compactReplayExecutionGate &&
    item.validationError === null && item.tool?.concurrencySafe === true);
}

export function prepareBtccToolCall(
  input: Pick<BtccAgentLoopInput, "tools">,
  call: BtccAgentLoopToolCall,
): PreparedBtccToolCall {
  const tool = input.tools.find((candidate) => candidate.name === call.name);
  const validation = validateToolCallArguments({
    toolName: call.name,
    rawArguments: Object.hasOwn(call, "rawArguments")
      ? call.rawArguments
      : call.arguments,
    schema: tool?.parameters,
  });
  const persistedCarrierDiagnostic = compactReplayCarrierDiagnostic(
    call.arguments,
  );
  const executionArguments = call.name === REPLACE_PHASE_CONTINUITY_TOOL_NAME &&
      validation.error === null && Array.isArray(validation.arguments.operations)
    ? withoutCompactReplayCarrierOperations(validation.arguments)
    : validation.arguments;
  return {
    call: {
      ...call,
      arguments: persistedCarrierDiagnostic
        ? call.arguments
        : executionArguments,
      rawArguments: persistedCarrierDiagnostic
        ? validation.rawArguments
        : JSON.stringify(executionArguments),
    },
    tool,
    validationError: tool
      ? validation.error
      : `No such tool available: ${call.name}`,
  };
}

export async function executePreparedBtccToolCall(
  input: Pick<BtccAgentLoopInput, "executeTool">,
  prepared: PreparedBtccToolCall,
  operationBatch: { id: string; ordinal: number },
  signal?: AbortSignal,
): Promise<BtccAgentLoopToolResult> {
  const compactReplayGate = prepared.compactReplayExecutionGate;
  if (compactReplayGate?.rejection) {
    return createBtccOperationRejectedResult({
      call: prepared.call,
      ...compactReplayRejectionForArguments(
        compactReplayGate.rejection,
        prepared.call.arguments,
      ),
    });
  }
  if (compactReplayGate && operationBatch.ordinal > 0 &&
    !compactReplayGate.phaseContinuityRewritten) {
    return createBtccOperationRejectedResult({
      call: prepared.call,
      ...compactReplayContinuityRewriteFailure(prepared.call.arguments),
    });
  }
  if (prepared.validationError) {
    const observation = invalidArgumentsObservation({
      call: prepared.call,
      message: prepared.validationError,
    });
    return {
      toolCallId: prepared.call.id,
      name: prepared.call.name,
      ok: false,
      error: observation.summary,
      output: {
        ok: false,
        observation,
        observation_kind: observation.kind,
        summary: observation.summary,
        model_visible_content: observation.modelVisibleContent,
      },
      compactReplay: {
        kind: "operation_rejected",
        code: observation.kind,
        toolName: prepared.call.name,
        summary: observation.summary.slice(0, 1_000),
      },
    };
  }

  try {
    const output = await input.executeTool({
      id: prepared.call.id,
      name: prepared.call.name,
      arguments: prepared.call.arguments,
      rawArguments: prepared.call.rawArguments,
      operationBatchId: operationBatch.id,
      operationBatchOrdinal: operationBatch.ordinal,
      signal,
    });
    if (compactReplayGate && operationBatch.ordinal === 0 &&
      (!isBtccToolExecutionEnvelope(output) ||
        output.compactReplay.kind !== "phase_continuity")) {
      return createBtccOperationRejectedResult({
        call: prepared.call,
        ...compactReplayContinuityRewriteFailure(prepared.call.arguments),
      });
    }
    if (isBtccToolExecutionEnvelope(output)) {
      if (compactReplayGate && operationBatch.ordinal === 0) {
        compactReplayGate.phaseContinuityRewritten = true;
      }
      return {
        toolCallId: prepared.call.id,
        name: prepared.call.name,
        ok: true,
        output: output.output,
        compactReplay: output.compactReplay,
      };
    }
    return {
      toolCallId: prepared.call.id,
      name: prepared.call.name,
      ok: true,
      output,
    };
  } catch (error) {
    if (error instanceof TurnContinuationBudgetExhaustedError ||
        error instanceof TurnContinuationBudgetStorageError) throw error;
    if (compactReplayGate && operationBatch.ordinal === 0) {
      return createBtccOperationRejectedResult({
        call: prepared.call,
        ...compactReplayContinuityRewriteFailure(prepared.call.arguments),
      });
    }
    const summary = (error instanceof Error ? error.message : String(error))
      .slice(0, 1_000);
    return {
      toolCallId: prepared.call.id,
      name: prepared.call.name,
      ok: false,
      error: summary,
      compactReplay: {
        kind: "operation_rejected",
        code: "tool_execution_rejected",
        toolName: prepared.call.name,
        summary,
      },
    };
  }
}

function isBtccToolExecutionEnvelope(
  value: unknown,
): value is BtccToolExecutionEnvelope {
  return Boolean(value && typeof value === "object" &&
    (value as Partial<BtccToolExecutionEnvelope>)[BTCC_TOOL_EXECUTION_ENVELOPE]);
}

function invalidArgumentsObservation(input: {
  call: BtccAgentLoopToolCall;
  message: string;
}) {
  const kind = input.message.startsWith("No such tool available:")
    ? "tool_unavailable" as const
    : "tool_invalid_arguments" as const;
  return {
    observationId: `obs-${input.call.id}`,
    kind,
    visibility: "model" as const,
    summary: input.message,
    modelVisibleContent: [
      `Tool: ${input.call.name}`,
      `Observation: ${input.message}`,
      `Arguments: ${input.call.rawArguments}`,
      "Use this observation to retry with the tool schema or select an available tool.",
    ].join("\n"),
    causedByToolCallId: input.call.id,
  };
}
