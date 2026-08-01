import {
  type AgentLoopMessage,
  type AgentLoopModelResponse,
  type AgentLoopToolDefinition,
  type ToolCallArgumentsValidation,
  validateToolCallArguments,
} from "../../../agent/model-tool-loop/index.ts";
import { agentLoopImageDataUrl } from
  "../../../agent/model-tool-loop/tool-result-media.ts";
import type { FunctionToolCall, FunctionToolDefinition, FunctionToolPromptOptions, OpenAIResponse } from "../runtime-contracts.ts";
import { extractResponseText } from "./usage.ts";



export function normalizeFunctionToolCallName(rawName: unknown, allowedNames?: Set<string>): string | null {
  if (typeof rawName !== "string") return null;
  const name = rawName.trim();
  if (!name) return null;
  if (allowedNames && !allowedNames.has(name)) return null;
  return name;
}



export function getFunctionCalls(response: OpenAIResponse, allowedNames?: Set<string>): FunctionToolCall[] {
  const calls = Array.isArray(response.output) ? response.output : [];
  return calls.flatMap((item: any): FunctionToolCall[] => {
    const name = normalizeFunctionToolCallName(item?.name, allowedNames);
    if (
      item?.type !== "function_call" ||
      !name ||
      typeof item.call_id !== "string" ||
      typeof item.arguments !== "string"
    ) {
      return [];
    }
    return [{
      call_id: item.call_id,
      name,
      arguments: item.arguments,
    }];
  });
}



export function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}



export function functionToolToAgentTool(tool: FunctionToolDefinition): AgentLoopToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as AgentLoopToolDefinition["inputSchema"],
    concurrencySafe: tool.concurrencySafe,
  };
}



export function stripNestedDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNestedDescriptions);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "description") continue;
    output[key] = stripNestedDescriptions(nested);
  }
  return output;
}



export function modelFacingFunctionTools(tools: readonly FunctionToolDefinition[]): FunctionToolDefinition[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: stripNestedDescriptions(tool.parameters) as Record<string, unknown>,
  }));
}



export function activeFunctionTools(options: FunctionToolPromptOptions): FunctionToolDefinition[] {
  const dynamicTools = options.dynamicTools?.();
  const tools = dynamicTools && dynamicTools.length > 0 ? dynamicTools : options.tools;
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: stripNestedDescriptions(tool.parameters) as Record<string, unknown>,
    ...(tool.concurrencySafe === undefined
      ? {}
      : { concurrencySafe: tool.concurrencySafe }),
  }));
}



export function withoutDynamicTools(options: FunctionToolPromptOptions): FunctionToolPromptOptions {
  const { dynamicTools: _dynamicTools, ...rest } = options;
  return rest;
}



export function newToolMessages(
  messages: AgentLoopMessage[],
  alreadySent: number,
  butlerData?: string,
): {
  items: Array<Record<string, unknown>>;
  statelessItems: Array<Record<string, unknown>>;
  sentCount: number;
} {
  const toolMessages = messages.filter((message) => message.role === "tool");
  const next = toolMessages.slice(alreadySent);
  const statelessItems = next.map((message) => ({
    type: "function_call_output",
    call_id: message.toolCallId,
    output: message.content,
  }));
  return {
    sentCount: toolMessages.length,
    statelessItems,
    items: next.map((message) => {
      const images = (message.imageAttachments ?? []).flatMap((attachment) => {
        const imageUrl = agentLoopImageDataUrl(attachment, butlerData);
        return imageUrl
          ? [{ type: "input_image", image_url: imageUrl, detail: "high" }]
          : [];
      });
      return {
        type: "function_call_output",
        call_id: message.toolCallId,
        output: images.length > 0
          ? [{ type: "input_text", text: message.content }, ...images]
          : message.content,
      };
    }),
  };
}



export function responseToAgentModelResponse(
  response: OpenAIResponse,
  _allowedNames?: Set<string>,
): AgentLoopModelResponse {
  return {
    text: extractResponseText(response) || undefined,
    raw: response,
    toolCalls: getFunctionCalls(response).map((call) => ({
      id: call.call_id,
      name: call.name,
      arguments: parseToolArguments(call.arguments),
      rawArguments: call.arguments,
    })),
  };
}



export function finalNoToolInstructions(instructions?: string): string {
  const finalizer = [
    "## Final Answer Synthesis",
    "Do not call any more tools.",
    "Using only the available tool results and conversation context, produce the best user-facing final answer now.",
    "Wrap the final answer in exactly one `<butler_final_answer>...</butler_final_answer>` block.",
    "Do not write any draft, analysis, process notes, or commentary outside that final-answer block.",
    "Do not mention internal loop limits, tool budgets, function calls, response ids, or raw tool JSON.",
    "If the available evidence is incomplete, state the uncertainty briefly and still provide the most useful answer possible.",
    "If web search informed the answer, include concise sources from the provided results.",
    "Preserve the active persona consistently across long answers; do not drop its voice after the opening.",
  ].join("\n");
  return [instructions?.trim(), finalizer].filter(Boolean).join("\n\n");
}



export function finalEnvelopeRetryInstructions(): string {
  return [
    "Your previous response did not include the required final-answer envelope.",
    "Return the user-facing final answer inside exactly one `<butler_final_answer>...</butler_final_answer>` block now.",
    "Do not include any text before or after the block.",
  ].join("\n");
}



export function localToolArguments(raw: unknown): {
  parsed: Record<string, unknown>;
  raw: string;
  valid: boolean;
  error: string | null;
} {
  const validation = validateToolCallArguments({
    toolName: "tool",
    rawArguments: raw,
  });
  return {
    parsed: validation.arguments,
    raw: validation.rawArguments,
    valid: validation.error === null,
    error: validation.error,
  };
}


export const LOCAL_FINAL_ANSWER_OPEN = "<butler_final_answer>";


export const LOCAL_FINAL_ANSWER_CLOSE = "</butler_final_answer>";



export function localFinalAnswerEnvelope(text: string): string | null {
  const lower = text.toLowerCase();
  const open = lower.lastIndexOf(LOCAL_FINAL_ANSWER_OPEN);
  if (open < 0) return null;
  const bodyStart = open + LOCAL_FINAL_ANSWER_OPEN.length;
  const close = lower.indexOf(LOCAL_FINAL_ANSWER_CLOSE, bodyStart);
  if (close < 0) {
    const openEnded = text.slice(bodyStart).trim();
    return openEnded || null;
  }
  const body = text.slice(bodyStart, close).trim();
  return body || null;
}



export function normalizeLocalTextToolName(rawName: string, allowedNames: Set<string>): string | null {
  const trimmed = rawName.trim();
  if (!trimmed) return null;
  const segments = trimmed.split(":").map((segment) => segment.trim()).filter(Boolean);
  const candidates = [
    trimmed,
    segments.length > 0 ? segments[segments.length - 1] : "",
  ].filter(Boolean);
  // Prefer the exact advertised name (including a known namespaced alias), but
  // preserve an explicit unknown structured call so the runtime can return
  // ordinary, model-visible tool feedback instead of silently deleting it.
  return candidates.find((candidate) => allowedNames.has(candidate))
    ?? candidates[candidates.length - 1]
    ?? null;
}

export function unavailableFunctionToolPayload(input: {
  name: string;
  args: Record<string, unknown>;
  allowedNames: ReadonlySet<string>;
}): Record<string, unknown> | null {
  if (input.allowedNames.has(input.name)) return null;
  const message = `No such tool available: ${input.name}`;
  return {
    ok: false,
    error: message,
    output: {
      ok: false,
      error: { code: "tool_unavailable", message },
      observation_kind: "tool_unavailable",
      model_visible_content: [
        `Tool: ${input.name}`,
        `Observation: ${message}`,
        `Arguments: ${JSON.stringify(input.args)}`,
        "Select one of the currently available tools or continue without it.",
      ].join("\n"),
    },
  };
}

export interface PreparedFunctionToolCall {
  args: Record<string, unknown>;
  rawArguments: string;
  errorPayload: Record<string, unknown> | null;
}

export function prepareFunctionToolCall(input: {
  name: string;
  rawArguments: unknown;
  tools: readonly FunctionToolDefinition[];
}): PreparedFunctionToolCall {
  const tool = input.tools.find((candidate) => candidate.name === input.name);
  const validation = validateToolCallArguments({
    toolName: input.name,
    rawArguments: input.rawArguments,
    schema: tool?.parameters,
  });
  const unavailable = unavailableFunctionToolPayload({
    name: input.name,
    args: validation.arguments,
    allowedNames: new Set(input.tools.map((candidate) => candidate.name)),
  });
  return {
    args: validation.arguments,
    rawArguments: validation.rawArguments,
    errorPayload: unavailable ?? invalidFunctionToolArgumentsPayload({
      name: input.name,
      validation,
    }),
  };
}

function invalidFunctionToolArgumentsPayload(input: {
  name: string;
  validation: ToolCallArgumentsValidation;
}): Record<string, unknown> | null {
  const message = input.validation.error;
  if (!message) return null;
  return {
    ok: false,
    error: message,
    output: {
      ok: false,
      error: { code: "tool_invalid_arguments", message },
      observation_kind: "tool_invalid_arguments",
      model_visible_content: [
        `Tool: ${input.name}`,
        `Observation: ${message}`,
        `Arguments: ${input.validation.rawArguments}`,
        "Use this observation to retry with arguments that match the tool schema, or continue without the tool.",
      ].join("\n"),
    },
  };
}



export function localFunctionToolInstructions(instructions?: string): string {
  return [
    instructions?.trim(),
    "When a request depends on current, external, public, or user-environment state, choose and call the appropriate tool from the provided tool catalog before answering. Do not ask the user to name the tool.",
    "When a tool is needed, use only the structured tool-call channel provided by the API (`message.tool_calls`) or an explicit backend-native `<|tool_call>...<tool_call|>` marker. Do not write pseudo tool calls, raw function-call syntax, Markdown code, JSON tool calls, or process notes as a substitute for a tool call. If you cannot call a tool, answer directly and say what cannot be verified.",
    "For local config, manifest, script, or log inspection, prefer a focused command that returns only the requested fields. Do not dump a whole file when a case-insensitive search or structured extraction can answer the question.",
  ].filter(Boolean).join("\n\n");
}


export const LOCAL_TOOL_RESULT_COMPACT_MARKER = "[...compacted local tool result for context budget...]";



export function estimateToolResultTokens(source: string): number {
  return Math.ceil(source.length / 4);
}



export function trimTextToTokenBudgetBalanced(text: string, maxTokens: number): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (estimateToolResultTokens(trimmed) <= maxTokens) return trimmed;
  const marker = `\n${LOCAL_TOOL_RESULT_COMPACT_MARKER}\n`;
  const maxChars = Math.max(80, Math.trunc(maxTokens) * 4 - marker.length);
  const headChars = Math.max(20, Math.floor(maxChars * 0.55));
  const tailChars = Math.max(20, maxChars - headChars);
  return [
    trimmed.slice(0, headChars).trimEnd(),
    marker.trim(),
    trimmed.slice(Math.max(0, trimmed.length - tailChars)).trimStart(),
  ].filter(Boolean).join("\n");
}
