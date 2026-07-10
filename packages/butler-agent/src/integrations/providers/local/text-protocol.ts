import type { FunctionToolDefinition } from "../runtime-contracts.ts";
import type { LocalModelConfig } from "./models.ts";
import { findFirstLocalTextToolCallMarker } from "./tool-call-protocol.ts";
import { localFinalAnswerEnvelope } from "../shared/runtime-support.ts";




export interface LocalChatToolCall {
  id: string;
  type?: "function";
  function: {
    name: string;
    arguments: string | Record<string, unknown>;
  };
}




export interface LocalChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | Array<Record<string, unknown>>;
  tool_calls?: LocalChatToolCall[];
  tool_call_id?: string;
  name?: string;
}




export function localChatUrl(config: LocalModelConfig): string {
  return `${config.api_base_url.replace(/\/+$/u, "")}/chat/completions`;
}




export function localChatTools(tools: FunctionToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}




export function localReasoningRequestParams(config: LocalModelConfig): Record<string, unknown> {
  if (config.platform !== "llama_cpp") return {};
  const ratio = config.reasoning_budget_ratio;
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio <= 0) return {};
  const maxOutputTokens = Number.isFinite(config.max_output_tokens)
    ? Math.trunc(config.max_output_tokens)
    : 0;
  if (maxOutputTokens <= 0) return {};
  const budget = Math.round(maxOutputTokens * Math.min(1, ratio));
  return budget > 0 ? { thinking_budget_tokens: budget } : {};
}




export const MAX_LOCAL_TEXT_TOOL_CALLS = 8;



export const MAX_LOCAL_TEXT_TOOL_SCAN_LENGTH = 64_000;



export const MAX_LOCAL_TEXT_TOOL_CALL_BODY_LENGTH = 20_000;



export const MAX_LOCAL_TEXT_TOOL_ARGUMENTS_LENGTH = 8_000;



export const LOCAL_TEXT_TOOL_CALL_OPEN_MARKERS = ["<|tool_call>", "<|tool_call|>", "<tool_call>"];



export const LOCAL_TEXT_TOOL_CALL_CLOSE_MARKERS = ["<tool_call|>", "<|/tool_call|>", "</tool_call>"];




export function localAssistantRawText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => typeof part?.text === "string" ? part.text : "")
      .filter(Boolean)
      .join("\n");
  }
  return "";
}




export function extractLocalChatText(message: any): string {
  return sanitizeLocalAssistantText(localAssistantRawText(message).trim());
}




export function extractLocalFinalEnvelopeText(message: any): string {
  const raw = localAssistantRawText(message).trim().replace(/\r\n?/gu, "\n");
  if (!raw) return "";
  const envelope = localFinalAnswerEnvelope(raw);
  if (envelope === null) return "";
  return sanitizeLocalAssistantText(envelope);
}




export function sanitizeLocalAssistantText(raw: string): string {
  let text = raw.replace(/\r\n?/gu, "\n");
  const finalEnvelope = localFinalAnswerEnvelope(text);
  if (finalEnvelope !== null) {
    text = finalEnvelope;
  }
  const protocolScanText = maskFencedCodeBlocks(text);
  const hasReasoningSignal = hasLocalReasoningProtocolSignal(protocolScanText);
  const finalStart = lastVisibleFinalMarkerEnd(protocolScanText, hasReasoningSignal);
  if (finalStart !== null) {
    text = text.slice(finalStart);
  }
  const fencedBlocks: string[] = [];
  text = preserveFencedCodeBlocks(text, fencedBlocks);
  text = text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/giu, "");
  text = text.replace(/<think\b[^>]*>[\s\S]*$/iu, "");
  text = stripLocalTextToolCallBlocks(text);
  text = text.replace(/<\|[^>]*\|>/gu, "");
  text = text.replace(/<\/?s>/giu, "");
  text = text.replace(/<\/?(?:channel|message|start|end|analysis|final)\|[^>]*>/giu, "");
  if (hasReasoningSignal) {
    text = text.replace(/^\s*(?:analysis|reasoning)\s*:\s*$/gimu, "");
  }
  text = restoreFencedCodeBlocks(text, fencedBlocks);
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/gu, ""))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}




export function stripLocalTextToolCallBlocks(text: string): string {
  let output = "";
  let cursor = 0;
  while (cursor < text.length) {
    const open = findFirstLocalTextToolCallMarker(text, LOCAL_TEXT_TOOL_CALL_OPEN_MARKERS, cursor);
    if (!open) return output + text.slice(cursor);
    output += text.slice(cursor, open.index);
    const bodyStart = open.index + open.marker.length;
    const close = findFirstLocalTextToolCallMarker(text, LOCAL_TEXT_TOOL_CALL_CLOSE_MARKERS, bodyStart);
    if (!close) return output;
    cursor = close.index + close.marker.length;
  }
  return output;
}




export function hasLocalReasoningProtocolSignal(text: string): boolean {
  return /<think\b|<\|channel\|analysis\|>|<channel\|analysis>|(?:^|\n)\s*(?:analysis|reasoning)\s*:/iu
    .test(text);
}




export function maskFencedCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, (block) => " ".repeat(block.length));
}




export function preserveFencedCodeBlocks(text: string, fencedBlocks: string[]): string {
  return text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, (block) => {
    const index = fencedBlocks.push(block) - 1;
    return `\uE000${index}\uE001`;
  });
}




export function restoreFencedCodeBlocks(text: string, fencedBlocks: string[]): string {
  return text.replace(/\uE000(\d+)\uE001/gu, (_token, index: string) => {
    return fencedBlocks[Number(index)] ?? "";
  });
}




export function escapeRegExpText(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}




export function standaloneLocalFunctionCallNames(text: string, allowedNames: Set<string>): string[] {
  if (!text.trim() || allowedNames.size === 0 || text.length > MAX_LOCAL_TEXT_TOOL_SCAN_LENGTH) return [];
  const scanText = maskFencedCodeBlocks(text);
  const matches = new Set<string>();
  for (const name of allowedNames) {
    if (!name) continue;
    const pattern = new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRegExpText(name)}\\s*\\(`, "u");
    if (pattern.test(scanText)) matches.add(name);
  }
  return [...matches];
}




export function localToolsForRequiredRepair(
  tools: FunctionToolDefinition[],
  requiredNames: Set<string> | null,
): FunctionToolDefinition[] {
  if (!requiredNames || requiredNames.size === 0) return tools;
  const narrowed = tools.filter((tool) => requiredNames.has(tool.name));
  return narrowed.length > 0 ? narrowed : tools;
}




export function localFunctionToolContractRepairPrompt(): string {
  return [
    "## Local Tool Call Contract Repair",
    "Your previous response wrote a registered tool call as visible text instead of using the structured tool-call channel.",
    "That text has not been executed and must not be treated as a tool result.",
    "Continue the original user request now. If a tool is needed, choose the appropriate tool from the provided catalog and call it through the API structured `message.tool_calls` channel.",
    "Do not write raw function-call syntax, Markdown code, JSON tool calls, or process notes as a substitute for a tool call.",
    "You must use the structured tool-call channel on this repair turn. Do not answer directly unless no tool is available in the provided catalog.",
  ].join("\n");
}




export function lastVisibleFinalMarkerEnd(text: string, allowTextualFinalMarker: boolean): number | null {
  const patterns = [
    /<\|channel\|final\|>/giu,
    /<channel\|final>/giu,
  ];
  if (allowTextualFinalMarker) {
    patterns.push(
      /(?:^|\n)\s*final\s*:/giu,
      /(?:^|\n)\s*assistant_final\s*:/giu,
    );
  }
  let latestEnd: number | null = null;
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined) continue;
      const end = match.index + match[0].length;
      if (latestEnd === null || end > latestEnd) {
        latestEnd = end;
      }
    }
  }
  return latestEnd;
}
