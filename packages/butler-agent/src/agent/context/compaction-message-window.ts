import type { ConversationMessageWithParts } from "../conversation/types.ts";
import {
  estimateContextTokens,
  trimTextToTokenBudget,
} from "./budget.ts";
import type { CompactionSnapshot } from "./compaction-records.ts";

export function messageText(message: ConversationMessageWithParts): string {
  const role = message.role === "assistant" ? "butler" : message.role;
  const parts = message.parts.map((part) => {
    if (part.kind === "text") return objectString(part.content_json, "text");
    if (part.kind === "attachment_ref") {
      const fileName = objectString(part.content_json, "fileName") ?? objectString(part.content_json, "filename");
      const id = objectString(part.content_json, "id");
      return `[attachment:${[fileName, id].filter(Boolean).join(":") || "ref"}]`;
    }
    if (part.kind === "tool_call") {
      const name = objectString(part.content_json, "safeToolName") ?? objectString(part.content_json, "toolName") ??
        objectString(part.content_json, "name") ?? "tool";
      return `[tool_call:${name}:${part.tool_call_id ?? "unknown"}]`;
    }
    if (part.kind === "tool_result") {
      const ok = objectBoolean(part.content_json, "ok");
      return `[tool_result:${ok === false ? "failed" : "complete"}:${part.parent_tool_call_id ?? part.tool_call_id ?? "unknown"}]`;
    }
    if (part.kind === "summary_ref") return "[summary_ref]";
    return null;
  }).filter((part): part is string => Boolean(part?.trim()));
  return parts.length > 0 ? `${role}: ${parts.join(" ")}` : `${role}: [empty semantic message]`;
}

export function effectiveWorkingTextAfterCompaction(
  messages: ConversationMessageWithParts[],
  snapshot: CompactionSnapshot | null,
): string {
  if (!snapshot || snapshot.status !== "ok") return messages.map(messageText).join("\n");
  const unsummarizedMessages = messagesAfterSummarizedRange(messages, snapshot);
  if (!unsummarizedMessages) return messages.map(messageText).join("\n");
  return [
    snapshot.summary.trim() ? `compaction_summary: ${snapshot.summary.trim()}` : "",
    ...unsummarizedMessages.map(messageText),
  ].filter(Boolean).join("\n");
}

export function summarizeMessages(messages: ConversationMessageWithParts[], maxTokens: number): string {
  if (messages.length === 0) return "";
  const lines = messages.map(messageText).filter(Boolean);
  const candidates = [
    ...lines.slice(0, 4),
    ...lines.slice(-4),
  ];
  const unique = Array.from(new Set(candidates));
  const summary = [
    `Canonical messages summarized: ${messages.length}.`,
    ...unique.map((line) => `- ${line}`),
  ].join("\n");
  return trimTextToTokenBudget(summary, maxTokens, { from: "start" });
}

export function chunkMessages(
  messages: ConversationMessageWithParts[],
  chunkTokenBudget: number,
): ConversationMessageWithParts[][] {
  const chunks: ConversationMessageWithParts[][] = [];
  let current: ConversationMessageWithParts[] = [];
  let used = 0;
  for (const message of messages) {
    const tokens = estimateContextTokens(messageText(message));
    if (current.length > 0 && used + tokens > chunkTokenBudget) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(message);
    used += tokens;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function compactionWindow(
  messages: ConversationMessageWithParts[],
  preserveLastMessages: number,
): {
  toSummarize: ConversationMessageWithParts[];
  preserved: ConversationMessageWithParts[];
} {
  if (messages.length === 0) return { toSummarize: [], preserved: [] };
  let boundary = Math.max(0, messages.length - preserveLastMessages);
  for (const group of toolGroups(messages).values()) {
    const firstIndex = Math.min(...group.indexes);
    const beforeBoundary = group.indexes.some((index) => index < boundary);
    const afterBoundary = group.indexes.some((index) => index >= boundary);
    if ((beforeBoundary && afterBoundary) || (beforeBoundary && group.hasCall && !group.hasResult)) {
      boundary = Math.min(boundary, firstIndex);
    }
  }
  return {
    toSummarize: messages.slice(0, boundary),
    preserved: messages.slice(boundary),
  };
}

function messagesAfterSummarizedRange(
  messages: ConversationMessageWithParts[],
  snapshot: CompactionSnapshot,
): ConversationMessageWithParts[] | null {
  const lastSummarizedMessageId = snapshot.summarized_message_range?.last_message_id;
  if (!lastSummarizedMessageId) return messages;
  const lastSummarizedIndex = messages.findIndex((message) => message.id === lastSummarizedMessageId);
  if (lastSummarizedIndex < 0) return null;
  return messages.slice(lastSummarizedIndex + 1);
}

function toolGroups(messages: ConversationMessageWithParts[]): Map<string, {
  indexes: number[];
  hasCall: boolean;
  hasResult: boolean;
}> {
  const groups = new Map<string, {
    indexes: number[];
    hasCall: boolean;
    hasResult: boolean;
  }>();
  for (const [index, message] of messages.entries()) {
    for (const part of message.parts) {
      const id = part.tool_call_id ?? part.parent_tool_call_id;
      if (!id) continue;
      const group = groups.get(id) ?? { indexes: [], hasCall: false, hasResult: false };
      group.indexes = Array.from(new Set([...group.indexes, index]));
      group.hasCall ||= part.kind === "tool_call";
      group.hasResult ||= part.kind === "tool_result";
      groups.set(id, group);
    }
  }
  return groups;
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
