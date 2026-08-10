import type {
  BtccAgentLoopInput,
  BtccAgentLoopToolCall,
  BtccAgentLoopToolDefinition,
  BtccAgentLoopToolResult,
} from "./contracts.ts";
import { validateToolCallArguments } from "../../tools/schema-validation.ts";
import type { BtccCompactReplayMetadata } from
  "./compact-replay-messages.ts";

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

export interface PreparedBtccToolCall {
  call: BtccAgentLoopToolCall;
  tool: BtccAgentLoopToolDefinition | undefined;
  validationError: string | null;
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
  return {
    call: {
      ...call,
      arguments: validation.arguments,
      rawArguments: validation.rawArguments,
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

  return input.executeTool({
    id: prepared.call.id,
    name: prepared.call.name,
    arguments: prepared.call.arguments,
    rawArguments: prepared.call.rawArguments,
    operationBatchId: operationBatch.id,
    operationBatchOrdinal: operationBatch.ordinal,
    signal,
  }).then(
    (output): BtccAgentLoopToolResult => {
      if (isBtccToolExecutionEnvelope(output)) {
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
    },
    (error): BtccAgentLoopToolResult => {
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
    },
  );
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
