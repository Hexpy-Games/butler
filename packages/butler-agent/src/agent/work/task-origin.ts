import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { cognitionMemoryRoot } from "../cognition/paths.ts";
import type { InboundEnvelope } from "../../test-support/harness/contracts.ts";
import { readTranscript, transcriptPath, type TranscriptEvent } from "../../test-support/harness/transcripts.ts";

export interface TaskOriginTranscriptRef {
  session_id: string;
  path: string;
  origin_event_id: string | null;
  origin_message_id: string | null;
  recent_event_ids: string[];
}

export interface TaskOriginMemoryRef {
  kind: "hot" | "graph" | "vector" | "unknown";
  id: string;
  description?: string;
}

export type TaskCompletionOwner = "app" | "native";

export interface TaskCompletionRouting {
  owner: TaskCompletionOwner;
  target_transport: "app" | "native";
  target_session_id: string;
  review_owner: "completion-router";
  delivery_policy: "public-report";
}

export interface TaskOriginContext {
  version: 1;
  origin_session_id: string;
  origin_message_id: string | null;
  origin_inbound_event_id: string | null;
  task_summary: string;
  created_at: string;
  project: string | null;
  topic_summary: string | null;
  transcript_ref: TaskOriginTranscriptRef;
  memory_refs: TaskOriginMemoryRef[];
  completion?: TaskCompletionRouting;
}

export interface BuildTaskOriginContextInput {
  sessionId: string;
  taskSummary: string;
  project: string | null;
  inbound?: InboundEnvelope | null;
  topicSummary?: string | null;
  createdAt?: string;
}

export interface ResolvedTaskOriginContext {
  origin: TaskOriginContext;
  transcript_events: TranscriptEvent[];
  memory_snippets: Array<{
    source: string;
    text: string;
  }>;
}

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function recentTranscriptEventIds(sessionId: string, originEventId: string | null): string[] {
  const events = readTranscript(sessionId);
  const recent = events
    .filter((event) => event.eventId !== originEventId)
    .map((event) => event.eventId)
    .slice(-12);
  if (originEventId) recent.push(originEventId);
  return recent;
}

export function buildTaskOriginContext(input: BuildTaskOriginContextInput): TaskOriginContext {
  const originInboundEventId = trimOrNull(input.inbound?.eventId);
  const originMessageId = trimOrNull(input.inbound?.message.id);
  const completionOwner: TaskCompletionOwner = input.sessionId.startsWith("butler/app-") ? "app" : "native";
  return {
    version: 1,
    origin_session_id: input.sessionId,
    origin_message_id: originMessageId,
    origin_inbound_event_id: originInboundEventId,
    task_summary: input.taskSummary.trim().slice(0, 1_000),
    created_at: input.createdAt ?? new Date().toISOString(),
    project: trimOrNull(input.project),
    topic_summary: trimOrNull(input.topicSummary),
    transcript_ref: {
      session_id: input.sessionId,
      path: transcriptPath(input.sessionId),
      origin_event_id: originInboundEventId,
      origin_message_id: originMessageId,
      recent_event_ids: recentTranscriptEventIds(input.sessionId, originInboundEventId),
    },
    memory_refs: [],
    completion: {
      owner: completionOwner,
      target_transport: completionOwner === "app" ? "app" : "native",
      target_session_id: input.sessionId,
      review_owner: "completion-router",
      delivery_policy: "public-report",
    },
  };
}

export function taskOriginPath(taskDir: string): string {
  return join(taskDir, "origin.json");
}

export function readTaskOrigin(taskDir: string): TaskOriginContext | null {
  const path = taskOriginPath(taskDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as TaskOriginContext;
    if (
      parsed?.version === 1 &&
      typeof parsed.origin_session_id === "string" &&
      typeof parsed.task_summary === "string" &&
      parsed.transcript_ref &&
      typeof parsed.transcript_ref.path === "string"
    ) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

export function writeTaskOrigin(taskDir: string, origin: TaskOriginContext): void {
  writeFileSync(taskOriginPath(taskDir), `${JSON.stringify(origin, null, 2)}\n`, "utf8");
}

function readTranscriptFromOrigin(origin: TaskOriginContext): TranscriptEvent[] {
  const ids = new Set(origin.transcript_ref.recent_event_ids);
  const events = readTranscript(origin.origin_session_id);
  if (ids.size === 0) return events.slice(-12);
  return events.filter((event) =>
    ids.has(event.eventId) ||
    ids.has(String((event.payload as Record<string, unknown>)?.eventId ?? "")),
  );
}

function collectMarkdownFiles(dir: string, output: string[] = []): string[] {
  if (!existsSync(dir)) return output;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      collectMarkdownFiles(path, output);
    } else if (entry.endsWith(".md")) {
      output.push(path);
    }
  }
  return output;
}

function findMemorySnippets(input: {
  butlerData: string;
  origin: TaskOriginContext;
  limit?: number;
}): ResolvedTaskOriginContext["memory_snippets"] {
  const hotDir = join(cognitionMemoryRoot(input.butlerData), "hot");
  const needles = [
    input.origin.origin_session_id,
    input.origin.task_summary,
    input.origin.topic_summary ?? "",
    input.origin.origin_inbound_event_id ?? "",
  ]
    .map((value) => value.trim())
    .filter((value) => value.length >= 3);
  if (needles.length === 0) return [];

  const snippets: ResolvedTaskOriginContext["memory_snippets"] = [];
  for (const path of collectMarkdownFiles(hotDir)) {
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const matched = needles.some((needle) => text.includes(needle));
    if (!matched) continue;
    snippets.push({
      source: path,
      text: text.slice(0, 2_000),
    });
    if (snippets.length >= (input.limit ?? 3)) break;
  }
  return snippets;
}

export function resolveTaskOriginContext(input: {
  taskDir: string;
  butlerData: string;
}): ResolvedTaskOriginContext | null {
  const origin = readTaskOrigin(input.taskDir);
  if (!origin) return null;
  return {
    origin,
    transcript_events: readTranscriptFromOrigin(origin),
    memory_snippets: findMemorySnippets({
      butlerData: input.butlerData,
      origin,
    }),
  };
}
