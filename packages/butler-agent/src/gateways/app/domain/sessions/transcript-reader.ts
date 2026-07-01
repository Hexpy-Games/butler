import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { TranscriptEvent } from "../../../../test-support/harness/transcripts.ts";

export function readTranscriptFromDataHome(
  butlerData: string,
  sessionId: string,
): TranscriptEvent[] {
  return readTranscriptFromPath(
    transcriptPathFromDataHome(butlerData, sessionId),
  );
}

export function transcriptPathFromDataHome(
  butlerData: string,
  sessionId: string,
): string {
  return join(
    butlerData,
    "transcripts",
    `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.jsonl`,
  );
}

export function readTranscriptFromPath(path: string): TranscriptEvent[] {
  if (!existsSync(path)) return [];
  const text = readTranscriptTextFromPath(path);
  return readTranscriptEventsFromText(text).events;
}

export function readTranscriptTextFromPath(path: string): string {
  return readFileSync(path, "utf8");
}

export function readTranscriptTextRange(
  path: string,
  start: number,
  end?: number,
): string {
  const length = Math.max(0, (end ?? statSync(path).size) - start);
  if (length === 0) return "";
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function readTranscriptEventsFromText(text: string): {
  events: TranscriptEvent[];
  trailing: string;
} {
  if (!text.trim()) return { events: [], trailing: "" };
  const lines = text.split("\n");
  let trailing = "";
  if (!text.endsWith("\n")) {
    trailing = lines.pop() ?? "";
  }
  const events: TranscriptEvent[] = [];
  const parseLine = (line: string): boolean => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    try {
      const parsed = JSON.parse(trimmed) as TranscriptEvent;
      if (
        typeof parsed?.sessionId === "string" &&
        typeof parsed?.kind === "string" &&
        typeof parsed?.timestamp === "string" &&
        parsed.payload &&
        typeof parsed.payload === "object"
      ) {
        events.push(parsed);
      }
      return true;
    } catch {
      return false;
    }
  };
  for (const line of lines) {
    parseLine(line);
  }
  if (trailing && parseLine(trailing)) {
    trailing = "";
  }
  return { events, trailing };
}
