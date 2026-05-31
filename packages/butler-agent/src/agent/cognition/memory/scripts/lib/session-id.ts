import { createHash } from "crypto";

export interface MemorySessionId {
  original: string;
  storage: string;
}

export function normalizeSessionIdForStorage(sessionId: string): string {
  const trimmed = sessionId.trim();
  const normalized = trimmed.replace(/[^A-Za-z0-9._-]/g, "_");
  if (normalized && normalized.length <= 96) return normalized;
  if (normalized) {
    const hash = createHash("sha256").update(trimmed).digest("hex").slice(0, 24);
    return `${normalized.slice(0, 70)}_${hash}`;
  }
  return "unknown-session";
}

export function memorySessionId(sessionId: string): MemorySessionId {
  return {
    original: sessionId,
    storage: normalizeSessionIdForStorage(sessionId),
  };
}

export function memoryChunkSessionId(sessionId: string, chunkIndex: number): MemorySessionId {
  return {
    original: sessionId,
    storage: `${normalizeSessionIdForStorage(sessionId)}_c${chunkIndex}`,
  };
}

export function transcriptFileNameForSessionId(sessionId: string): string {
  return `${normalizeSessionIdForStorage(sessionId)}.jsonl`;
}
