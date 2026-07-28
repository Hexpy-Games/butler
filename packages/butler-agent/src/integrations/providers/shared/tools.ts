import type { AgentLoopMessage, AgentLoopModelResponse, AgentLoopToolDefinition } from "../../../agent/model-tool-loop/index.ts";
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
    ...tool,
    parameters: stripNestedDescriptions(tool.parameters) as Record<string, unknown>,
  }));
}



export function activeFunctionTools(options: FunctionToolPromptOptions): FunctionToolDefinition[] {
  const dynamicTools = options.dynamicTools?.();
  return modelFacingFunctionTools(dynamicTools && dynamicTools.length > 0 ? dynamicTools : options.tools);
}



export function withoutDynamicTools(options: FunctionToolPromptOptions): FunctionToolPromptOptions {
  const { dynamicTools: _dynamicTools, ...rest } = options;
  return rest;
}



export function newToolMessages(
  messages: AgentLoopMessage[],
  alreadySent: number,
): {
  items: Array<Record<string, unknown>>;
  sentCount: number;
} {
  const toolMessages = messages.filter((message) => message.role === "tool");
  const next = toolMessages.slice(alreadySent);
  return {
    sentCount: toolMessages.length,
    items: next.map((message) => ({
      type: "function_call_output",
      call_id: message.toolCallId,
      output: message.content,
    })),
  };
}



export function responseToAgentModelResponse(
  response: OpenAIResponse,
  allowedNames: Set<string>,
): AgentLoopModelResponse {
  return {
    text: extractResponseText(response) || undefined,
    raw: response,
    toolCalls: getFunctionCalls(response, allowedNames).map((call) => ({
      id: call.call_id,
      name: call.name,
      arguments: parseToolArguments(call.arguments),
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
} {
  if (typeof raw === "string") {
    return {
      parsed: parseToolArguments(raw),
      raw,
    };
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return {
      parsed: raw as Record<string, unknown>,
      raw: JSON.stringify(raw),
    };
  }
  return {
    parsed: {},
    raw: "{}",
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
  return candidates.find((candidate) => allowedNames.has(candidate)) ?? null;
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
