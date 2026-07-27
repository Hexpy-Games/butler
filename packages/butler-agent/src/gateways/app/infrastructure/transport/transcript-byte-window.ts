import { closeSync, openSync, readSync } from "node:fs";
import type { TranscriptEvent } from "../../../../test-support/harness/transcripts.ts";

export const TRANSCRIPT_BYTE_WINDOW = 64 * 1024;
export const TRANSCRIPT_EVENT_WINDOW = 64;
const TRANSCRIPT_BOUNDARY_ANCHOR_BYTES = 64;

export type TranscriptWindowLine = {
  bytes: Buffer;
  endOffset: number;
  remaining: Buffer;
};

export type TranscriptByteWindow = {
  lines: TranscriptWindowLine[];
  remainder: Buffer;
  readEnd: number;
  fileSize: number;
};

export type TranscriptRecordParseResult =
  | { kind: "blank" }
  | { kind: "event"; event: TranscriptEvent }
  | { kind: "invalid"; code: "invalid_utf8" | "invalid_json" | "invalid_record" };

export function readTranscriptByteWindow(input: {
  path: string;
  committedOffset: number;
  trailing: Buffer;
  fileSize: number;
  byteLimit?: number;
  eventLimit?: number;
}): TranscriptByteWindow {
  const byteLimit = input.byteLimit ?? TRANSCRIPT_BYTE_WINDOW;
  const eventLimit = input.eventLimit ?? TRANSCRIPT_EVENT_WINDOW;
  const readStart = input.committedOffset + input.trailing.byteLength;
  const readLength = Math.min(byteLimit, Math.max(0, input.fileSize - readStart));
  const chunk = readLength > 0
    ? readTranscriptBytes(input.path, readStart, readLength)
    : Buffer.alloc(0);
  const combined = input.trailing.byteLength > 0
    ? Buffer.concat([input.trailing, chunk])
    : chunk;
  const lineBoundaries: Array<{ bytes: Buffer; endOffset: number; relativeEnd: number }> = [];
  let lineStart = 0;
  let completeRecords = 0;
  while (completeRecords < eventLimit) {
    const newline = combined.indexOf(0x0a, lineStart);
    if (newline < 0) break;
    const bytes = combined.subarray(lineStart, newline);
    const endOffset = input.committedOffset + newline + 1;
    lineBoundaries.push({ bytes, endOffset, relativeEnd: newline + 1 });
    lineStart = newline + 1;
    if (bytes.toString("utf8").trim()) completeRecords += 1;
  }
  return {
    lines: lineBoundaries.map(({ bytes, endOffset, relativeEnd }) => ({
      bytes,
      endOffset,
      remaining: Buffer.from(combined.subarray(relativeEnd)),
    })),
    remainder: Buffer.from(combined.subarray(lineStart)),
    readEnd: readStart + chunk.byteLength,
    fileSize: input.fileSize,
  };
}

export function parseTranscriptRecord(bytes: Buffer): TranscriptRecordParseResult {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(bytes);
  } catch {
    return { kind: "invalid", code: "invalid_utf8" };
  }
  if (/^[\x20\t\r\n]*$/u.test(text)) return { kind: "blank" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "invalid", code: "invalid_json" };
  }
  if (!isTranscriptEventValue(value)) return { kind: "invalid", code: "invalid_record" };
  return { kind: "event", event: value };
}

export function advanceTranscriptBoundaryAnchor(
  anchor: Buffer,
  line: Buffer,
): Buffer {
  const combined = Buffer.concat([anchor, line, Buffer.from("\n")]);
  return Buffer.from(combined.subarray(
    Math.max(0, combined.byteLength - TRANSCRIPT_BOUNDARY_ANCHOR_BYTES),
  ));
}

export function readTranscriptBoundaryAnchor(path: string, offset: number): Buffer {
  const start = Math.max(0, offset - TRANSCRIPT_BOUNDARY_ANCHOR_BYTES);
  return readTranscriptBytes(path, start, offset - start);
}

export function readTranscriptBytes(
  path: string,
  start: number,
  length: number,
): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const count = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, count);
  } finally {
    closeSync(fd);
  }
}

export function isTranscriptEventValue(value: unknown): value is TranscriptEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.eventId === "string" && Boolean(record.eventId.trim()) &&
    typeof record.sessionId === "string" && Boolean(record.sessionId.trim()) &&
    typeof record.kind === "string" && Boolean(record.kind.trim()) &&
    typeof record.timestamp === "string" && Boolean(record.timestamp.trim()) &&
    Boolean(record.payload && typeof record.payload === "object" &&
      !Array.isArray(record.payload))
  );
}
