import { createHash } from "node:crypto";
import { AgentConversationStore } from "../../../conversation/store.ts";
import { conversationMessageText } from "../../../conversation/message-text.ts";
import type {
  ConversationMessageWithParts,
  ConversationPart,
} from "../../../conversation/types.ts";
import type { ExtractInput, ResolvedMemorySource } from "./contracts.ts";
import {
  sourceRows,
  type ProjectionSourceRow,
  openProjectionDb,
} from "./store.ts";

export function decodeMessageScalars(message: ConversationMessageWithParts) {
  return message.parts.flatMap((part) => decodePart(message, part));
}

function decodePart(
  message: ConversationMessageWithParts,
  part: ConversationPart,
): Array<{
  message: ConversationMessageWithParts;
  part: ConversationPart;
  pointer: string;
  text: string;
  hash: string;
}> {
  const values: Array<{ pointer: string; text: string }> = [];
  if (
    part.kind === "text" &&
    record(part.content_json) &&
    typeof part.content_json.text === "string"
  ) {
    values.push({ pointer: "/text", text: part.content_json.text });
  }
  if (part.kind === "message_content" && Array.isArray(part.content_json)) {
    part.content_json.forEach((item, index) => {
      if (record(item) && typeof item.text === "string")
        values.push({ pointer: `/${index}/text`, text: item.text });
    });
  }
  return values
    .filter((value) => value.text.length > 0)
    .map((value) => ({
      ...value,
      message,
      part,
      hash: createHash("sha256").update(value.text).digest("hex"),
    }));
}

function scalarForPart(part: ConversationPart, pointer: string): string | null {
  if (
    pointer === "/text" &&
    record(part.content_json) &&
    typeof part.content_json.text === "string"
  ) {
    return part.content_json.text;
  }
  const match = /^\/(\d+)\/text$/u.exec(pointer);
  if (match && Array.isArray(part.content_json)) {
    const value = part.content_json[Number(match[1])];
    return record(value) && typeof value.text === "string" ? value.text : null;
  }
  return null;
}

export function hydrateSource(
  butlerData: string,
  row: ProjectionSourceRow,
  maxChars = Number.POSITIVE_INFINITY,
): ResolvedMemorySource {
  const store = new AgentConversationStore({ butlerData });
  try {
    const message = store.readMessageById(row.conversation_message_id);
    const part = message?.parts.find((item) => item.id === row.part_id);
    const scalar = part ? scalarForPart(part, row.scalar_pointer) : null;
    if (
      !message ||
      !scalar ||
      createHash("sha256").update(scalar).digest("hex") !== row.content_hash
    ) {
      throw new Error("memory_source_changed");
    }
    const bytes = Buffer.from(scalar, "utf8");
    const text = bytes.subarray(row.byte_start, row.byte_end).toString("utf8");
    return {
      source_ref: row.source_id,
      text,
      excerpt: [...text].slice(0, maxChars).join(""),
      byte_start: row.byte_start,
      byte_end: row.byte_end,
      source_hash: row.content_hash,
      conversation_session_id: row.conversation_session_id,
      conversation_message_id: row.conversation_message_id,
      basis: row.basis as ResolvedMemorySource["basis"],
    };
  } finally {
    store.close();
  }
}

export function splitUtf8Spans(
  text: string,
  maxBytes: number,
): Array<{ start: number; end: number }> {
  const segments = [
    ...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text),
  ];
  const spans: Array<{ start: number; end: number }> = [];
  let start = 0;
  let end = 0;
  for (const segment of segments) {
    const next = end + Buffer.byteLength(segment.segment);
    if (next - start > maxBytes && end > start) {
      spans.push({ start, end });
      start = end;
    }
    end = next;
  }
  if (end > start) spans.push({ start, end });
  return spans;
}

export function packWindows(
  refs: string[],
  db: ReturnType<typeof openProjectionDb>,
  maxBytes: number,
): string[][] {
  const rows = sourceRows(db, refs);
  const output: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const ref of refs) {
    const row = rows.find((item) => item.source_id === ref)!;
    const bytes = row.byte_end - row.byte_start;
    if (current.length && size + bytes > maxBytes) {
      output.push(current);
      current = [];
      size = 0;
    }
    current.push(ref);
    size += bytes;
  }
  if (current.length) output.push(current);
  return output;
}

export function combinedOrigin(
  messages: ConversationMessageWithParts[],
): string {
  if (messages.some((message) => message.origin_kind === "internal_control"))
    return "internal_control";
  if (
    messages.some(
      (message) => !message.origin_kind || message.origin_kind === "unknown",
    )
  )
    return "unknown";
  return "user_input";
}

export function readPriorPublicContext(
  butlerData: string,
  sessionId: string,
  sourceUnits: ExtractInput["source_units"],
): ExtractInput["context_units"] {
  if (!sessionId) return [];
  const firstObservedAt =
    sourceUnits.map((unit) => unit.observed_at).sort()[0] ?? "";
  const store = new AgentConversationStore({ butlerData });
  try {
    return store
      .readMessages({ sessionId, limit: 500 })
      .filter((message) => message.created_at < firstObservedAt)
      .filter(
        (message) =>
          message.status === "complete" || message.status === "compacted",
      )
      .filter(
        (message) =>
          message.origin_kind === "user_input" ||
          message.origin_kind === "assistant_public",
      )
      .filter(
        (message) => message.role === "user" || message.role === "assistant",
      )
      .slice(-2)
      .map((message) => ({
        ref: `conversation-message:${message.id}`,
        text: conversationMessageText(message).slice(-2048),
        observed_at: message.created_at,
        basis:
          message.role === "user"
            ? ("user_statement" as const)
            : ("assistant_statement" as const),
      }))
      .filter((unit) => unit.text.length > 0);
  } finally {
    store.close();
  }
}

export function projectionHash(values: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
