import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { Database } from "bun:sqlite";
import type { ProjectionSourceRow } from "../memory/projection/store.ts";
import { cognitionFeedbackRoot } from "../paths.ts";

export const FEEDBACK_BUFFER_SCHEMA = "butler.cognition.feedback-buffer.v1";

export type FeedbackStatus = "active" | "applied" | "discarded" | "superseded" | "needs_clarification";
export type FeedbackPriority = "critical" | "high" | "normal" | "low";
export type FeedbackPrivacyClass = "public" | "private" | "sensitive" | "secret";

export type FeedbackEntry = {
  feedback_id: string;
  status: FeedbackStatus;
  created_at: string;
  updated_at: string;
  priority: FeedbackPriority;
  scope: string;
  category: string;
  target_ref: string;
  promotion_target: string;
  review_after: string;
  expires_at: string | null;
  supersedes: string[];
  conflicts_with: string[];
  privacy_class: FeedbackPrivacyClass;
  text: string;
  extra_fields?: Record<string, string>;
};

export type AddFeedbackEntryInput = {
  text: string;
  targetRef: string;
  category?: string;
  scope?: string;
  promotionTarget?: string;
  priority?: FeedbackPriority;
  privacyClass?: FeedbackPrivacyClass;
  now?: Date;
  sourceBinding?: {
    conversation_session_id: string;
    conversation_message_id: string;
    operation_id: string;
  };
};

export type FeedbackResolveStatus = Extract<FeedbackStatus, "applied" | "discarded" | "superseded" | "needs_clarification">;

export type FeedbackQualityOperation = {
  schema: "butler.memory-source-quality-operation.v1";
  feedback_id: string;
  operation_id: string;
  intent: "exclude";
  actor: "operator";
  source_ref: string;
  source_revision: string;
  source_hash: string;
  generation_id: string;
  episode_id: string;
  target_revision: string;
  feedback_owner_revision: string;
  scope: string;
  status: "pending" | "applied" | "stale";
  created_at: string;
};

export function feedbackOwnerRevision(entry: FeedbackEntry): string {
  return createHash("sha256").update(JSON.stringify({
    feedback_id: entry.feedback_id,
    created_at: entry.created_at,
    scope: entry.scope,
    category: entry.category,
    target_ref: entry.target_ref,
    text: entry.text,
  })).digest("hex");
}

const VALID_STATUSES = new Set<FeedbackStatus>([
  "active",
  "applied",
  "discarded",
  "superseded",
  "needs_clarification",
]);

const VALID_PRIORITIES = new Set<FeedbackPriority>(["critical", "high", "normal", "low"]);
const VALID_PRIVACY = new Set<FeedbackPrivacyClass>(["public", "private", "sensitive", "secret"]);

function iso(date: Date = new Date()): string {
  return date.toISOString();
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function feedbackBufferPath(butlerData: string): string {
  return join(cognitionFeedbackRoot(butlerData), "feedback.md");
}

function feedbackQualityPath(butlerData: string): string {
  return join(cognitionFeedbackRoot(butlerData), "quality-operations.jsonl");
}

export function listFeedbackQualityOperations(butlerData: string): FeedbackQualityOperation[] {
  const raw = existsSync(feedbackQualityPath(butlerData))
    ? readFileSync(feedbackQualityPath(butlerData), "utf8").trim()
    : "";
  if (!raw) return [];
  return raw.split("\n").flatMap((line) => {
    try {
      const value = JSON.parse(line) as FeedbackQualityOperation;
      return value.schema === "butler.memory-source-quality-operation.v1" ? [value] : [];
    } catch { return []; }
  });
}

export function recordFeedbackQualityExclusion(
  butlerData: string,
  input: Omit<FeedbackQualityOperation, "schema" | "status" | "created_at">,
): FeedbackQualityOperation & { replayed: boolean } {
  const operations = listFeedbackQualityOperations(butlerData);
  const prior = operations.find((item) => item.operation_id === input.operation_id);
  if (prior) {
    if (prior.feedback_id !== input.feedback_id || prior.intent !== input.intent ||
      prior.actor !== input.actor || prior.source_ref !== input.source_ref ||
      prior.source_revision !== input.source_revision || prior.source_hash !== input.source_hash ||
      prior.generation_id !== input.generation_id || prior.episode_id !== input.episode_id ||
      prior.target_revision !== input.target_revision ||
      prior.feedback_owner_revision !== input.feedback_owner_revision ||
      prior.scope !== input.scope)
      throw new Error("memory_quality_operation_conflict");
    return { ...prior, replayed: true };
  }
  const operation: FeedbackQualityOperation = {
    schema: "butler.memory-source-quality-operation.v1",
    ...input,
    status: "pending",
    created_at: iso(),
  };
  ensureDir(cognitionFeedbackRoot(butlerData));
  const path = feedbackQualityPath(butlerData);
  writeFileSync(path, `${operations.map((item) => JSON.stringify(item)).concat(JSON.stringify(operation)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  return { ...operation, replayed: false };
}

type QualityReceipt = {
  status: "applied";
  source_ref: string;
  source_hash: string;
  episode_id: string;
  revision: string;
  feedback_owner_revision: string;
};

function readQualityReceipt(db: Database, operationId: string): QualityReceipt | null {
  const raw = db.query<{ value: string }, [string]>(
    "SELECT value FROM memory_state WHERE key=?",
  ).get(`quality_operation:${operationId}`)?.value;
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as QualityReceipt;
    return value.status === "applied" ? value : null;
  } catch {
    return null;
  }
}

function receiptMatches(operation: FeedbackQualityOperation, receipt: QualityReceipt | null): boolean {
  return Boolean(receipt && receipt.source_ref === operation.source_ref &&
    receipt.source_hash === operation.source_hash &&
    receipt.episode_id === operation.episode_id &&
    receipt.revision === operation.target_revision &&
    receipt.feedback_owner_revision === operation.feedback_owner_revision);
}

export function excludedMemorySourceIds(
  butlerData: string,
  input: {
    db: Database;
    generationId: string;
    sources: ProjectionSourceRow[];
  },
): Set<string> {
  return createMemoryQualityExclusionReader(butlerData, {
    db: input.db,
    generationId: input.generationId,
  })(input.sources);
}

export function createMemoryQualityExclusionReader(
  butlerData: string,
  input: { db: Database; generationId: string },
): (sources: ProjectionSourceRow[]) => Set<string> {
  const operations = listFeedbackQualityOperations(butlerData);
  const owners = new Map(listFeedbackEntries(butlerData).map((entry) => [entry.feedback_id, entry]));
  return (sourceRows: ProjectionSourceRow[]) => {
    const sources = new Map(sourceRows.map((source) => [source.source_id, source]));
    const excluded = new Set<string>();
    for (const operation of operations) {
      if (operation.intent !== "exclude" || operation.status === "stale") continue;
      const source = sources.get(operation.source_ref);
      if (!source || source.episode_id !== operation.episode_id ||
        source.revision !== operation.target_revision ||
        source.revision !== operation.source_revision ||
        source.content_hash !== operation.source_hash) continue;
      const receipt = readQualityReceipt(input.db, operation.operation_id);
      if (receiptMatches(operation, receipt)) {
        excluded.add(operation.source_ref);
        continue;
      }
      if (operation.status === "applied") {
        excluded.add(operation.source_ref);
        continue;
      }
      const owner = owners.get(operation.feedback_id);
      if (operation.status === "pending" && owner &&
        feedbackOwnerRevision(owner) === operation.feedback_owner_revision) {
        excluded.add(operation.source_ref);
      }
    }
    return excluded;
  };
}

export async function applyFeedbackQualityOperation(
  butlerData: string,
  input: { feedbackId: string; operationId: string; sourceRevision: string; signal?: AbortSignal },
): Promise<FeedbackQualityOperation> {
  const operations = listFeedbackQualityOperations(butlerData);
  const operation = operations.find((item) => item.operation_id === input.operationId);
  if (!operation || operation.feedback_id !== input.feedbackId || operation.source_revision !== input.sourceRevision)
    throw new Error("memory_quality_operation_changed");
  if (operation.status === "applied") return operation;
  const { readActiveDescriptor, resolveMemoryGeneration } = await import("../memory/projection/generation.ts");
  const { resolveMemorySource, withMemoryWriteGateAsync } = await import("../memory/projection/ingestion.ts");
  const { openProjectionDb } = await import("../memory/projection/store.ts");
  try {
    const descriptor = readActiveDescriptor(butlerData);
    const context = {
      butlerData,
      target: { kind: "active" as const, expected_generation: descriptor.generation_id },
      signal: input.signal ?? new AbortController().signal,
    };
    const db = openProjectionDb(resolveMemoryGeneration(context).graphPath);
    try {
      await withMemoryWriteGateAsync(context, () => db.transaction(() => {
        const current = listFeedbackQualityOperations(butlerData).find(
          (item) => item.operation_id === input.operationId,
        );
        if (!current || current.feedback_id !== input.feedbackId ||
          current.source_revision !== input.sourceRevision) {
          throw new Error("memory_quality_operation_changed");
        }
        const existingReceipt = readQualityReceipt(db, current.operation_id);
        if (receiptMatches(current, existingReceipt)) return;
        const active = readActiveDescriptor(butlerData);
        if (active.generation_id !== descriptor.generation_id)
          throw new Error("memory_generation_changed");
        const owner = readFeedbackEntry(butlerData, current.feedback_id);
        const source = resolveMemorySource({ context, sourceRef: current.source_ref });
        if (!owner || feedbackOwnerRevision(owner) !== current.feedback_owner_revision ||
          source.source_hash !== current.source_hash) {
          throw new Error("memory_quality_target_changed");
        }
        const target = db.query<{
          episode_id: string;
          revision: string;
          content_hash: string;
        }, [string]>(
          "SELECT episode_id,revision,content_hash FROM memory_chunk_sources WHERE source_id=?",
        ).get(current.source_ref);
        if (!target || target.episode_id !== current.episode_id ||
          target.revision !== current.target_revision ||
          target.content_hash !== current.source_hash) {
          throw new Error("memory_quality_target_changed");
        }
        db.query("INSERT OR REPLACE INTO memory_state(key,value) VALUES(?,?)").run(
          `quality_operation:${current.operation_id}`,
          JSON.stringify({
            status: "applied",
            source_ref: current.source_ref,
            source_hash: current.source_hash,
            episode_id: current.episode_id,
            revision: current.target_revision,
            feedback_owner_revision: current.feedback_owner_revision,
          }),
        );
      })());
    } finally {
      db.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "memory_generation_changed") throw error;
    if (!["memory_quality_target_changed", "memory_quality_operation_changed",
      "memory_source_changed", "memory_source_not_found"].includes(message)) {
      throw error;
    }
    const latest = listFeedbackQualityOperations(butlerData);
    const index = latest.findIndex((item) => item.operation_id === input.operationId);
    if (index < 0) throw error;
    const updated = { ...latest[index]!, status: "stale" as const };
    latest[index] = updated;
    writeFileSync(feedbackQualityPath(butlerData), `${latest.map((item) => JSON.stringify(item)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
    return updated;
  }
  const latest = listFeedbackQualityOperations(butlerData);
  const index = latest.findIndex((item) => item.operation_id === input.operationId);
  if (index < 0) throw new Error("memory_quality_operation_changed");
  const updated = { ...latest[index]!, status: "applied" as const };
  latest[index] = updated;
  writeFileSync(feedbackQualityPath(butlerData), `${latest.map((item) => JSON.stringify(item)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  return updated;
}

function parseList(value: string | undefined): string[] {
  if (!value || value === "[]") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
}

function parseNullable(value: string | undefined): string | null {
  if (!value || value === "null") return null;
  return value;
}

function formatList(values: string[]): string {
  return JSON.stringify(values);
}

function formatNullable(value: string | null): string {
  return value ?? "null";
}

function normalizedStatus(value: string | undefined): FeedbackStatus {
  return VALID_STATUSES.has(value as FeedbackStatus) ? value as FeedbackStatus : "needs_clarification";
}

function normalizedPriority(value: string | undefined): FeedbackPriority {
  return VALID_PRIORITIES.has(value as FeedbackPriority) ? value as FeedbackPriority : "high";
}

function normalizedPrivacy(value: string | undefined): FeedbackPrivacyClass {
  return VALID_PRIVACY.has(value as FeedbackPrivacyClass) ? value as FeedbackPrivacyClass : "private";
}

function entryHeading(entry: FeedbackEntry): string {
  return `## ${entry.feedback_id} ${entry.status}`;
}

export function formatFeedbackEntry(entry: FeedbackEntry): string {
  const standardKeys = new Set([
    "created_at",
    "updated_at",
    "priority",
    "scope",
    "category",
    "target_ref",
    "promotion_target",
    "review_after",
    "expires_at",
    "supersedes",
    "conflicts_with",
    "privacy_class",
  ]);
  const extra = Object.entries(entry.extra_fields ?? {})
    .filter(([key]) => !standardKeys.has(key))
    .map(([key, value]) => `- ${key}: ${value}`);
  return [
    entryHeading(entry),
    "",
    `- created_at: ${entry.created_at}`,
    `- updated_at: ${entry.updated_at}`,
    `- priority: ${entry.priority}`,
    `- scope: ${entry.scope}`,
    `- category: ${entry.category}`,
    `- target_ref: ${entry.target_ref}`,
    `- promotion_target: ${entry.promotion_target}`,
    `- review_after: ${entry.review_after}`,
    `- expires_at: ${formatNullable(entry.expires_at)}`,
    `- supersedes: ${formatList(entry.supersedes)}`,
    `- conflicts_with: ${formatList(entry.conflicts_with)}`,
    `- privacy_class: ${entry.privacy_class}`,
    ...extra,
    "",
    entry.text.trim(),
    "",
  ].join("\n");
}

export function listFeedbackEntries(butlerData: string): FeedbackEntry[] {
  const path = feedbackBufferPath(butlerData);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const blocks = text.split(/^## /mu).filter((block) => block.trim());
  return blocks.map((block) => {
    const lines = block.split(/\r?\n/u);
    const [heading = ""] = lines;
    const [feedbackIdRaw, statusRaw] = heading.trim().split(/\s+/u);
    const feedbackId = feedbackIdRaw?.startsWith("fb_") ? feedbackIdRaw : `fb_${randomUUID()}`;
    const fields = new Map<string, string>();
    const body: string[] = [];
    let inBody = false;
    for (const line of lines.slice(1)) {
      const match = /^- ([a-z_]+):\s*(.*)$/u.exec(line);
      if (!inBody && match) {
        fields.set(match[1], match[2]);
        continue;
      }
      if (line.trim() || inBody) {
        inBody = true;
        body.push(line);
      }
    }
    const extraFields: Record<string, string> = {};
    for (const [key, value] of fields.entries()) extraFields[key] = value;
    return {
      feedback_id: feedbackId,
      status: normalizedStatus(statusRaw),
      created_at: fields.get("created_at") ?? iso(),
      updated_at: fields.get("updated_at") ?? fields.get("created_at") ?? iso(),
      priority: normalizedPriority(fields.get("priority")),
      scope: fields.get("scope") ?? "global",
      category: fields.get("category") ?? "unrouted",
      target_ref: fields.get("target_ref") ?? "unknown",
      promotion_target: fields.get("promotion_target") ?? "discard",
      review_after: fields.get("review_after") ?? fields.get("created_at") ?? iso(),
      expires_at: parseNullable(fields.get("expires_at")),
      supersedes: parseList(fields.get("supersedes")),
      conflicts_with: parseList(fields.get("conflicts_with")),
      privacy_class: normalizedPrivacy(fields.get("privacy_class")),
      text: body.join("\n").trim(),
      extra_fields: extraFields,
    };
  });
}

export function writeFeedbackEntries(butlerData: string, entries: FeedbackEntry[]): void {
  const path = feedbackBufferPath(butlerData);
  ensureDir(join(path, ".."));
  const body = entries.map(formatFeedbackEntry).join("\n").trim();
  writeFileSync(path, body ? `${body}\n` : "", "utf8");
}

export function addFeedbackEntry(
  butlerData: string,
  input: AddFeedbackEntryInput,
): FeedbackEntry {
  const now = iso(input.now);
  const entry: FeedbackEntry = {
    feedback_id: `fb_${randomUUID()}`,
    status: "active",
    created_at: now,
    updated_at: now,
    priority: input.priority ?? "high",
    scope: input.scope ?? "global",
    category: input.category ?? "unrouted",
    target_ref: input.targetRef,
    promotion_target: input.promotionTarget ?? "discard",
    review_after: now,
    expires_at: null,
    supersedes: [],
    conflicts_with: [],
    privacy_class: input.privacyClass ?? "private",
    text: input.text,
    ...(input.sourceBinding
      ? {
        extra_fields: {
          source_conversation_session_id:
            input.sourceBinding.conversation_session_id,
          source_conversation_message_id:
            input.sourceBinding.conversation_message_id,
          source_operation_id: input.sourceBinding.operation_id,
        },
      }
      : {}),
  };
  writeFeedbackEntries(butlerData, [...listFeedbackEntries(butlerData), entry]);
  return entry;
}

export function readFeedbackEntry(butlerData: string, feedbackId: string): FeedbackEntry | null {
  return listFeedbackEntries(butlerData).find((entry) => entry.feedback_id === feedbackId) ?? null;
}

export function resolveFeedbackEntry(
  butlerData: string,
  feedbackId: string,
  status: FeedbackResolveStatus,
  now: Date = new Date(),
): FeedbackEntry {
  const entries = listFeedbackEntries(butlerData);
  const index = entries.findIndex((entry) => entry.feedback_id === feedbackId);
  if (index === -1) throw new Error(`feedback entry not found: ${feedbackId}`);
  const updated: FeedbackEntry = {
    ...entries[index]!,
    status,
    updated_at: iso(now),
  };
  entries[index] = updated;
  writeFeedbackEntries(butlerData, entries);
  return updated;
}

export function clearResolvedFeedbackEntries(butlerData: string): { removed: number; remaining: number } {
  const entries = listFeedbackEntries(butlerData);
  const remaining = entries.filter((entry) => entry.status === "active" || entry.status === "needs_clarification");
  writeFeedbackEntries(butlerData, remaining);
  return {
    removed: entries.length - remaining.length,
    remaining: remaining.length,
  };
}

export function activeFeedbackEntries(butlerData: string, now: Date = new Date()): FeedbackEntry[] {
  return listFeedbackEntries(butlerData).filter((entry) => {
    if (entry.status !== "active") return false;
    if (!entry.expires_at) return true;
    const expires = new Date(entry.expires_at);
    return Number.isNaN(expires.getTime()) || expires.getTime() > now.getTime();
  });
}

type FeedbackContextInput = {
  butlerData: string;
  sessionId?: string;
  projectId?: string;
  maxEntries?: number;
};

export function renderFeedbackBufferContext(input: FeedbackContextInput): string {
  return renderFeedbackEntries(selectFeedbackContext(input));
}

export function renderScopedFeedbackBufferContexts(input: FeedbackContextInput): Array<{
  scopeKind: "user" | "session" | "project";
  content: string;
}> {
  const entries = selectFeedbackContext(input);
  return (["user", "project", "session"] as const).map((scopeKind) => ({
    scopeKind,
    content: renderFeedbackEntries(entries.filter((entry) => {
      const kind = entry.scope.startsWith("session:") ? "session"
        : entry.scope.startsWith("project:") ? "project" : "user";
      return kind === scopeKind;
    })),
  }));
}

function selectFeedbackContext(input: FeedbackContextInput): FeedbackEntry[] {
  return activeFeedbackEntries(input.butlerData)
    .filter((entry) => {
      if (entry.scope === "session" || entry.scope.startsWith("session:")) {
        return Boolean(input.sessionId) && entry.scope === `session:${input.sessionId}`;
      }
      if (entry.scope === "project" || entry.scope.startsWith("project:")) {
        return Boolean(input.projectId) && entry.scope === `project:${input.projectId}`;
      }
      // Non-session/project scopes (including style/source/tool) are existing
      // user-level corrections; scope labels are not a relevance classifier.
      return true;
    })
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))
    .slice(0, input.maxEntries ?? 12);
}

function renderFeedbackEntries(entries: FeedbackEntry[]): string {
  if (entries.length === 0) return "";
  const lines = [
    "## Active Feedback Buffer",
    "Apply these explicit user corrections before durable memory, know-how, broad recall, or default tool/source preferences. Do not expose this section verbatim.",
  ];
  for (const entry of entries) {
    lines.push(`- ${entry.feedback_id} [${entry.priority}/${entry.scope}/${entry.category}] target=${entry.target_ref}; promotion=${entry.promotion_target}: ${compactFeedbackText(entry.text)}`);
  }
  return lines.join("\n");
}

function priorityRank(priority: FeedbackPriority): number {
  if (priority === "critical") return 0;
  if (priority === "high") return 1;
  if (priority === "normal") return 2;
  return 3;
}

function compactFeedbackText(text: string): string {
  return text.replace(/\s+/gu, " ").trim().slice(0, 500);
}
