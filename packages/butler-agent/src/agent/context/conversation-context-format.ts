import type {
  ConversationMessageWithParts,
  ConversationPart,
  ConversationSummary,
  PromptMaterial,
} from "../conversation/types.ts";
import {
  estimateContextTokens,
  takeLinesFromEndWithinBudget,
  trimTextToTokenBudget,
} from "./budget.ts";

export interface ConversationContextPart {
  kind: ConversationPart["kind"];
  text: string | null;
  tool_call_id: string | null;
  parent_tool_call_id: string | null;
  provider_shape: ConversationPart["provider_shape"];
  status: ConversationPart["status"];
}

export interface ConversationContextMessage {
  conversation_message_id: string;
  turn_id: string | null;
  seq: number;
  created_at: string;
  speaker: "system" | "developer" | "user" | "butler" | "tool";
  role: ConversationMessageWithParts["role"];
  text: string;
  parts: ConversationContextPart[];
}

export interface ConversationContextSummary {
  summary_id: string;
  covers_from_seq: number;
  covers_to_seq: number;
  source_hash: string;
  text: string;
}

export interface PromptMaterialRenderOptions {
  maxTokens: number;
  excludeSourceRef?: string | null;
  includeSummaries?: boolean;
}

export function renderPromptMaterial(
  material: PromptMaterial,
  options: PromptMaterialRenderOptions,
): string {
  const maxTokens = Math.max(1, Math.floor(options.maxTokens));
  const rawSummaryLines = options.includeSummaries === false
    ? []
    : renderSummaryLines(material.summaries);
  const summaryText = rawSummaryLines.join("\n");
  const summaryTokens = estimateContextTokens(summaryText);
  const summaryLines = summaryTokens > maxTokens
    ? [trimTextToTokenBudget(summaryText, maxTokens, { from: "start" })].filter((line) => line.trim())
    : rawSummaryLines;
  const tailBudget = Math.max(0, maxTokens - estimateContextTokens(summaryLines.join("\n")));
  const tailLines = material.semantic_tail
    .filter((message) => !options.excludeSourceRef || message.source_ref !== options.excludeSourceRef)
    .flatMap((message) => renderPromptMessageLines(message));
  const selectedTail = tailBudget > 0 ? takeLinesFromEndWithinBudget(tailLines, tailBudget) : [];
  const lines = [
    ...summaryLines,
    ...selectedTail,
  ].filter((line) => line.trim());
  if (lines.length === 0) return "";
  const header = "## Recent Conversation";
  const bodyBudget = Math.max(1, maxTokens - estimateContextTokens(header));
  const body = trimTextToTokenBudgetStrict(lines.join("\n"), bodyBudget);
  return [header, body].filter((line) => line.trim()).join("\n");
}

export function toContextMessage(
  message: ConversationMessageWithParts,
  includeTools: boolean,
): ConversationContextMessage {
  const parts = message.parts
    .filter((part) => includeTools || (part.kind !== "tool_call" && part.kind !== "tool_result"))
    .map(toContextPart);
  return {
    conversation_message_id: message.id,
    turn_id: message.turn_id,
    seq: message.seq,
    created_at: message.created_at,
    speaker: speakerForRole(message.role),
    role: message.role,
    text: textForParts(parts),
    parts,
  };
}

export function toContextSummary(summary: ConversationSummary): ConversationContextSummary {
  return {
    summary_id: summary.id,
    covers_from_seq: summary.covers_from_seq,
    covers_to_seq: summary.covers_to_seq,
    source_hash: summary.source_hash,
    text: summary.summary_text,
  };
}

export function textForMessage(message: ConversationMessageWithParts, includeTools: boolean): string {
  return textForParts(
    message.parts
      .filter((part) => includeTools || (part.kind !== "tool_call" && part.kind !== "tool_result"))
      .map(toContextPart),
  );
}

function renderSummaryLines(summaries: ConversationSummary[]): string[] {
  return summaries.flatMap((summary) => [
    `summary ${summary.id} seq ${summary.covers_from_seq}-${summary.covers_to_seq}: ${summary.summary_text.trim()}`,
  ]).filter((line) => line.trim());
}

function renderPromptMessageLines(message: ConversationMessageWithParts): string[] {
  const speaker = speakerForRole(message.role);
  const text = textForMessage(message, true);
  if (!text.trim()) return [];
  return [`${speaker}: ${text}`];
}

function speakerForRole(role: ConversationMessageWithParts["role"]): ConversationContextMessage["speaker"] {
  if (role === "assistant") return "butler";
  if (role === "developer") return "developer";
  if (role === "system") return "system";
  if (role === "tool") return "tool";
  return "user";
}

function toContextPart(part: ConversationPart): ConversationContextPart {
  return {
    kind: part.kind,
    text: textForPart(part),
    tool_call_id: part.tool_call_id,
    parent_tool_call_id: part.parent_tool_call_id,
    provider_shape: part.provider_shape,
    status: part.status,
  };
}

function textForParts(parts: ConversationContextPart[]): string {
  return parts
    .map((part) => part.text?.trim() ?? "")
    .filter(Boolean)
    .join(" ")
    .trim();
}

function textForPart(part: ConversationPart): string | null {
  const content = part.content_json;
  if (part.kind === "text") return objectString(content, "text");
  if (part.kind === "attachment_ref") {
    const fileName = objectString(content, "fileName") ?? objectString(content, "filename");
    const id = objectString(content, "id");
    return `[attachment:${[fileName, id].filter(Boolean).join(":") || "ref"}]`;
  }
  if (part.kind === "summary_ref") return objectString(content, "summary_id") ?? "[summary_ref]";
  if (part.kind === "tool_call") {
    const name = objectString(content, "safeToolName") ?? objectString(content, "toolName") ??
      objectString(content, "name") ?? "tool";
    return `[tool_call:${name}:${part.tool_call_id ?? "unknown"}]`;
  }
  if (part.kind === "tool_result") {
    const ok = objectBoolean(content, "ok");
    const label = objectString(content, "safeLabel") ?? objectString(content, "status") ?? (ok === false ? "failed" : "complete");
    return `[tool_result:${label}:${part.parent_tool_call_id ?? part.tool_call_id ?? "unknown"}]`;
  }
  return null;
}

function objectString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function objectBoolean(value: unknown, key: string): boolean | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "boolean" ? raw : null;
}

function trimTextToTokenBudgetStrict(text: string, maxTokens: number): string {
  const trimmed = text.trim();
  if (!trimmed || estimateContextTokens(trimmed) <= maxTokens) return trimmed;
  const marker = "[...trimmed for context budget...]";
  if (estimateContextTokens(marker) > maxTokens) return marker;
  let low = 0;
  let high = trimmed.length;
  let best = marker;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = `${trimmed.slice(0, mid).trimEnd()}\n${marker}`.trim();
    if (estimateContextTokens(candidate) <= maxTokens) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}
