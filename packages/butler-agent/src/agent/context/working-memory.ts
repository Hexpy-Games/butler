import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { createHash } from "crypto";
import { readTranscript, type TranscriptEvent } from "../../test-support/harness/transcripts.ts";

export type WorkingMemoryFactCategory =
  | "holding"
  | "absence"
  | "preference"
  | "achievement"
  | "correction";

export interface WorkingMemoryFact {
  id: string;
  category: WorkingMemoryFactCategory;
  text: string;
  sourceEventId: string;
  sourceMessageId?: string;
  sourceTimestamp?: string;
  lastSeenAt: string;
}

export interface WorkingMemorySnapshot {
  schema: "butler.context.working-memory.v1";
  sessionId: string;
  updatedAt: string;
  facts: WorkingMemoryFact[];
}

export interface WorkingMemoryDiagnostics {
  path: string;
  exists: boolean;
  parseStatus: "missing" | "ok" | "malformed";
  factCount: number;
  renderedCharCount: number;
  updatedAt: string | null;
}

const MAX_FACTS = 80;
const MAX_RENDERED_FACTS = 32;

function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function workingMemoryPath(input: {
  butlerData: string;
  sessionId: string;
}): string {
  return join(input.butlerData, "context", "working-memory", `${safeSessionId(input.sessionId)}.json`);
}

function stableFactId(category: WorkingMemoryFactCategory, text: string): string {
  const hash = createHash("sha256")
    .update(`${category}\n${normalizeFactText(text)}`)
    .digest("hex")
    .slice(0, 16);
  return `${category}:${hash}`;
}

function factSubjectKey(category: WorkingMemoryFactCategory, text: string): string {
  const normalized = normalizeFactText(text);
  const hash = createHash("sha256")
    .update(`${category}\n${normalized}`)
    .digest("hex")
    .slice(0, 16);
  return `${category}:${hash}`;
}

function normalizeFactText(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

export function extractWorkingMemoryFacts(text: string): Array<Pick<WorkingMemoryFact, "category" | "text">> {
  void text;
  return [];
}

function inboundText(event: TranscriptEvent): string {
  if (event.kind !== "inbound") return "";
  const payload = event.payload as Record<string, any>;
  const text = payload.message?.text;
  return typeof text === "string" ? text : "";
}

function messageId(event: TranscriptEvent): string | undefined {
  const payload = event.payload as Record<string, any>;
  const id = payload.message?.id;
  return typeof id === "string" ? id : undefined;
}

export function refreshWorkingMemoryFromTranscript(input: {
  butlerData: string;
  sessionId: string;
  excludeEventId?: string | null;
  now?: string;
}): WorkingMemorySnapshot {
  const now = input.now ?? new Date().toISOString();
  const bySubject = new Map<string, WorkingMemoryFact>();

  for (const event of readTranscript(input.sessionId)) {
    if (event.eventId === input.excludeEventId) continue;
    const payload = event.payload as Record<string, any>;
    if (typeof payload.eventId === "string" && payload.eventId === input.excludeEventId) continue;
    const text = inboundText(event);
    if (!text.trim()) continue;
    for (const fact of extractWorkingMemoryFacts(text)) {
      const id = stableFactId(fact.category, fact.text);
      bySubject.set(factSubjectKey(fact.category, fact.text), {
        id,
        category: fact.category,
        text: fact.text,
        sourceEventId: event.eventId,
        sourceMessageId: messageId(event),
        sourceTimestamp: event.timestamp,
        lastSeenAt: now,
      });
    }
  }

  const facts = [...bySubject.values()]
    .sort((left, right) => {
      const byTime = (right.sourceTimestamp ?? "").localeCompare(left.sourceTimestamp ?? "");
      return byTime !== 0 ? byTime : left.text.localeCompare(right.text);
    })
    .slice(0, MAX_FACTS);
  const snapshot: WorkingMemorySnapshot = {
    schema: "butler.context.working-memory.v1",
    sessionId: input.sessionId,
    updatedAt: now,
    facts,
  };

  try {
    const path = workingMemoryPath(input);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  } catch {
    // Working memory improves continuity, but ledger write failures must not
    // block the active user turn. The in-memory snapshot is still injected.
  }
  return snapshot;
}

export function readWorkingMemorySnapshot(input: {
  butlerData: string;
  sessionId: string;
}): WorkingMemorySnapshot | null {
  const path = workingMemoryPath(input);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as WorkingMemorySnapshot;
    if (parsed?.schema !== "butler.context.working-memory.v1") return null;
    if (!Array.isArray(parsed.facts)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readWorkingMemoryDiagnostics(input: {
  butlerData: string;
  sessionId: string;
}): WorkingMemoryDiagnostics {
  const path = workingMemoryPath(input);
  if (!existsSync(path)) {
    return {
      path,
      exists: false,
      parseStatus: "missing",
      factCount: 0,
      renderedCharCount: 0,
      updatedAt: null,
    };
  }

  const snapshot = readWorkingMemorySnapshot(input);
  if (!snapshot) {
    return {
      path,
      exists: true,
      parseStatus: "malformed",
      factCount: 0,
      renderedCharCount: 0,
      updatedAt: null,
    };
  }

  return {
    path,
    exists: true,
    parseStatus: "ok",
    factCount: snapshot.facts.length,
    renderedCharCount: renderWorkingMemoryContext(snapshot).length,
    updatedAt: snapshot.updatedAt,
  };
}

export function renderWorkingMemoryContext(snapshot: WorkingMemorySnapshot | null): string {
  const facts = snapshot?.facts ?? [];
  if (facts.length === 0) return "";
  const lines = [
    "## Working Memory",
    "Use these active-session facts before asking the user to repeat themselves. Treat them as compact transcript-backed continuity notes.",
  ];
  for (const fact of facts.slice(0, MAX_RENDERED_FACTS)) {
    const source = fact.sourceMessageId ? `message=${fact.sourceMessageId}` : `event=${fact.sourceEventId}`;
    lines.push(`- [${fact.category}] ${fact.text} (${source})`);
  }
  return lines.join("\n");
}
