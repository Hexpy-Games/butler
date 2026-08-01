import type {
  AgentLoopInput,
  AgentLoopToolCall,
  AgentLoopToolDefinition,
  AgentLoopToolResult,
} from "./contracts.ts";
import { validateToolCallArguments } from "./schema-validation.ts";

const GENERIC_AGENT_LOOP_TURN_ID = "generic-agent-loop";

export interface PreparedToolCall {
  call: AgentLoopToolCall;
  tool: AgentLoopToolDefinition | undefined;
  validationError: string | null;
}

export function prepareToolCall(
  input: AgentLoopInput,
  call: AgentLoopToolCall,
): PreparedToolCall {
  const tool = input.tools.find((candidate) => candidate.name === call.name);
  const validation = validateToolCallArguments({
    toolName: call.name,
    rawArguments: Object.hasOwn(call, "rawArguments")
      ? call.rawArguments
      : call.arguments,
    schema: tool?.inputSchema,
  });
  const normalizedCall = {
    ...call,
    arguments: validation.arguments,
    rawArguments: validation.rawArguments,
  };
  return {
    call: normalizedCall,
    tool,
    validationError: tool
      ? validation.error
      : `No such tool available: ${call.name}`,
  };
}

export async function executePreparedToolCall(
  input: AgentLoopInput,
  prepared: PreparedToolCall,
): Promise<AgentLoopToolResult> {
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
    };
  }

  return input.executeTool(prepared.call).then(
    (output): AgentLoopToolResult => ({
      toolCallId: prepared.call.id,
      name: prepared.call.name,
      ok: true,
      output,
    }),
    (error): AgentLoopToolResult => ({
      toolCallId: prepared.call.id,
      name: prepared.call.name,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

function invalidArgumentsObservation(input: {
  call: AgentLoopToolCall;
  message: string;
}) {
  const kind = input.message.startsWith("No such tool available:")
    ? "tool_unavailable" as const
    : "tool_invalid_arguments" as const;
  return {
    observationId: `obs-${input.call.id}`,
    turnId: GENERIC_AGENT_LOOP_TURN_ID,
    kind,
    visibility: "model" as const,
    summary: input.message,
    modelVisibleContent: [
      `Tool: ${input.call.name}`,
      `Observation: ${input.message}`,
      `Arguments: ${typeof input.call.rawArguments === "string"
        ? input.call.rawArguments
        : JSON.stringify(input.call.arguments)}`,
      "Use this observation to retry with the tool schema: include required fields, remove unsupported fields, or select an available tool.",
    ].join("\n"),
    causedByToolCallId: input.call.id,
    createdAt: new Date(0).toISOString(),
  };
}
