import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { recordOperationalMetric } from "../../../operations/metrics/operational-metrics.ts";
import { cognitionMemoryRoot } from "../paths.ts";
import { resolveCanonicalProjectWorkspace } from "./project-workspace.ts";
import { selectEpisodeRelationshipRows } from "../memory/recall/candidates.ts";
import type { RecallMemoryInput } from "../memory/recall/contracts.ts";
import { readActiveDescriptor, resolveMemoryGeneration, type MemoryGenerationHandle } from "../memory/projection/generation.ts";
import type { MemoryExecutionContext } from "../memory/projection/contracts.ts";
import { assertCanonicalProjectionSourcesCurrent } from "../memory/projection/source.ts";
import { sourceRows } from "../memory/projection/store.ts";
import { createMemoryQualityExclusionReader } from "../feedback/buffer.ts";

const DEFAULT_MAX_BYTES = 20 * 1024;
const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000;
const SEMANTIC_BLOCK = /<!-- butler-semantic:([^:>]+):start -->[\s\S]*?<!-- butler-semantic:\1:end -->\n?/gu;
const STRUCTURED_ENTRY = /<!-- butler-hot-cache-entry:v2\n([\s\S]*?)\n-->/u;

export interface SourceBackedHotCacheEntry {
  entry_id: string;
  episode_id: string;
  window_ref: string;
  node_refs: string[];
  source_revision: string;
  source_time: string;
  valid_until: string | null;
  kind: string;
  summary: string;
  basis: string[];
  salience: "high" | "normal" | "unspecified";
  scope: "project" | "global";
  project_id: string | null;
  session_id: string | null;
  source_kind?: "conversation" | "task_report" | "explicit_record";
  graph_revision: number;
  source_refs: string[];
}

export interface HotCacheWriteReceipt {
  schema_version: "butler.hot-cache-write-receipt.v1";
  source_id: string;
  scope: "project" | "global";
  project_id: string | null;
  path: string;
  replayed: boolean;
  compacted: boolean;
  bytes: number;
  generation_id?: string;
  episode_id?: string;
  source_revision?: string;
  excluded_entry_ids?: string[];
  excluded_entries?: Array<{ entry_id: string; reason: "expired" | "invalidated" | "oversized" | "budget" }>;
  admitted?: boolean;
}

export function semanticHotCachePath(input: {
  butlerData: string;
  scope: "project" | "global";
  projectId?: string | null;
  boundWorkspacePath?: string | null;
  generationRoot?: string;
}): string {
  if (input.generationRoot) return join(input.generationRoot, "hot", "cache.md");
  if (input.scope === "global") return join(cognitionMemoryRoot(input.butlerData), "hot", "cache.md");
  if (!input.projectId?.trim()) throw new Error("hot_cache_project_binding_missing");
  const workspace = resolveCanonicalProjectWorkspace({
    butlerData: input.butlerData,
    projectId: input.projectId,
    boundWorkspacePath: input.boundWorkspacePath,
  });
  return join(workspace, ".butler", "hot-cache.md");
}

export function writeSemanticHotCacheEntry(input: {
  butlerData: string;
  scope: "project" | "global";
  projectId?: string | null;
  boundWorkspacePath?: string | null;
  sessionId: string | null;
  sourceId: string;
  body: string;
  createdAt?: string;
  maxBytes?: number;
  lockStaleAfterMs?: number;
  generationRoot?: string;
  generationId?: string;
  episodeId?: string;
  sourceRevision?: string;
  entry?: SourceBackedHotCacheEntry;
  memoryContext?: MemoryExecutionContext;
  resolvedGeneration?: MemoryGenerationHandle;
  sourceButlerData?: string;
}): HotCacheWriteReceipt {
  const body = input.body.trim();
  if (!body) throw new Error("hot_cache_entry_empty");
  if (body.length > 8_000) throw new Error("hot_cache_entry_too_large");
  if (containsSecret(body)) throw new Error("hot_cache_secret_rejected");
  const path = semanticHotCachePath(input);
  const safeSourceId = safeMarkerId(input.sourceId);
  const marker = `<!-- butler-semantic:${safeSourceId}:start -->`;
  let replayed = false;
  let compacted = false;
  let excludedEntryIds: string[] = [];
  let excludedEntries: HotCacheWriteReceipt["excluded_entries"] = [];
  let admitted = true;
  withHotCacheLock(path, input.lockStaleAfterMs, () => {
    const current = readText(path);
    if (current.includes(marker)) {
      replayed = true;
      if (!input.entry) return;
    }
    const createdAt = input.createdAt ?? new Date().toISOString();
    const block = [
      marker,
      input.entry ? `<!-- butler-hot-cache-entry:v2\n${JSON.stringify(input.entry)}\n-->` : "",
      `## [${createdAt}] ${input.projectId?.trim() || "global"} | ${input.sessionId}`,
      `- source_id: ${input.sourceId}`,
      `- scope: ${input.scope}`,
      input.projectId?.trim() ? `- project_id: ${input.projectId.trim()}` : "",
      "",
      body,
      `<!-- butler-semantic:${safeSourceId}:end -->`,
    ].filter(Boolean).join("\n");
    const appended = replayed ? current : `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${block}\n`;
    let validatorOwner: ReturnType<typeof destinationEntryValidator> | undefined;
    if (input.entry && input.memoryContext && input.resolvedGeneration) {
      validatorOwner = destinationEntryValidator(
        input.memoryContext,
        input.resolvedGeneration,
        input.sourceButlerData ?? input.butlerData,
      );
    }
    let bounded: ReturnType<typeof compactHotCache>;
    try {
      bounded = compactHotCache(appended, input.maxBytes ?? DEFAULT_MAX_BYTES, {
        structured: Boolean(input.entry),
        validator: validatorOwner?.validate,
      });
    } finally {
      validatorOwner?.close();
    }
    compacted = bounded.body !== appended;
    excludedEntries = bounded.excluded;
    excludedEntryIds = bounded.excluded.map((item) => item.entry_id);
    admitted = !input.entry || bounded.admittedEntryIds.includes(input.entry.entry_id);
    if (bounded.audit) preserveLegacyAudit(`${path}.audit.md`, bounded.audit);
    writeAtomicUnlocked(path, bounded.body);
  });
  ensureProjectGitignore(path);
  const bytes = existsSync(path) ? statSync(path).size : 0;
  recordOperationalMetric({
    category: "memory",
    name: "semantic_hot_cache_write",
    status: "ok",
    value: bytes,
    unit: "bytes",
    dimensions: {
      scope: input.scope,
      projectId: input.projectId ?? null,
      replayed,
      compacted,
    },
  }, { butlerData: input.butlerData });
  return {
    schema_version: "butler.hot-cache-write-receipt.v1",
    source_id: input.sourceId,
    scope: input.scope,
    project_id: input.projectId?.trim() || null,
    path,
    replayed,
    compacted,
    bytes,
    ...(input.generationId ? { generation_id: input.generationId } : {}),
    ...(input.episodeId ? { episode_id: input.episodeId } : {}),
    ...(input.sourceRevision ? { source_revision: input.sourceRevision } : {}),
    ...(excludedEntryIds.length ? { excluded_entry_ids: excludedEntryIds } : {}),
    ...(excludedEntries.length ? { excluded_entries: excludedEntries } : {}),
    ...(input.entry ? { admitted } : {}),
  };
}

export function replaceManagedHotCacheSection(input: {
  butlerData: string;
  path: string;
  startMarker: string;
  endMarker: string;
  content: string;
  maxBytes?: number;
  lockStaleAfterMs?: number;
}): void {
  withHotCacheLock(input.path, input.lockStaleAfterMs, () => {
    const current = readText(input.path);
    const start = current.indexOf(input.startMarker);
    const end = current.indexOf(input.endMarker);
    const next = start >= 0 && end >= start
      ? `${current.slice(0, start)}${input.content}${current.slice(end + input.endMarker.length)}`
      : `${input.content}\n${current ? `\n${current.trim()}\n` : ""}`;
    writeAtomicUnlocked(input.path, compactHotCache(next.trimEnd() + "\n", input.maxBytes ?? DEFAULT_MAX_BYTES).body);
  });
  ensureProjectGitignore(input.path);
}

export function restoreHotCacheSnapshot(input: {
  path: string;
  body: string;
  lockStaleAfterMs?: number;
}): void {
  withHotCacheLock(input.path, input.lockStaleAfterMs, () => {
    writeAtomicUnlocked(input.path, input.body);
  });
  ensureProjectGitignore(input.path);
}

export function hotCacheContentHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function withHotCacheLock(path: string, staleAfterMs = DEFAULT_LOCK_STALE_MS, fn: () => void): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  acquireLock(lock, staleAfterMs);
  try {
    fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

function acquireLock(lock: string, staleAfterMs: number): void {
  try {
    writeFileSync(lock, `${process.pid}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return;
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > staleAfterMs) {
        rmSync(lock, { force: true });
        writeFileSync(lock, `${process.pid}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
        return;
      }
    } catch {
      // Another writer may have replaced the lock while it was inspected.
    }
    throw new Error("hot_cache_destination_locked");
  }
}

function compactHotCache(
  body: string,
  maxBytes: number,
  options: { structured?: boolean; validator?: (entry: SourceBackedHotCacheEntry) => boolean } = {},
): {
  body: string;
  audit: string;
  admittedEntryIds: string[];
  excluded: NonNullable<HotCacheWriteReceipt["excluded_entries"]>;
} {
  const now = Date.now();
  const blocks = [...body.matchAll(SEMANTIC_BLOCK)].map((match) => ({
    body: match[0],
    entry: parseStructuredEntry(match[0]),
  }));
  const legacy = body.replace(SEMANTIC_BLOCK, "").trim();
  const excluded: NonNullable<HotCacheWriteReceipt["excluded_entries"]> = [];
  const structured = blocks
    .filter((item): item is { body: string; entry: SourceBackedHotCacheEntry } => Boolean(item.entry))
    .filter((item) => {
      if (item.entry.valid_until && Date.parse(item.entry.valid_until) <= now) {
        excluded.push({ entry_id: item.entry.entry_id, reason: "expired" });
        return false;
      }
      if (options.validator && !options.validator(item.entry)) {
        excluded.push({ entry_id: item.entry.entry_id, reason: "invalidated" });
        return false;
      }
      return true;
    })
    .sort((left, right) => {
      const rank = { high: 0, normal: 1, unspecified: 2 } as const;
      return rank[left.entry.salience] - rank[right.entry.salience] ||
        right.entry.source_time.localeCompare(left.entry.source_time) ||
        Buffer.from(left.entry.entry_id).compare(Buffer.from(right.entry.entry_id));
    });
  const deduped = structured.filter((item, index) =>
    structured.findIndex((candidate) => candidate.entry.entry_id === item.entry.entry_id) === index,
  );
  const admitted: string[] = [];
  for (const item of deduped) {
    const candidate = [...admitted, item.body.trimEnd()];
    const candidateBytes = Buffer.byteLength(serializeBlocks(candidate), "utf8");
    if (Buffer.byteLength(serializeBlocks([item.body.trimEnd()]), "utf8") > maxBytes) {
      excluded.push({ entry_id: item.entry.entry_id, reason: "oversized" });
      continue;
    }
    if (candidateBytes > maxBytes) {
      excluded.push({ entry_id: item.entry.entry_id, reason: "budget" });
      continue;
    }
    admitted.push(item.body.trimEnd());
  }
  const auditParts: string[] = [];
  if (legacy) auditParts.push(legacy);
  const retainedLegacy: string[] = [];
  const legacyBlocks = blocks.filter((item) => !item.entry).map((item) => item.body.trimEnd());
  auditParts.push(...legacyBlocks);
  if (options.structured) {
    return {
      body: serializeBlocks(admitted),
      audit: auditParts.length ? `${auditParts.join("\n\n")}\n` : "",
      admittedEntryIds: deduped.filter((item) => admitted.includes(item.body.trimEnd())).map((item) => item.entry.entry_id),
      excluded,
    };
  }
  let bytes = Buffer.byteLength(serializeBlocks(admitted), "utf8");
  for (const block of legacyBlocks.reverse()) {
    const separator = admitted.length || retainedLegacy.length ? "\n\n" : "";
    const blockBytes = Buffer.byteLength(separator + block + "\n", "utf8");
    if (bytes + blockBytes <= maxBytes) {
      retainedLegacy.unshift(block);
      bytes += blockBytes;
    }
  }
  if (legacy) {
    const separator = admitted.length || retainedLegacy.length ? "\n\n" : "";
    if (bytes + Buffer.byteLength(separator + legacy + "\n", "utf8") <= maxBytes) retainedLegacy.unshift(legacy);
  }
  admitted.push(...retainedLegacy);
  return { body: serializeBlocks(admitted), audit: "", admittedEntryIds: [], excluded };
}

function serializeBlocks(blocks: string[]): string {
  return blocks.length ? `${blocks.join("\n\n")}\n` : "";
}

function preserveLegacyAudit(path: string, body: string): void {
  const current = readText(path);
  if (current.includes(body.trim())) return;
  writeAtomicUnlocked(path, `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${body}`);
}

function parseStructuredEntry(block: string): SourceBackedHotCacheEntry | null {
  const raw = block.match(STRUCTURED_ENTRY)?.[1];
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as SourceBackedHotCacheEntry;
    return value?.entry_id && value.episode_id && value.source_revision && value.summary ? value : null;
  } catch {
    return null;
  }
}

export function readGenerationHotCache(input: {
  butlerData: string;
  projectId?: string | null;
  includeGlobal?: boolean;
  now?: string;
}): string | null {
  try {
    const descriptor = readActiveDescriptor(input.butlerData);
    const generation = resolveMemoryGeneration({
      butlerData: input.butlerData,
      target: { kind: "active", expected_generation: descriptor.generation_id },
      signal: new AbortController().signal,
    });
    const cache = readText(join(generation.root, "hot", "cache.md"));
    if (!cache) return null;
    const db = new Database(generation.graphPath, { readonly: true });
    try {
      const revision = db.query<{ value: string }, []>("SELECT value FROM memory_state WHERE key='graph_revision'").get()?.value;
      if (revision === undefined) return null;
      const now = Date.parse(input.now ?? new Date().toISOString());
      const qualityExclusions = createMemoryQualityExclusionReader(input.butlerData, {
        db,
        generationId: generation.generationId,
      });
      const entries = [...cache.matchAll(SEMANTIC_BLOCK)]
        .map((match) => parseStructuredEntry(match[0]))
        .filter((entry): entry is SourceBackedHotCacheEntry => Boolean(entry))
        .filter((entry) => {
          if (entry.valid_until && Date.parse(entry.valid_until) <= now) return false;
          if (entry.scope === "project" && entry.project_id !== input.projectId?.trim()) return false;
          if (entry.scope === "global" && input.includeGlobal === false) return false;
          return validateGenerationEntry(input.butlerData, generation, db, entry, new Date(now).toISOString(), qualityExclusions);
        });
      const afterRevision = db.query<{ value: string }, []>("SELECT value FROM memory_state WHERE key='graph_revision'").get()?.value;
      const afterDescriptor = readActiveDescriptor(input.butlerData);
      if (revision !== afterRevision || afterDescriptor.generation_id !== descriptor.generation_id) return null;
      return entries.length ? entries.map((entry) => entry.summary).join("\n\n") : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export type GenerationHotCacheHealth = {
  available: boolean;
  reason: "generation_unavailable" | "cache_unavailable" | null;
  total_entries: number;
  current_entries: number;
  stale_entries: number;
  expired_entries: number;
  evicted_entries: number;
};

export function readGenerationHotCacheHealth(input: {
  butlerData: string;
  now?: string;
  expectedGenerationId?: string;
  expectedGraphRevision?: number;
}): GenerationHotCacheHealth {
  try {
    const descriptor = readActiveDescriptor(input.butlerData);
    if (input.expectedGenerationId !== undefined && descriptor.generation_id !== input.expectedGenerationId)
      return { available: false, reason: "cache_unavailable", total_entries: 0, current_entries: 0, stale_entries: 0, expired_entries: 0, evicted_entries: 0 };
    const generation = resolveMemoryGeneration({ butlerData: input.butlerData,
      target: { kind: "active", expected_generation: descriptor.generation_id }, signal: new AbortController().signal });
    const path = join(generation.root, "hot", "cache.md");
    if (!existsSync(path)) return { available: true, reason: null, total_entries: 0, current_entries: 0, stale_entries: 0, expired_entries: 0, evicted_entries: 0 };
    const entries = [...readText(path).matchAll(SEMANTIC_BLOCK)].map((match) => parseStructuredEntry(match[0])).filter((entry): entry is SourceBackedHotCacheEntry => Boolean(entry));
    const db = new Database(generation.graphPath, { readonly: true });
    try {
      const beforeRevision = db.query<{ value: string }, []>("SELECT value FROM memory_state WHERE key='graph_revision'").get()?.value;
      if (beforeRevision === undefined) return { available: false, reason: "cache_unavailable", total_entries: entries.length, current_entries: 0, stale_entries: entries.length, expired_entries: 0, evicted_entries: 0 };
      if (input.expectedGraphRevision !== undefined && Number(beforeRevision) !== input.expectedGraphRevision)
        return { available: false, reason: "cache_unavailable", total_entries: entries.length, current_entries: 0, stale_entries: entries.length, expired_entries: 0, evicted_entries: 0 };
      const asOf = input.now ?? new Date().toISOString();
      const asOfMs = Date.parse(asOf);
      const qualityExclusions = createMemoryQualityExclusionReader(input.butlerData, { db, generationId: generation.generationId });
      let current = 0; let expired = 0;
      for (const entry of entries) {
        if (entry.valid_until && Date.parse(entry.valid_until) <= asOfMs) expired += 1;
        else if (validateGenerationEntry(input.butlerData, generation, db, entry, asOf, qualityExclusions)) current += 1;
      }
      let evicted = 0;
      for (const row of db.query<{ hot_cache_receipt_json: string }, []>("SELECT hot_cache_receipt_json FROM memory_projection_jobs WHERE hot_cache_receipt_json IS NOT NULL").all()) {
        try {
          const value = JSON.parse(row.hot_cache_receipt_json) as { excluded_entries?: Array<{ reason?: string }>; entries?: Array<{ excluded_entries?: Array<{ reason?: string }> }> };
          const receipts = value.entries ?? [value];
          evicted += receipts.flatMap((receipt) => receipt.excluded_entries ?? []).filter((item) => item.reason === "budget" || item.reason === "oversized").length;
        } catch {}
      }
      const afterRevision = db.query<{ value: string }, []>("SELECT value FROM memory_state WHERE key='graph_revision'").get()?.value;
      if (beforeRevision !== afterRevision || readActiveDescriptor(input.butlerData).generation_id !== descriptor.generation_id)
        return { available: false, reason: "cache_unavailable", total_entries: entries.length, current_entries: 0, stale_entries: entries.length - expired, expired_entries: expired, evicted_entries: evicted };
      return { available: true, reason: null, total_entries: entries.length, current_entries: current,
        stale_entries: Math.max(0, entries.length - current - expired), expired_entries: expired, evicted_entries: evicted };
    } finally { db.close(); }
  } catch {
    return { available: false, reason: "generation_unavailable", total_entries: 0, current_entries: 0, stale_entries: 0, expired_entries: 0, evicted_entries: 0 };
  }
}

function destinationEntryValidator(
  context: MemoryExecutionContext,
  resolved: MemoryGenerationHandle,
  sourceButlerData: string,
): { validate: (entry: SourceBackedHotCacheEntry) => boolean; close: () => void } {
  const destination = resolveMemoryGeneration(context);
  if (destination.generationId !== resolved.generationId || destination.root !== resolved.root || destination.graphPath !== resolved.graphPath) {
    throw new Error("hot_cache_generation_changed");
  }
  const db = new Database(destination.graphPath, { readonly: true });
  const qualityExclusions = createMemoryQualityExclusionReader(sourceButlerData, {
    db,
    generationId: destination.generationId,
  });
  return {
    validate: (entry) => validateGenerationEntry(sourceButlerData, destination, db, entry, new Date().toISOString(), qualityExclusions),
    close: () => db.close(),
  };
}

/** Read-only candidate evidence used by rebuild readiness; it shares the serving cache validator. */
export function readGenerationHotCacheCandidateEvidence(input: {
  generation: MemoryGenerationHandle;
  sourceButlerData: string;
  now: string;
}): Array<{
  entry_id: string;
  source_revision: string;
  source_refs: string[];
  current: boolean;
  expired: boolean;
}> {
  const path = join(input.generation.root, "hot", "cache.md");
  if (!existsSync(path)) return [];
  const entries = [...readText(path).matchAll(SEMANTIC_BLOCK)]
    .map((match) => parseStructuredEntry(match[0]))
    .filter((entry): entry is SourceBackedHotCacheEntry => Boolean(entry));
  const db = new Database(input.generation.graphPath, { readonly: true });
  try {
    const qualityExclusions = createMemoryQualityExclusionReader(input.sourceButlerData, {
      db,
      generationId: input.generation.generationId,
    });
    const asOfMs = Date.parse(input.now);
    return entries.map((entry) => {
      const expired = Boolean(entry.valid_until && Date.parse(entry.valid_until) <= asOfMs);
      return {
        entry_id: entry.entry_id,
        source_revision: entry.source_revision,
        source_refs: [...entry.source_refs],
        expired,
        current: !expired && validateGenerationEntry(
          input.sourceButlerData, input.generation, db, entry, input.now, qualityExclusions,
        ),
      };
    });
  } finally { db.close(); }
}

function validateGenerationEntry(
  butlerData: string,
  generation: MemoryGenerationHandle,
  db: Database,
  entry: SourceBackedHotCacheEntry,
  asOf: string,
  qualityExclusions: (sources: ReturnType<typeof sourceRows>) => Set<string>,
): boolean {
  const graphRevision = Number(db.query<{ value: string }, []>("SELECT value FROM memory_state WHERE key='graph_revision'").get()?.value ?? -1);
  if (!Number.isSafeInteger(entry.graph_revision) || entry.graph_revision < 0 || entry.graph_revision > graphRevision || entry.source_refs.length === 0) return false;
  const chunk = db.query<{ current_revision: string; project_id: string | null; conversation_session_id: string | null; status: string }, [string]>(
    "SELECT current_revision,project_id,conversation_session_id,status FROM memory_chunks WHERE memory_chunk_id=?",
  ).get(entry.episode_id);
  if (!chunk || chunk.current_revision !== entry.source_revision || chunk.status !== "active" || chunk.project_id !== entry.project_id || chunk.conversation_session_id !== entry.session_id) return false;
  const rows = sourceRows(db, entry.source_refs);
  const excluded = qualityExclusions(rows);
  if (entry.source_refs.some((sourceId) => excluded.has(sourceId))) return false;
  if (rows.length !== new Set(entry.source_refs).size || rows.some((row) =>
    row.episode_id !== entry.episode_id || row.revision !== entry.source_revision ||
    row.conversation_session_id !== entry.session_id || row.source_kind !== (entry.source_kind ?? "conversation") ||
    !(row.source_kind === "conversation"
      ? ["user_input", "assistant_public"].includes(row.origin_kind)
      : row.source_kind === "task_report"
        ? row.role === "task" && row.basis === "reviewed_task"
        : row.role === "explicit" && row.basis === "user_statement"))) return false;
  try { assertCanonicalProjectionSourcesCurrent(butlerData, db, rows); }
  catch { return false; }
  const recallInput = cacheRecallInput(butlerData, generation, entry, asOf);
  const relationships = selectEpisodeRelationshipRows(db, recallInput, entry.episode_id)
    .filter((row) => entry.node_refs.includes(row.candidate_node_id) && entry.source_refs.includes(row.candidate_source_id));
  const relationshipSources = sourceRows(db, [...new Set(relationships.map((row) => row.evidence_source_id))]);
  try { assertCanonicalProjectionSourcesCurrent(butlerData, db, relationshipSources); }
  catch { return false; }
  return !relationships.some((row) => row.relation === "supersedes" && row.target_node_id === row.candidate_node_id);
}

function cacheRecallInput(
  butlerData: string,
  generation: MemoryGenerationHandle,
  entry: SourceBackedHotCacheEntry,
  asOf: string,
): RecallMemoryInput {
  return {
    context: { butlerData, target: { kind: "active", expected_generation: generation.generationId }, signal: new AbortController().signal },
    cue: "", includeVector: false, includeInternal: false, limit: 1,
    scope: entry.scope === "project" ? "current_project" : "all_user_sessions",
    projectFilter: entry.scope === "project" ? "selected" : "unassigned",
    projectIds: entry.project_id ? [entry.project_id] : [], sessionIds: [], asOf,
    runtime: {
      sessionId: entry.session_id ?? "", turnId: "hot-cache", currentUserMessage: "",
      nativeOperationId: "hot-cache", projectId: entry.project_id,
    },
  };
}

function writeAtomicUnlocked(path: string, body: string): void {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, body, { encoding: "utf8", mode: 0o600, flush: true });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function ensureProjectGitignore(path: string): void {
  if (basename(dirname(path)) !== ".butler") return;
  const gitignore = join(dirname(path), ".gitignore");
  if (!existsSync(gitignore)) writeFileSync(gitignore, "*\n", { encoding: "utf8", mode: 0o600 });
}

function containsSecret(value: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value) ||
    /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b/u.test(value) ||
    /\bAKIA[0-9A-Z]{16}\b/u.test(value) ||
    /\b(?:password|passwd|token|api[_ -]?key)\s*[:=]\s*[^\s]{8,}/iu.test(value);
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function safeMarkerId(value: string): string {
  const compact = value.trim().replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 120);
  return compact || createHash("sha256").update(value).digest("hex").slice(0, 32);
}
