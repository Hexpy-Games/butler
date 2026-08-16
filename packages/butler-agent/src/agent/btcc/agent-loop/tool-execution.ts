import type {
  BtccAgentLoopInput,
  BtccAgentLoopToolCall,
  BtccAgentLoopToolDefinition,
  BtccAgentLoopToolError,
  BtccAgentLoopToolResult,
} from "./contracts.ts";
import { validateToolCallArguments } from "../../tools/schema-validation.ts";

export interface PreparedBtccToolCall {
  call: BtccAgentLoopToolCall;
  tool: BtccAgentLoopToolDefinition | undefined;
  validationError: string | null;
  validationErrorField: string | null;
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
    validationErrorField: tool ? validation.errorField : null,
  };
}

export async function executePreparedBtccToolCall(
  input: Pick<BtccAgentLoopInput, "executeTool">,
  prepared: PreparedBtccToolCall,
  signal?: AbortSignal,
): Promise<BtccAgentLoopToolResult> {
  if (prepared.validationError) {
    return {
      toolCallId: prepared.call.id,
      name: prepared.call.name,
      ok: false,
      error: {
        code: prepared.tool ? "invalid_arguments" : "tool_unavailable",
        message: prepared.validationError,
        ...(prepared.validationErrorField
          ? { field: prepared.validationErrorField }
          : {}),
      },
    };
  }

  return input.executeTool({
    id: prepared.call.id,
    name: prepared.call.name,
    arguments: prepared.call.arguments,
    rawArguments: prepared.call.rawArguments,
    signal,
  }).then(
    (output): BtccAgentLoopToolResult => {
      const error = resolvedToolFailure(output);
      return error
        ? {
            toolCallId: prepared.call.id,
            name: prepared.call.name,
            ok: false,
            error,
            output,
          }
        : {
            toolCallId: prepared.call.id,
            name: prepared.call.name,
            ok: true,
            output,
          };
    },
    (error): BtccAgentLoopToolResult => ({
      toolCallId: prepared.call.id,
      name: prepared.call.name,
      ok: false,
      error: {
        code: "tool_execution_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    }),
  );
}

function resolvedToolFailure(output: unknown): BtccAgentLoopToolError | null {
  const result = objectRecord(output);
  if (!result || result.ok !== false) return null;
  const nested = objectRecord(result.error);
  const code = nonEmptyText(nested?.code) ?? nonEmptyText(result.error) ??
    "tool_failed";
  const message = nonEmptyText(nested?.message) ?? nonEmptyText(result.message) ??
    "Tool failed.";
  const field = nonEmptyText(nested?.field);
  return { code, message, ...(field ? { field } : {}) };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
