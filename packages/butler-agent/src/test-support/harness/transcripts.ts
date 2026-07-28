import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { randomUUID } from "crypto";
import { homedir } from "os";
import { join } from "path";

export type TranscriptEventKind =
  | "inbound"
  | "outbound"
  | "delivery"
  | "turn"
  | "tool_call"
  | "tool_result"
  | "worker_status"
  | "session_status"
  | "memory_note"
  | "system";

export interface TranscriptEvent {
  eventId: string;
  sessionId: string;
  kind: TranscriptEventKind;
  timestamp: string;
  payload: Record<string, unknown>;
  transport?: string;
  metadata?: Record<string, unknown>;
}

interface CreateTranscriptEventInput {
  sessionId: string;
  kind: TranscriptEventKind;
  payload: Record<string, unknown>;
  eventId?: string;
  timestamp?: string;
  transport?: string;
  metadata?: Record<string, unknown>;
}

function getButlerData(butlerData?: string): string {
  return butlerData || process.env.BUTLER_DATA || join(homedir(), ".butler");
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function transcriptsDir(butlerData?: string): string {
  return join(getButlerData(butlerData), "transcripts");
}

export function transcriptPath(sessionId: string, butlerData?: string): string {
  return join(transcriptsDir(butlerData), `${sanitizeSessionId(sessionId)}.jsonl`);
}

export function createTranscriptEvent(input: CreateTranscriptEventInput): TranscriptEvent {
  return {
    eventId: input.eventId?.trim() || randomUUID(),
    sessionId: input.sessionId,
    kind: input.kind,
    timestamp: input.timestamp || new Date().toISOString(),
    payload: input.payload,
    transport: input.transport,
    metadata: input.metadata,
  };
}

export function appendTranscriptEvent(event: TranscriptEvent, butlerData?: string): void {
  const path = transcriptPath(event.sessionId, butlerData);
  mkdirSync(transcriptsDir(butlerData), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
}

export function readTranscript(sessionId: string, butlerData?: string): TranscriptEvent[] {
  const path = transcriptPath(sessionId, butlerData);
  if (!existsSync(path)) return [];

  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return [];

  const events: TranscriptEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as TranscriptEvent;
      if (
        typeof parsed?.eventId === "string" &&
        typeof parsed?.sessionId === "string" &&
        typeof parsed?.kind === "string" &&
        typeof parsed?.timestamp === "string" &&
        parsed?.payload &&
        typeof parsed.payload === "object"
      ) {
        events.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return events;
}
