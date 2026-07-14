import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cognitionMemoryRoot } from "../paths.ts";
import { appendToQueue, type SyncRequest } from "../memory/scripts/queue.ts";

export const COMPLETION_OBSERVATION_SCHEMA = "butler.conversation-completion-observation.v1" as const;

export interface ConversationCompletionObservation {
  schema_version: typeof COMPLETION_OBSERVATION_SCHEMA;
  job_id: string;
  scope: "project" | "global";
  project_id: string | null;
  runtime_session_id: string;
  conversation_session_id: string;
  conversation_turn_id: string;
  inbound_message_id: string;
  outbound_message_id: string;
  outcome_generation: number;
  completed_at: string;
  integrity_sha256: string;
}

export interface CompletionJobReceipt {
  schema_version: "butler.memory-completion-job-receipt.v1";
  job_id: string;
  completed_at: string;
  hot_cache_receipt: Record<string, unknown> | null;
  index_status: "ok" | "skipped";
}

export function publishConversationCompletionObservation(input: {
  butlerData: string;
  projectId?: string | null;
  runtimeSessionId: string;
  conversationSessionId: string;
  conversationTurnId: string;
  inboundMessageId: string;
  outboundMessageId: string;
  outcomeGeneration: number;
  completedAt: string;
}): ConversationCompletionObservation {
  const scope = input.projectId?.trim() ? "project" as const : "global" as const;
  const jobId = completionJobId(input.conversationTurnId, input.outcomeGeneration);
  const base = {
    schema_version: COMPLETION_OBSERVATION_SCHEMA,
    job_id: jobId,
    scope,
    project_id: input.projectId?.trim() || null,
    runtime_session_id: required(input.runtimeSessionId),
    conversation_session_id: required(input.conversationSessionId),
    conversation_turn_id: required(input.conversationTurnId),
    inbound_message_id: required(input.inboundMessageId),
    outbound_message_id: required(input.outboundMessageId),
    outcome_generation: Math.max(1, Math.floor(input.outcomeGeneration)),
    completed_at: required(input.completedAt),
  };
  const observation: ConversationCompletionObservation = {
    ...base,
    integrity_sha256: integrity(base),
  };
  const path = completionObservationPath(input.butlerData, jobId);
  if (existsSync(path)) {
    const existing = readConversationCompletionObservation(input.butlerData, jobId);
    if (!existing || canonicalJson(existing) !== canonicalJson(observation)) {
      throw new Error("completion_observation_conflict");
    }
  } else {
    writeJsonAtomic(path, observation);
  }
  const request: SyncRequest = {
    schema_version: "butler.memory-sync-request.v2",
    job_id: jobId,
    scope,
    project_id: observation.project_id,
    conversation_session_id: observation.conversation_session_id,
    conversation_turn_id: observation.conversation_turn_id,
    inbound_message_id: observation.inbound_message_id,
    outbound_message_id: observation.outbound_message_id,
    project: observation.project_id ?? "global",
    topic: null,
    source: "conversation_completion",
    session_id: observation.runtime_session_id,
    timestamp: observation.completed_at,
    trigger: "turn_completed",
  };
  appendToQueue(request, input.butlerData);
  return observation;
}

export function readConversationCompletionObservation(
  butlerData: string,
  jobId: string,
): ConversationCompletionObservation | null {
  try {
    const value = JSON.parse(readFileSync(completionObservationPath(butlerData, jobId), "utf8")) as ConversationCompletionObservation;
    if (value.schema_version !== COMPLETION_OBSERVATION_SCHEMA || value.job_id !== jobId) return null;
    const { integrity_sha256, ...base } = value;
    return integrity(base) === integrity_sha256 ? value : null;
  } catch {
    return null;
  }
}

export function completionJobProcessed(butlerData: string, jobId: string): boolean {
  return existsSync(completionReceiptPath(butlerData, jobId));
}

export function writeCompletionJobReceipt(
  butlerData: string,
  receipt: CompletionJobReceipt,
): void {
  writeJsonAtomic(completionReceiptPath(butlerData, receipt.job_id), receipt);
}

export function completionObservationPath(butlerData: string, jobId: string): string {
  return join(cognitionMemoryRoot(butlerData), "queue", "completion-observations", `${safeId(jobId)}.json`);
}

export function completionReceiptPath(butlerData: string, jobId: string): string {
  return join(cognitionMemoryRoot(butlerData), "queue", "completion-receipts", `${safeId(jobId)}.json`);
}

function completionJobId(turnId: string, generation: number): string {
  return `mcj_${createHash("sha256").update(`${turnId}\0${generation}`).digest("hex").slice(0, 32)}`;
}

function integrity(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function required(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("completion_observation_identity_missing");
  return trimmed;
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 160);
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
