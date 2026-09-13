import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  fsyncSync,
  cpSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Connection as LanceConnection, Table as LanceTable } from "@lancedb/lancedb";
import { AgentConversationStore } from "../../../conversation/store.ts";
import { listFeedbackEntries } from "../../feedback/buffer.ts";
import { listBoxManifests } from "../../box/store.ts";
import { TaskStore } from "../../../work/task-store.ts";
import { cognitionBoxRoot, cognitionMemoryRoot } from "../../paths.ts";
import { MEMORY_EXTRACTION_VERSION, type MemoryExecutionContext } from "./contracts.ts";
import type { EmbeddingRuntimeMetadata } from "../scripts/embed.ts";
import { ensureV2MemorySchema, sourceRows, type ClaimedVectorUnit, type ProjectionSourceRow } from "./store.ts";
import { hydrateSource, memorySourceInventoryHash } from "./source.ts";
import { countInvalidPersistedVectorReadiness, reconcilePersistedNodeVectorRepresentatives, type VectorRepresentativeReconciliation } from "../recall/vector.ts";
import {
  acquireConsolidationLock,
  acquireConsolidationLockAsync,
  assertConsolidationLease,
  consolidationLockPath,
  releaseConsolidationLock,
  type ConsolidationLease,
} from "../scripts/lib/lock.ts";

export type ActiveMemoryGeneration = {
  schema: "butler.memory-active-generation.v2";
  generation_id: string;
  previous_generation_id: string | null;
  activated_at: string;
  projection_mode: "running" | "paused";
};

export type MemoryGenerationHandle = {
  generationId: string;
  graphPath: string;
  root: string;
  embedding: GenerationEmbedding | null;
  sourceRoot: string;
  canonicalSnapshotPath: string | null;
};

export type GenerationEmbedding = EmbeddingRuntimeMetadata;

export function activeMemoryDescriptorPath(butlerData: string): string {
  return join(cognitionMemoryRoot(butlerData), "active-generation.json");
}

export function resolveMemoryGeneration(
  context: MemoryExecutionContext,
): MemoryGenerationHandle {
  const generationId =
    context.target.kind === "active"
      ? readActiveDescriptor(context.butlerData).generation_id
      : context.target.generation_id;
  if (
    context.target.kind === "active" &&
    generationId !== context.target.expected_generation
  ) {
    throw new Error("memory_generation_changed");
  }
  const manifestRoot = join(
    cognitionMemoryRoot(context.butlerData),
    "generations",
    safeGenerationId(generationId),
  );
  const manifest = readJson(join(manifestRoot, "manifest.json")) as Record<
    string,
    unknown
  >;
  if (
    manifest.schema !== "butler.memory-generation.v2" ||
    (manifest.format !== "v2" && manifest.format !== "legacy") ||
    manifest.generation_id !== generationId
  ) {
    throw new Error("memory_generation_version_unsupported");
  }
  const embedding = readGenerationEmbedding(manifest.embedding);
  const storedCanonicalSnapshotPath = typeof manifest.canonical_snapshot_path === "string"
    ? join(manifestRoot, manifest.canonical_snapshot_path)
    : null;
  if (context.target.kind === "rebuild" &&
    (manifest.format !== "v2" || manifest.canonical_snapshot_id !== context.target.canonical_snapshot_id || !storedCanonicalSnapshotPath)) {
    throw new Error("memory_snapshot_changed");
  }
  const root = manifest.format === "legacy"
    ? join(cognitionMemoryRoot(context.butlerData), "db")
    : manifestRoot;
  return {
    generationId,
    root,
    graphPath: join(root, "graph.sqlite"),
    embedding,
    sourceRoot: context.target.kind === "rebuild" && storedCanonicalSnapshotPath
      ? dirname(dirname(storedCanonicalSnapshotPath))
      : context.butlerData,
    canonicalSnapshotPath: context.target.kind === "rebuild" ? storedCanonicalSnapshotPath : null,
  };
}

/** Mutation authority for the existing projection owners. Read-only callers only resolve a handle. */
export function assertMemoryGenerationMutationAuthority(
  context: MemoryExecutionContext,
  generation: MemoryGenerationHandle = resolveMemoryGeneration(context),
): void {
  const manifest = readMemoryGenerationManifest(context.butlerData, generation.generationId);
  const descriptor = readActiveDescriptor(context.butlerData);
  if (context.target.kind === "active") {
    if (descriptor.generation_id !== generation.generationId || descriptor.projection_mode !== "running" ||
      manifest.format !== "v2")
      throw new Error("memory_generation_changed");
    return;
  }
  if (descriptor.generation_id === generation.generationId || manifest.format !== "v2" || manifest.state !== "building" ||
    manifest.canonical_snapshot_id !== context.target.canonical_snapshot_id || !manifest.canonical_snapshot_path)
    throw new Error("memory_generation_changed");
}

export function bindObservedGenerationEmbeddingUnderWriteGate(
  context: MemoryExecutionContext,
  observed: EmbeddingRuntimeMetadata,
): GenerationEmbedding {
  const next: GenerationEmbedding = {
    model: observed.model,
    dimension: observed.dimension,
    pooling: observed.pooling,
    normalize: observed.normalize,
    version: observed.version,
    max_tokens: observed.max_tokens,
    transformers_version: observed.transformers_version,
    node_runtime_version: observed.node_runtime_version,
    bun_runtime_version: observed.bun_runtime_version,
    tokenizer_asset_sha256: observed.tokenizer_asset_sha256,
    model_asset_sha256: observed.model_asset_sha256,
  };
  assertGenerationEmbedding(next);
  const generation = resolveMemoryGeneration(context);
  const manifestPath = join(generation.root, "manifest.json");
  const manifest = readJson(manifestPath) as Record<string, unknown>;
  const existing = readGenerationEmbedding(manifest.embedding);
  if (existing && JSON.stringify(existing) !== JSON.stringify(next))
    throw new Error("memory_embedding_version_mismatch");
  if (!existing) writeJsonDurable(manifestPath, { ...manifest, embedding: next });
  return next;
}

function readGenerationEmbedding(value: unknown): GenerationEmbedding | null {
  if (value === null) return null;
  const embedding = value as GenerationEmbedding;
  assertGenerationEmbedding(embedding);
  return embedding;
}

function assertGenerationEmbedding(value: GenerationEmbedding): void {
  if (!value || typeof value.model !== "string" || !value.model.trim() || !Number.isSafeInteger(value.dimension) || value.dimension <= 0 || value.pooling !== "cls" || value.normalize !== true || !validSha(value.version) || !Number.isSafeInteger(value.max_tokens) || value.max_tokens <= 0 ||
    typeof value.transformers_version !== "string" || !value.transformers_version || typeof value.node_runtime_version !== "string" || !value.node_runtime_version ||
    (value.bun_runtime_version !== null && typeof value.bun_runtime_version !== "string") || !validSha(value.tokenizer_asset_sha256) || !validSha(value.model_asset_sha256))
    throw new Error("memory_embedding_metadata_invalid");
}

function validSha(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value); }
function validGitCommit(value: unknown): value is string { return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value); }

export function readActiveDescriptor(
  butlerData: string,
): ActiveMemoryGeneration {
  const value = readJson(
    activeMemoryDescriptorPath(butlerData),
  ) as ActiveMemoryGeneration;
  if (
    value.schema !== "butler.memory-active-generation.v2" ||
    !value.generation_id
  ) {
    throw new Error("memory_generation_unavailable");
  }
  return value;
}

export function initializeEmptyMemoryGeneration(
  butlerData: string,
): ActiveMemoryGeneration {
  const lockPath = consolidationLockPath(butlerData);
  const lease = acquireConsolidationLock(lockPath, {
    purpose: "cutover",
  });
  if (!lease) throw new Error("memory_write_busy");
  let commit = false;
  try {
    const result = initializeEmptyMemoryGenerationLocked(butlerData);
    commit = true;
    return result;
  } finally {
    releaseConsolidationLock(lockPath, lease, commit);
  }
}

export async function initializeEmptyMemoryGenerationAsync(
  butlerData: string,
  options: { signal?: AbortSignal; deadlineAt?: number } = {},
): Promise<ActiveMemoryGeneration> {
  const lockPath = consolidationLockPath(butlerData);
  const lease = await acquireConsolidationLockAsync(lockPath, {
    purpose: "cutover",
    waitClass: "background",
    signal: options.signal,
    deadlineAt: options.deadlineAt,
  });
  if (!lease) throw new Error("memory_write_busy");
  let commit = false;
  try { const result = initializeEmptyMemoryGenerationLocked(butlerData); commit = true; return result; }
  finally { releaseConsolidationLock(lockPath, lease, commit); }
}

function initializeEmptyMemoryGenerationLocked(
  butlerData: string,
): ActiveMemoryGeneration {
  assertTrulyEmpty(butlerData);
  const memoryRoot = cognitionMemoryRoot(butlerData);
  const generationId = randomUUID();
  const root = join(memoryRoot, "generations", generationId);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = new Database(join(root, "graph.sqlite"), { create: true });
  try {
    db.exec("PRAGMA journal_mode=WAL");
    ensureV2MemorySchema(db);
  } finally {
    db.close();
  }
  const now = new Date().toISOString();
  const manifest = {
    schema: "butler.memory-generation.v2",
    generation_id: generationId,
    format: "v2",
    state: "active",
    initialization_origin: "empty",
    schema_version: 3,
    extraction_version: MEMORY_EXTRACTION_VERSION,
    ranking_version: 2,
    embedding: null,
    unicode_version: requiredRuntimeVersion("unicode"),
    icu_version: requiredRuntimeVersion("icu"),
    canonical_snapshot_id: "empty",
    canonical_snapshot_path: null,
    source_inventory_hash: createHash("sha256")
      .update(JSON.stringify(["memory-source-inventory"]))
      .digest("hex"),
    registered_source_count: 0,
    unaccounted_source_count: 0,
    required_acceptance_passed: false,
  };
  writeJsonDurable(join(root, "manifest.json"), manifest);
  const descriptor: ActiveMemoryGeneration = {
    schema: "butler.memory-active-generation.v2",
    generation_id: generationId,
    previous_generation_id: null,
    activated_at: now,
    projection_mode: "running",
  };
  writeJsonDurable(activeMemoryDescriptorPath(butlerData), descriptor);
  return descriptor;
}

export type MemoryGenerationManifest = {
  schema: "butler.memory-generation.v2";
  generation_id: string;
  format: "legacy" | "v2";
  state: "building" | "ready" | "active" | "retired";
  initialization_origin: "legacy" | "empty" | "rebuild";
  schema_version: number | null;
  extraction_version: string | null;
  ranking_version: number | null;
  embedding: GenerationEmbedding | null;
  unicode_version: string | null;
  icu_version: string | null;
  canonical_snapshot_id: string;
  canonical_snapshot_path: string | null;
  canonical_snapshot?: {
    file_sha256: string;
    bytes: number;
    duration_ms: number;
    canonical_revision: number;
    base_snapshot_id: string | null;
    delta_from_snapshot_id: string | null;
  };
  source_inventory_hash: string;
  registered_source_count: number;
  unaccounted_source_count: number;
  required_acceptance_passed: boolean;
  readiness?: MemoryGenerationReadiness;
  acceptance_binding?: {
    qualification_sha256: string;
    qualification_ref: string;
    verification_root_ref: string;
    implementation_commit: string;
    verification_generation_id: string;
    target_generation_id: string;
    target_source_inventory_hash: string;
    target_readiness_sha256: string;
    target_evidence_sha256: string;
  };
};

export type MemoryGenerationReadiness = {
  schema: "butler.memory-generation-readiness.v1";
  inventory_hash: string;
  registered: number;
  unaccounted: number;
  semantic: { complete: number; unsupported: number; pending: number; failed: number };
  vectors: { complete: number; pending: number; failed: number; not_configured: number };
  cache: { complete: number; pending: number; failed: number; not_configured: number };
  evidence_sha256: string;
  ready: boolean;
  sha256: string;
};

export type MemoryRecoveryAcceptance = {
  schema: "butler.memory-recovery-acceptance.v3";
  verification_generation_id: string;
  verification_source_inventory_hash: string;
  implementation_commit: string;
  tool_contract_version: 2;
  extraction_version: "memory-extract-v2" | typeof MEMORY_EXTRACTION_VERSION;
  embedding_version: string;
  cases: Array<{
    id: string; mr_ids: string[]; query_hash: string; source_refs: string[];
    expected_source_refs: string[]; observed_source_refs: string[];
    outcome: "passed" | "failed" | "unavailable";
    path: "public_app_btcc" | "native_tool" | "owner_integration";
    uses_real_extractor: boolean; uses_real_embedding: boolean;
    trace_ref: string; trace_sha256: string;
  }>;
  performance: {
    prepared_graph_p95_ms: number; prepared_hybrid_p95_ms: number;
    graph_samples: number; hybrid_samples: number;
    report_ref: string; report_sha256: string;
  };
};

export type MemoryRecoveryCaseTrace = {
  schema: "butler.memory-recovery-case-trace.v1";
  execution: {
    generation_id: string;
    implementation_commit: string;
    tool_contract_version: 2;
    extraction_version: "memory-extract-v2" | typeof MEMORY_EXTRACTION_VERSION;
    embedding:
      | { status: "executed"; version: string }
      | { status: "not_executed"; reason: "not_required" };
    stage_source_inventory_hash: string;
    source_inventory_ref: string;
    source_inventory_sha256: string;
  };
  query: {
    sha256: string;
    request_id?: string;
    result_refs: Array<{ result_id: string; ref: string; sha256: string }>;
  };
  qualification_source_inventory_hash: string;
  qualification_source_inventory_ref: string;
  qualification_source_inventory_sha256: string;
  source_observations: Array<{
    handle: string;
    identity:
      | { kind: "memory_source"; source_id: string }
      | { kind: "conversation_source"; message_id: string; part_id: string; scalar_pointer: string };
    revision: string;
    source_hash: string;
    observed_at: string;
    currentness: "current" | "historical" | "as_of";
    inventory_hash: string;
    binding_ref: string;
    binding_sha256: string;
  }>;
  completion_ids: string[];
  projection_job_ids: string[];
  native_result_ids: string[];
  owner_result_refs?: Array<{ ref: string; sha256: string }>;
  owner_source_result_refs?: Array<{ result_id: string; ref: string; sha256: string }>;
  owner_route?: "production_transition";
  supporting_execution_refs?: Array<{ ref: string; sha256: string }>;
  extractor_attempt_refs: Array<{ ref: string; sha256: string }>;
  embedding_receipt_refs: Array<{ ref: string; sha256: string }>;
  expected_source_handles: string[];
  expected_source_groups: string[][];
  observed_source_handles: string[];
};

export type MemoryRecoveryPerformanceReport = {
  schema: "butler.memory-recovery-performance.v1";
  execution: {
    generation_id: string;
    implementation_commit: string;
    embedding_version: string;
    qualification_source_inventory_hash: string;
  };
  samples: Array<{
    mode: "graph" | "hybrid";
    query_id: string;
    repetition: number;
    result_id: string;
    result_ref: string;
    result_sha256: string;
    metrics_ref: string;
    metrics_sha256: string;
    query_hash: string;
    status: "ok" | "partial";
    elapsed_ms: number;
    expected_source_groups: string[][];
    observed_source_handles: string[];
    source_binding_refs: Array<{ ref: string; sha256: string }>;
    coverage_ok: boolean;
  }>;
  contention: {
    source_window_ids: string[];
    query_intervals: Array<{ query_id: string; started_at: string; ended_at: string }>;
    queue_work_refs: Array<{
      ref: string;
      sha256: string;
      started_at: string;
      ended_at: string;
      result_id: string;
      source_window_ids: string[];
    }>;
    overlapped: boolean;
  };
};

export type MemoryQueryResultEvidence = {
  schema: "butler.memory-query-result-evidence.v1";
  request_id: string;
  result_id: string;
  generation_id: string;
  query_hash: string;
  status: "ok" | "partial";
  source_handles: string[];
  observations: Array<
    | { kind: "source_ref"; source_ref: string }
    | { kind: "session_message"; message_id: string }
  >;
};

export type MemoryOwnerResultEvidence = {
  schema: "butler.memory-owner-result-evidence.v1";
  result_id: string;
  generation_id: string;
  status: "ok" | "partial";
  source_handles: string[];
  observations: MemoryQueryResultEvidence["observations"];
};

export type MemoryPerformanceMetricsEvidence = {
  schema: "butler.memory-performance-metrics-evidence.v1";
  mode: "graph" | "hybrid";
  query_id: string;
  repetition: number;
  result_id: string;
  query_hash: string;
  status: "ok" | "partial";
  elapsed_ms: number;
};

export type MemoryQueueWorkEvidence = {
  schema: "butler.memory-queue-work-evidence.v1";
  result_id: string;
  source_window_ids: string[];
  started_at: string;
  ended_at: string;
  work_class: "background" | "interactive";
};

export type MemorySourceBindingEvidence = {
  schema: "butler.memory-source-binding-evidence.v1";
  handle: string;
  observation_kind: "source_ref" | "session_message";
  returned_source_ref: string | null;
  returned_message_id: string | null;
  generation_id: string;
  inventory_hash: string;
  revision: string;
  source_hash: string;
  observed_at: string;
  currentness: "current" | "historical" | "as_of";
  returned_in_result_id: string;
  read_result_ref: string;
  read_result_sha256: string;
  source_row?: {
    source_id: string;
    episode_id: string;
    revision: string;
    content_hash: string;
    conversation_session_id: string | null;
    conversation_message_id: string | null;
    part_id: string | null;
    scalar_pointer: string | null;
    byte_start: number;
    byte_end: number;
    observed_at: string;
    conversation_start: string;
    conversation_end: string;
    project_id: string | null;
  };
  chunk?: { current_revision: string; status: string };
  split_ancestry?: Array<{
    source_id: string;
    episode_id: string;
    revision: string;
    content_hash: string;
    conversation_session_id: string | null;
    conversation_message_id: string | null;
    part_id: string | null;
    scalar_pointer: string | null;
    byte_start: number;
    byte_end: number;
    child_source_ids: string[];
  }>;
  canonical?: {
    message_id: string;
    part_id: string;
    scalar_pointer: string;
    scalar_hash: string;
    revision: string;
  };
};

export type MemorySourceReadEvidence = {
  schema: "butler.memory-source-read-evidence.v1";
  result_id: string;
  observation_kind: "source_ref" | "session_message";
  source_ref: string | null;
  message_id: string | null;
  canonical: {
    message_id: string | null;
    part_id: string | null;
    scalar_pointer: string | null;
    text: string;
    bytes: number;
    sha256: string;
    revision: string;
  } | null;
  returned_text: string;
  source_row: NonNullable<MemorySourceBindingEvidence["source_row"]>;
};

export function readMemoryGenerationManifest(
  butlerData: string,
  generationId: string,
): MemoryGenerationManifest {
  const root = join(cognitionMemoryRoot(butlerData), "generations", safeGenerationId(generationId));
  const value = readJson(join(root, "manifest.json")) as MemoryGenerationManifest;
  if (value.schema !== "butler.memory-generation.v2" || value.generation_id !== generationId)
    throw new Error("memory_generation_version_unsupported");
  return value;
}

export function prepareMemoryRebuild(input: {
  butlerData: string;
  sourceInventory: unknown;
  sourceInventoryHash: string;
  expectedCanonicalRevision: number;
  verifySnapshotInventory: (sourceRoot: string) => { sourceInventory: unknown; sourceInventoryHash: string };
}): { generationId: string; canonicalSnapshotId: string; canonicalSnapshotPath: string } {
  ensureLegacyBaselineForRebuild(input);
  const canonical = new AgentConversationStore({ butlerData: input.butlerData });
  canonical.close();
  const generationId = randomUUID();
  const root = join(cognitionMemoryRoot(input.butlerData), "generations", generationId);
  const snapshotRoot = join(root, "source-snapshot");
  const canonicalPath = join(snapshotRoot, "runtime", "conversation-store.sqlite");
  mkdirSync(dirname(canonicalPath), { recursive: true, mode: 0o700 });
  const sourcePath = join(input.butlerData, "runtime", "conversation-store.sqlite");
  const snapshotStartedAt = performance.now();
  const db = new Database(sourcePath, { readonly: true });
  try {
    const escaped = canonicalPath.replaceAll("'", "''");
    db.exec(`VACUUM INTO '${escaped}'`);
  } finally { db.close(); }
  fsyncPath(canonicalPath);
  fsyncDirectory(dirname(canonicalPath));
  const snapshotDurationMs = performance.now() - snapshotStartedAt;
  const snapshotBytes = statSync(canonicalPath).size;
  const snapshotSha = createHash("sha256").update(readFileSync(canonicalPath)).digest("hex");
  for (const relative of ["tasks", "cognition/memory/rules", "cognition/feedback", "butler.config.json"]) {
    const source = join(input.butlerData, relative);
    if (existsSync(source)) cpSync(source, join(snapshotRoot, relative), { recursive: true, errorOnExist: true });
  }
  writeJsonDurable(join(snapshotRoot, "memory-source-inventory.json"), input.sourceInventory);
  const verified = input.verifySnapshotInventory(snapshotRoot);
  if (verified.sourceInventoryHash !== input.sourceInventoryHash ||
    JSON.stringify(verified.sourceInventory) !== JSON.stringify(input.sourceInventory))
    throw new Error("memory_snapshot_changed");
  const canonicalSnapshotId = createHash("sha256").update(JSON.stringify([
    "canonical-snapshot-v1", generationId, input.sourceInventoryHash,
  ])).digest("hex");
  const graph = new Database(join(root, "graph.sqlite"), { create: true });
  try { graph.exec("PRAGMA journal_mode=WAL"); ensureV2MemorySchema(graph); } finally { graph.close(); }
  const manifest: MemoryGenerationManifest = {
    schema: "butler.memory-generation.v2", generation_id: generationId, format: "v2",
    state: "building", initialization_origin: "rebuild", schema_version: 3,
    extraction_version: MEMORY_EXTRACTION_VERSION, ranking_version: 2, embedding: null,
    unicode_version: requiredRuntimeVersion("unicode"), icu_version: requiredRuntimeVersion("icu"),
    canonical_snapshot_id: canonicalSnapshotId,
    canonical_snapshot_path: "source-snapshot/runtime/conversation-store.sqlite",
    canonical_snapshot: {
      file_sha256: snapshotSha,
      bytes: snapshotBytes,
      duration_ms: snapshotDurationMs,
      canonical_revision: input.expectedCanonicalRevision,
      base_snapshot_id: null,
      delta_from_snapshot_id: null,
    },
    source_inventory_hash: input.sourceInventoryHash,
    registered_source_count: 0, unaccounted_source_count: sourceInventoryCount(input.sourceInventory),
    required_acceptance_passed: false,
  };
  const lockPath = consolidationLockPath(input.butlerData);
  const lease = acquireConsolidationLock(lockPath, { purpose: "rebuild_prepare" });
  if (!lease) throw new Error("memory_write_busy");
  let committed = false;
  try {
    const current = new AgentConversationStore({ butlerData: input.butlerData });
    try {
      if (current.readPublicSourceRevision() !== input.expectedCanonicalRevision)
        throw new Error("memory_source_changed");
    } finally { current.close(); }
    writeJsonDurable(join(root, "manifest.json"), manifest);
    committed = true;
  } finally { releaseConsolidationLock(lockPath, lease, committed); }
  return { generationId, canonicalSnapshotId, canonicalSnapshotPath: canonicalPath };
}

function ensureLegacyBaselineForRebuild(input: {
  butlerData: string; sourceInventory: unknown; sourceInventoryHash: string;
  expectedCanonicalRevision: number;
}): void {
  if (existsSync(activeMemoryDescriptorPath(input.butlerData))) {
    readActiveDescriptor(input.butlerData);
    return;
  }
  const generationId = randomUUID();
  const generationRoot = join(cognitionMemoryRoot(input.butlerData), "generations", generationId);
  const count = sourceInventoryCount(input.sourceInventory);
  const manifest: MemoryGenerationManifest = {
    schema: "butler.memory-generation.v2", generation_id: generationId, format: "legacy",
    state: "active", initialization_origin: "legacy", schema_version: null,
    extraction_version: null, ranking_version: null, embedding: null,
    unicode_version: null, icu_version: null,
    canonical_snapshot_id: createHash("sha256").update(JSON.stringify([
      "legacy-baseline", generationId, input.sourceInventoryHash,
    ])).digest("hex"),
    canonical_snapshot_path: null, source_inventory_hash: input.sourceInventoryHash,
    registered_source_count: 0, unaccounted_source_count: count,
    required_acceptance_passed: false,
  };
  mkdirSync(generationRoot, { recursive: true, mode: 0o700 });
  writeJsonDurable(join(generationRoot, "manifest.json"), manifest);
  const lockPath = consolidationLockPath(input.butlerData);
  const lease = acquireConsolidationLock(lockPath, { purpose: "cutover" });
  if (!lease) throw new Error("memory_write_busy");
  let committed = false;
  try {
    if (existsSync(activeMemoryDescriptorPath(input.butlerData))) {
      readActiveDescriptor(input.butlerData);
      committed = true;
      return;
    }
    const canonical = new AgentConversationStore({ butlerData: input.butlerData });
    try {
      if (canonical.readPublicSourceRevision() !== input.expectedCanonicalRevision)
        throw new Error("memory_source_changed");
    } finally { canonical.close(); }
    writeJsonDurable(activeMemoryDescriptorPath(input.butlerData), {
      schema: "butler.memory-active-generation.v2", generation_id: generationId,
      previous_generation_id: null, activated_at: new Date().toISOString(), projection_mode: "paused",
    } satisfies ActiveMemoryGeneration);
    committed = true;
  } finally { releaseConsolidationLock(lockPath, lease, committed); }
}

function sourceInventoryCount(value: unknown): number {
  const inventory = value as { entries?: Array<{ sourceUnitCount?: number }>; typed?: Array<{ source_ids?: string[] }> };
  return (inventory.entries ?? []).reduce((sum, entry) => sum + Number(entry.sourceUnitCount ?? 0), 0) +
    (inventory.typed ?? []).reduce((sum, entry) => sum + (entry.source_ids?.length ?? 0), 0);
}

export function refreshMemoryRebuildSnapshot(input: {
  butlerData: string; generationId: string; expectedSnapshotId: string;
  sourceInventory: unknown; sourceInventoryHash: string; expectedCanonicalRevision: number;
  verifySnapshotInventory: (sourceRoot: string) => { sourceInventory: unknown; sourceInventoryHash: string };
}): { canonicalSnapshotId: string; canonicalSnapshotPath: string } {
  const current = readMemoryGenerationManifest(input.butlerData, input.generationId);
  const serving = readActiveDescriptor(input.butlerData);
  if (current.canonical_snapshot_id !== input.expectedSnapshotId || current.state !== "building" ||
    serving.generation_id === input.generationId)
    throw new Error("memory_snapshot_changed");
  const root = join(cognitionMemoryRoot(input.butlerData), "generations", input.generationId);
  const snapshotName = `source-snapshot-${input.sourceInventoryHash.slice(0, 16)}`;
  const snapshotRoot = join(root, snapshotName);
  const canonicalPath = join(snapshotRoot, "runtime", "conversation-store.sqlite");
  const snapshotStartedAt = performance.now();
  if (!existsSync(canonicalPath)) {
    mkdirSync(dirname(canonicalPath), { recursive: true, mode: 0o700 });
    const db = new Database(join(input.butlerData, "runtime", "conversation-store.sqlite"), { readonly: true });
    try { db.exec(`VACUUM INTO '${canonicalPath.replaceAll("'", "''")}'`); } finally { db.close(); }
    fsyncPath(canonicalPath);
    fsyncDirectory(dirname(canonicalPath));
    for (const relative of ["tasks", "cognition/memory/rules", "cognition/feedback", "butler.config.json"]) {
      const source = join(input.butlerData, relative);
      if (existsSync(source)) cpSync(source, join(snapshotRoot, relative), { recursive: true, errorOnExist: true });
    }
    writeJsonDurable(join(snapshotRoot, "memory-source-inventory.json"), input.sourceInventory);
  }
  const verified = input.verifySnapshotInventory(snapshotRoot);
  if (verified.sourceInventoryHash !== input.sourceInventoryHash ||
    JSON.stringify(verified.sourceInventory) !== JSON.stringify(input.sourceInventory))
    throw new Error("memory_snapshot_changed");
  const snapshotId = createHash("sha256").update(JSON.stringify([
    "canonical-snapshot-v1", input.generationId, input.sourceInventoryHash,
  ])).digest("hex");
  const snapshotDurationMs = performance.now() - snapshotStartedAt;
  const snapshotBytes = statSync(canonicalPath).size;
  const snapshotSha = createHash("sha256").update(readFileSync(canonicalPath)).digest("hex");
  const lockPath = consolidationLockPath(input.butlerData);
  const lease = acquireConsolidationLock(lockPath, { purpose: "rebuild_snapshot" });
  if (!lease) throw new Error("memory_write_busy");
  let committed = false;
  try {
    const canonical = new AgentConversationStore({ butlerData: input.butlerData });
    try {
      if (canonical.readPublicSourceRevision() !== input.expectedCanonicalRevision)
        throw new Error("memory_source_changed");
    } finally { canonical.close(); }
    const latest = readMemoryGenerationManifest(input.butlerData, input.generationId);
    const latestServing = readActiveDescriptor(input.butlerData);
    if (latest.canonical_snapshot_id !== input.expectedSnapshotId || latest.state !== "building" ||
      latestServing.generation_id === input.generationId) throw new Error("memory_snapshot_changed");
    writeJsonDurable(join(root, "manifest.json"), {
      ...latest, state: "building", canonical_snapshot_id: snapshotId,
      canonical_snapshot_path: `${snapshotName}/runtime/conversation-store.sqlite`,
      canonical_snapshot: {
        file_sha256: snapshotSha,
        bytes: snapshotBytes,
        duration_ms: snapshotDurationMs,
        canonical_revision: input.expectedCanonicalRevision,
        base_snapshot_id: current.canonical_snapshot?.base_snapshot_id ?? current.canonical_snapshot_id,
        delta_from_snapshot_id: current.canonical_snapshot_id,
      },
      source_inventory_hash: input.sourceInventoryHash,
      registered_source_count: 0,
      unaccounted_source_count: sourceInventoryCount(input.sourceInventory),
      required_acceptance_passed: false, readiness: undefined, acceptance_binding: latest.acceptance_binding,
    });
    committed = true;
  } finally { releaseConsolidationLock(lockPath, lease, committed); }
  return { canonicalSnapshotId: snapshotId, canonicalSnapshotPath: canonicalPath };
}

export function writeMemoryGenerationManifest(
  butlerData: string,
  generationId: string,
  update: (current: MemoryGenerationManifest) => MemoryGenerationManifest,
): MemoryGenerationManifest {
  const root = join(cognitionMemoryRoot(butlerData), "generations", safeGenerationId(generationId));
  const current = readMemoryGenerationManifest(butlerData, generationId);
  const next = update(current);
  if (next.generation_id !== current.generation_id || next.canonical_snapshot_id !== current.canonical_snapshot_id)
    throw new Error("memory_generation_changed");
  writeJsonDurable(join(root, "manifest.json"), next);
  return next;
}

export function inspectMemoryGeneration(input: { butlerData: string; generationId: string }) {
  const manifest = readMemoryGenerationManifest(input.butlerData, input.generationId);
  const graphPath = manifest.format === "legacy"
    ? join(cognitionMemoryRoot(input.butlerData), "db", "graph.sqlite")
    : join(cognitionMemoryRoot(input.butlerData), "generations", input.generationId, "graph.sqlite");
  if (manifest.format === "legacy") return {
    manifest,
    graph_path: graphPath,
    degraded: true,
    reason: "legacy_paused" as const,
    jobs: null,
    windows: null,
    vectors: null,
    cache: null,
  };
  if (!existsSync(graphPath)) return {
    manifest,
    graph_path: graphPath,
    degraded: true,
    reason: "graph_unavailable" as const,
    jobs: null,
    windows: null,
    vectors: null,
    cache: null,
  };
  const db = new Database(graphPath, { readonly: true });
  try {
    const count = (sql: string) => Number(db.query<{ count: number }, []>(sql).get()?.count ?? 0);
    return {
      manifest,
      graph_path: graphPath,
      degraded: false,
      reason: null,
      jobs: count("SELECT COUNT(*) count FROM memory_projection_jobs"),
      windows: {
        complete: count("SELECT COUNT(*) count FROM memory_projection_windows WHERE state='complete'"),
        unsupported: count("SELECT COUNT(*) count FROM memory_projection_windows WHERE state='unsupported'"),
        pending: count("SELECT COUNT(*) count FROM memory_projection_windows WHERE state IN ('pending','planned','running')"),
        failed: count("SELECT COUNT(*) count FROM memory_projection_windows WHERE state='failed'"),
      },
      vectors: {
        complete: count("SELECT COUNT(*) count FROM memory_vector_units WHERE state='complete'"),
        pending: count("SELECT COUNT(*) count FROM memory_vector_units WHERE state IN ('pending','running')"),
        failed: count("SELECT COUNT(*) count FROM memory_vector_units WHERE state='failed'"),
      },
      cache: {
        complete: count(`SELECT COUNT(*) count FROM memory_projection_jobs j
          JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
          WHERE json_extract(j.hot_cache_state,'$.state')='complete'`),
        pending: count(`SELECT COUNT(*) count FROM memory_projection_jobs j
          JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
          WHERE json_extract(j.hot_cache_state,'$.state') IN ('pending','running','partial')`),
        failed: count(`SELECT COUNT(*) count FROM memory_projection_jobs j
          JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
          WHERE json_extract(j.hot_cache_state,'$.state')='failed'`),
        not_configured: count(`SELECT COUNT(*) count FROM memory_projection_jobs j
          JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
          WHERE json_extract(j.hot_cache_state,'$.state')='not_configured'`),
      },
    };
  } finally { db.close(); }
}

type VectorEvidenceRow = ClaimedVectorUnit & { state: string; source_membership_invalid: number };

function loadVectorEvidenceRows(db: Database, generationId: string, state: "complete" | "superseded"): VectorEvidenceRow[] {
  return db.query<VectorEvidenceRow, [string, string]>(`
    SELECT u.*,j.revision source_revision,c.conversation_session_id,
      (SELECT ordered.source_kind FROM memory_chunk_sources ordered
        WHERE ordered.episode_id=c.memory_chunk_id AND ordered.revision=c.current_revision
        ORDER BY ordered.source_id LIMIT 1) source_kind,
      (SELECT ordered.observed_at FROM memory_chunk_sources ordered
        WHERE ordered.episode_id=c.memory_chunk_id AND ordered.revision=c.current_revision
          AND (u.source_ids_json IS NULL OR ordered.source_id IN (SELECT value FROM json_each(u.source_ids_json)))
          AND (u.record_kind='episode' OR (ordered.origin_kind=u.origin_kind AND EXISTS(
            SELECT 1 FROM memory_evidence own WHERE own.source_id=ordered.source_id AND own.node_id=u.owner_id)))
        ORDER BY julianday(ordered.observed_at) DESC,ordered.source_id DESC LIMIT 1) source_observed_at,
      COALESCE(u.source_ids_json,(SELECT json_group_array(source_id) FROM (SELECT source_id
        FROM memory_chunk_sources ordered WHERE ordered.episode_id=c.memory_chunk_id
          AND ordered.revision=c.current_revision AND (u.record_kind='episode' OR
            (ordered.origin_kind=u.origin_kind AND EXISTS(SELECT 1 FROM memory_evidence own
              WHERE own.source_id=ordered.source_id AND own.node_id=u.owner_id)))
        ORDER BY julianday(ordered.observed_at),ordered.conversation_message_id,ordered.part_id,
          ordered.scalar_pointer,ordered.byte_start))) source_ids_json,
      CASE WHEN NOT (u.project_id IS c.project_id)
        OR u.source_ids_json IS NULL OR json_array_length(u.source_ids_json)=0
        OR EXISTS(SELECT 1 FROM json_each(u.source_ids_json) refs WHERE NOT EXISTS(
          SELECT 1 FROM memory_chunk_sources current_source
          WHERE current_source.source_id=refs.value
            AND current_source.episode_id=c.memory_chunk_id
            AND current_source.revision=c.current_revision
            AND (u.record_kind!='node' OR (current_source.origin_kind=u.origin_kind AND EXISTS(
              SELECT 1 FROM memory_evidence current_mention
              WHERE current_mention.node_id=u.owner_id
                AND current_mention.source_id=current_source.source_id
                AND current_mention.episode_id=c.memory_chunk_id
                AND current_mention.revision=c.current_revision)))
        )) THEN 1 ELSE 0 END source_membership_invalid
    FROM memory_vector_units u
    JOIN memory_projection_jobs j ON j.job_id=u.job_id
    JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
    WHERE j.generation=? AND u.state=?
  `).all(generationId, state);
}

export async function reconcileMemoryGenerationVectorRepresentatives(
  context: MemoryExecutionContext,
): Promise<VectorRepresentativeReconciliation> {
  if (context.target.kind !== "rebuild") throw new Error("memory_rebuild_invalid_request");
  const generation = resolveMemoryGeneration(context);
  if (!generation.embedding) return { repaired_vector_keys: [], affected_unit_ids: [] };
  const db = new Database(generation.graphPath, { readonly: true });
  try {
    const current = loadVectorEvidenceRows(db, generation.generationId, "complete")
      .filter((row) => row.source_membership_invalid === 0);
    const superseded = loadVectorEvidenceRows(db, generation.generationId, "superseded")
      .filter((row) => row.source_membership_invalid === 0);
    const result = await reconcilePersistedNodeVectorRepresentatives(
      generation, current, superseded, generation.embedding.version,
    );
    const latest = resolveMemoryGeneration(context);
    if (latest.generationId !== generation.generationId ||
      latest.embedding?.version !== generation.embedding.version)
      throw new Error("memory_generation_changed");
    return result;
  } finally { db.close(); }
}

export async function computeMemoryGenerationReadiness(input: {
  butlerData: string; generationId: string; inventoryHash: string; inventorySourceCount: number;
}): Promise<MemoryGenerationReadiness> {
  const manifest = readMemoryGenerationManifest(input.butlerData, input.generationId);
  if (manifest.source_inventory_hash !== input.inventoryHash) throw new Error("memory_inventory_changed");
  const snapshotRoot = manifest.canonical_snapshot_path
    ? dirname(dirname(join(cognitionMemoryRoot(input.butlerData), "generations", input.generationId, manifest.canonical_snapshot_path)))
    : null;
  if (!snapshotRoot) throw new Error("memory_inventory_changed");
  const inventory = readJson(join(snapshotRoot, "memory-source-inventory.json")) as {
    schema: string;
    as_of?: string;
    origin?: { version?: string | null };
    exclusions?: unknown;
    entries?: Array<{ revision: string; sourceIds: string[]; sourceHashes: string[]; originKinds: string[] }>;
    typed?: Array<{ revision: string; content_hash: string; source_ids: string[] }>;
  };
  if (memorySourceInventoryHash(inventory) !== input.inventoryHash || sourceInventoryCount(inventory) !== input.inventorySourceCount)
    throw new Error("memory_inventory_changed");
  const graphPath = join(cognitionMemoryRoot(input.butlerData), "generations", input.generationId, "graph.sqlite");
  const db = new Database(graphPath, { readonly: true });
  try {
    const count = (sql: string) => Number(db.query<{ count: number }, []>(sql).get()?.count ?? 0);
    const expected = new Map<string, { revision: string; hashes: string[]; origins?: string[] }>();
    for (const entry of inventory.entries ?? []) for (const sourceId of entry.sourceIds)
      expected.set(sourceId, { revision: entry.revision, hashes: entry.sourceHashes, origins: entry.originKinds });
    for (const entry of inventory.typed ?? []) for (const sourceId of entry.source_ids)
      expected.set(sourceId, { revision: entry.revision, hashes: [entry.content_hash] });
    const registeredRows = db.query<{ source_id: string; revision: string; content_hash: string; origin_kind: string }, [string]>(`
      SELECT s.source_id,s.revision,s.content_hash,s.origin_kind FROM memory_source_leaves s
      JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
      JOIN memory_projection_jobs j ON j.episode_id=c.memory_chunk_id AND j.revision=c.current_revision
      WHERE j.generation=?
    `).all(input.generationId);
    const registeredById = new Map(registeredRows.map((row) => [row.source_id, row]));
    const expectedProcessingEvidence = new Map<string, { revision: string; hashes: string[]; origins?: string[] }>();
    const expectedHistoricalEvidence = new Map<string, { revision: string; hashes: string[]; origins?: string[] }>();
    let registered = 0;
    for (const [sourceId, item] of expected) {
      const parent = sourceRows(db, [sourceId])[0];
      const parentMatches = Boolean(parent && parent.revision === item.revision && item.hashes.includes(parent.content_hash) &&
        (!item.origins || item.origins.includes(parent.origin_kind)));
      const lineage = parentMatches && parent
        ? validatedSourceLineage(db, parent, item.origins)
        : null;
      if (lineage && lineage.leaves.every((leaf) => registeredById.has(leaf))) registered += 1;
      if (lineage) {
        for (const leaf of lineage.leaves) expectedProcessingEvidence.set(leaf, item);
        for (const evidenceSource of lineage.all) expectedHistoricalEvidence.set(evidenceSource, item);
      }
    }
    const semantic = {
      complete: count(`SELECT COUNT(*) count FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE j.generation='${input.generationId}' AND w.state='complete'`),
      unsupported: count(`SELECT COUNT(*) count FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE j.generation='${input.generationId}' AND w.state='unsupported'`),
      pending: count(`SELECT COUNT(*) count FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE j.generation='${input.generationId}' AND w.state IN ('pending','planned','running')`),
      failed: count(`SELECT COUNT(*) count FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE j.generation='${input.generationId}' AND w.state='failed'`),
    };
    const vectors = {
      complete: count(`SELECT COUNT(*) count FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE j.generation='${input.generationId}' AND u.state='complete'`),
      pending: count(`SELECT COUNT(*) count FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE j.generation='${input.generationId}' AND u.state IN ('pending','running')`),
      failed: count(`SELECT COUNT(*) count FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE j.generation='${input.generationId}' AND u.state='failed'`),
      not_configured: count(`SELECT COUNT(*) count FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE j.generation='${input.generationId}' AND u.state='not_configured'`),
    };
    const cache = {
      complete: count(`SELECT COUNT(*) count FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE j.generation='${input.generationId}' AND json_extract(j.hot_cache_state,'$.state')='complete'`),
      pending: count(`SELECT COUNT(*) count FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE j.generation='${input.generationId}' AND json_extract(j.hot_cache_state,'$.state') IN ('pending','running','partial')`),
      failed: count(`SELECT COUNT(*) count FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE j.generation='${input.generationId}' AND json_extract(j.hot_cache_state,'$.state')='failed'`),
      not_configured: count(`SELECT COUNT(*) count FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE j.generation='${input.generationId}' AND json_extract(j.hot_cache_state,'$.state')='not_configured'`),
    };
    const semanticEvidenceRows = db.query<{ window_ref: string; source_refs_json: string; state: string; normalized_plan_json: string | null }, [string]>(`
      SELECT w.window_ref,w.source_refs_json,w.state,w.normalized_plan_json FROM memory_projection_windows w
      JOIN memory_projection_jobs j ON j.job_id=w.job_id
      JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
      WHERE j.generation=? AND w.state IN ('complete','unsupported')
    `).all(input.generationId);
    const semanticEvidenceInvalid = semanticEvidenceRows.filter((row) => {
      try {
        const refs = JSON.parse(row.source_refs_json) as unknown;
        return !Array.isArray(refs) || refs.length === 0 || refs.some((ref) => typeof ref !== "string" || !expectedProcessingEvidence.has(ref)) ||
          (row.state === "complete" && !row.normalized_plan_json);
      } catch { return true; }
    }).length;
    const vectorEvidenceRows = loadVectorEvidenceRows(db, input.generationId, "complete");
    const vectorEvidenceInvalid = vectorEvidenceRows.filter((row) => {
      try {
        const receipt = JSON.parse(row.receipt_json ?? "null") as { generation?: string; embedding_version?: string } | null;
        const refs = JSON.parse(row.source_ids_json ?? "[]") as unknown;
        return row.source_membership_invalid !== 0 || !receipt || receipt.generation !== input.generationId || receipt.embedding_version !== manifest.embedding?.version ||
          !Array.isArray(refs) || refs.length === 0 || refs.some((ref) => typeof ref !== "string" || !expectedHistoricalEvidence.has(ref));
      } catch { return true; }
    }).length;
    const cacheEvidenceRows = db.query<{ job_id: string; revision: string; receipt_json: string | null }, [string]>(`
      SELECT j.job_id,j.revision,j.hot_cache_receipt_json receipt_json FROM memory_projection_jobs j
      JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
      WHERE j.generation=? AND json_extract(j.hot_cache_state,'$.state')='complete'
    `).all(input.generationId);
    const cacheEvidenceInvalid = cacheEvidenceRows.filter((row) => {
      try {
        const receipt = JSON.parse(row.receipt_json ?? "null") as {
          generation?: string; source_revision?: string; outcome?: string; reason?: string;
          entries?: Array<{ generation_id?: string; source_revision?: string }>;
        } | null;
        if (!receipt) return true;
        if (Array.isArray(receipt.entries)) return receipt.entries.length === 0 ||
          receipt.entries.some((entry) => entry.generation_id !== input.generationId || entry.source_revision !== row.revision);
        return receipt.outcome !== "excluded" || receipt.reason !== "no_summary" ||
          receipt.generation !== input.generationId || receipt.source_revision !== row.revision;
      } catch { return true; }
    }).length;
    const graphEvidenceRows = db.query<{ edge_id: string; chunk_source_id: string }, [string]>(`
      SELECT ee.edge_id,ee.chunk_source_id FROM edge_evidence ee
      JOIN edges e ON e.edge_id=ee.edge_id AND e.status='active'
      JOIN memory_chunk_sources s ON s.source_id=ee.chunk_source_id
      JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
      JOIN memory_projection_jobs j ON j.episode_id=c.memory_chunk_id AND j.revision=c.current_revision
      WHERE j.generation=? ORDER BY ee.edge_id,ee.chunk_source_id
    `).all(input.generationId);
    const graphEvidenceInvalid = count(`SELECT COUNT(*) count FROM edge_evidence ee JOIN edges e ON e.edge_id=ee.edge_id AND e.status='active' LEFT JOIN memory_chunk_sources s ON s.source_id=ee.chunk_source_id LEFT JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision LEFT JOIN memory_projection_jobs j ON j.episode_id=c.memory_chunk_id AND j.revision=c.current_revision AND j.generation='${input.generationId}' WHERE j.job_id IS NULL`);
    let canonicalEvidenceInvalid = 0;
    for (const sourceId of expectedHistoricalEvidence.keys()) {
      const row = sourceRows(db, [sourceId])[0];
      if (!row) { canonicalEvidenceInvalid += 1; continue; }
      try {
        const hydrated = hydrateSource(snapshotRoot, row);
        if (hydrated.source_hash !== row.content_hash || hydrated.source_ref !== row.source_id)
          canonicalEvidenceInvalid += 1;
      } catch { canonicalEvidenceInvalid += 1; }
    }
    const vectorActualInvalid = await actualVectorEvidenceInvalid({
      generationRoot: join(cognitionMemoryRoot(input.butlerData), "generations", input.generationId),
      generationId: input.generationId,
      embeddingVersion: manifest.embedding?.version ?? null,
      rows: vectorEvidenceRows,
    });
    const cacheActualInvalid = (await invalidCacheEvidenceJobs({
      generationRoot: join(cognitionMemoryRoot(input.butlerData), "generations", input.generationId),
      generationId: input.generationId,
      rows: cacheEvidenceRows,
      sourceButlerData: snapshotRoot,
      now: inventory.as_of ?? new Date().toISOString(),
    })).length;
    const missing = Math.max(0, expected.size - registered);
    const unexpected = registeredRows.filter((row) => !expectedProcessingEvidence.has(row.source_id)).length;
    const unaccounted = missing + unexpected + semanticEvidenceInvalid + vectorEvidenceInvalid + cacheEvidenceInvalid +
      graphEvidenceInvalid + canonicalEvidenceInvalid + vectorActualInvalid + cacheActualInvalid;
    const evidence = {
      inventory_hash: input.inventoryHash,
      registered_rows: registeredRows.slice().sort((a, b) => a.source_id.localeCompare(b.source_id)),
      semantic_rows: semanticEvidenceRows.slice().sort((a, b) => a.window_ref.localeCompare(b.window_ref)),
      vector_rows: vectorEvidenceRows.slice().sort((a, b) => a.unit_id.localeCompare(b.unit_id)),
      cache_rows: cacheEvidenceRows.slice().sort((a, b) => a.job_id.localeCompare(b.job_id)),
      cache_outcome_rows: db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_hot_cache_outcomes'").get()
        ? db.query("SELECT * FROM memory_hot_cache_outcomes WHERE generation=? ORDER BY entry_id").all(input.generationId) : [],
      graph_rows: graphEvidenceRows,
      canonical_invalid: canonicalEvidenceInvalid,
      vector_actual_invalid: vectorActualInvalid,
      cache_actual_invalid: cacheActualInvalid,
    };
    const evidenceSha = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
    const value = {
      schema: "butler.memory-generation-readiness.v1" as const,
      inventory_hash: input.inventoryHash, registered, unaccounted,
      semantic, vectors, cache, evidence_sha256: evidenceSha,
      ready: unaccounted === 0 && semantic.pending === 0 && semantic.failed === 0 &&
        vectors.pending === 0 && vectors.failed === 0 && vectors.not_configured === 0 &&
        cache.pending === 0 && cache.failed === 0 && cache.not_configured === 0,
    };
    return { ...value, sha256: createHash("sha256").update(JSON.stringify(value)).digest("hex") };
  } finally { db.close(); }
}

function validatedSourceLineage(
  db: Database,
  root: ProjectionSourceRow,
  allowedOrigins?: string[],
): { leaves: string[]; all: string[] } | null {
  const visited = new Set<string>();
  const walk = (sourceId: string): { leaves: string[]; all: string[] } | null => {
    if (visited.has(sourceId)) return null;
    visited.add(sourceId);
    const row = sourceRows(db, [sourceId])[0];
    if (!row || row.episode_id !== root.episode_id || row.revision !== root.revision ||
      row.content_hash !== root.content_hash || row.source_kind !== root.source_kind ||
      row.part_id !== root.part_id || row.scalar_pointer !== root.scalar_pointer ||
      row.byte_start < root.byte_start || row.byte_end > root.byte_end || row.byte_start >= row.byte_end ||
      (allowedOrigins && !allowedOrigins.includes(row.origin_kind))) return null;
    const split = db.query<{ child_source_ids_json: string }, [string]>(
      "SELECT child_source_ids_json FROM memory_source_split_parents WHERE source_id=?",
    ).get(sourceId);
    if (!split) return { leaves: [sourceId], all: [sourceId] };
    let childIds: string[];
    try {
      const parsed = JSON.parse(split.child_source_ids_json) as unknown;
      if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((child) => typeof child !== "string") ||
        new Set(parsed).size !== parsed.length) return null;
      childIds = parsed;
    } catch { return null; }
    const children = childIds.map((child) => sourceRows(db, [child])[0]);
    if (children.some((child) => !child)) return null;
    const ordered = children.slice().sort((a, b) => a!.byte_start - b!.byte_start || a!.source_id.localeCompare(b!.source_id));
    if (ordered[0]!.byte_start !== row.byte_start || ordered.at(-1)!.byte_end !== row.byte_end ||
      ordered.some((child, index) => child!.episode_id !== row.episode_id || child!.revision !== row.revision ||
        child!.content_hash !== row.content_hash || child!.source_kind !== row.source_kind || child!.part_id !== row.part_id ||
        child!.scalar_pointer !== row.scalar_pointer || child!.origin_kind !== row.origin_kind ||
        (index > 0 && ordered[index - 1]!.byte_end !== child!.byte_start))) return null;
    const descendants = childIds.map(walk);
    if (descendants.some((child) => !child)) return null;
    return {
      leaves: descendants.flatMap((child) => child!.leaves),
      all: [sourceId, ...descendants.flatMap((child) => child!.all)],
    };
  };
  return walk(root.source_id);
}

async function actualVectorEvidenceInvalid(input: {
  generationRoot: string;
  generationId: string;
  embeddingVersion: string | null;
  rows: Array<ClaimedVectorUnit & { state: string }>;
}): Promise<number> {
  if (input.rows.length === 0) return 0;
  if (!input.embeddingVersion) return input.rows.length;
  const generation: MemoryGenerationHandle = {
    generationId: input.generationId,
    root: input.generationRoot,
    graphPath: join(input.generationRoot, "graph.sqlite"),
    embedding: null,
    sourceRoot: input.generationRoot,
    canonicalSnapshotPath: null,
  };
  return countInvalidPersistedVectorReadiness(
    generation,
    input.rows,
    input.embeddingVersion,
  );
}

async function invalidCacheEvidenceJobs(input: {
  generationRoot: string;
  generationId: string;
  rows: Array<{ job_id: string; revision: string; receipt_json: string | null }>;
  sourceButlerData: string;
  now: string;
}): Promise<string[]> {
  const generation: MemoryGenerationHandle = {
    generationId: input.generationId,
    root: input.generationRoot,
    graphPath: join(input.generationRoot, "graph.sqlite"),
    embedding: null,
    sourceRoot: input.sourceButlerData,
    canonicalSnapshotPath: join(input.sourceButlerData, "runtime", "conversation-store.sqlite"),
  };
  const evidence = await import("../../continuity/hot-cache-writer.ts").then((module) =>
    module.readGenerationHotCacheCandidateEvidence({ generation, sourceButlerData: input.sourceButlerData, now: input.now }));
  const entries = new Map(evidence.map((entry) => [entry.entry_id, entry]));
  const evicted = new Set<string>();
  const db = new Database(generation.graphPath, { readonly: true });
  let historicalRows: Array<{ receipt_json: string | null }>;
  let outcomes: Map<string, number>;
  try {
    historicalRows = db.query<{ receipt_json: string | null }, [string]>(`
      SELECT j.hot_cache_receipt_json receipt_json FROM memory_projection_jobs j
      JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
      WHERE j.generation=? AND j.hot_cache_receipt_json IS NOT NULL`).all(input.generationId);
    outcomes = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_hot_cache_outcomes'").get()
      ? new Map(db.query<{ entry_id: string; admitted: number }, [string]>(
        "SELECT entry_id,admitted FROM memory_hot_cache_outcomes WHERE generation=?").all(input.generationId)
        .map((row) => [row.entry_id, row.admitted])) : new Map();
  } finally { db.close(); }
  for (const row of historicalRows) {
    try {
      const receipt = JSON.parse(row.receipt_json ?? "null") as {
        entries?: Array<{ excluded_entries?: Array<{ entry_id?: string; reason?: string }> }>;
      };
      for (const excluded of (receipt.entries ?? []).flatMap((entry) => entry.excluded_entries ?? []))
        if (excluded.entry_id && ["budget", "oversized", "expired", "invalidated"].includes(excluded.reason ?? ""))
          evicted.add(excluded.entry_id);
    } catch {}
  }
  return input.rows.filter((row) => {
    try {
      const receipt = JSON.parse(row.receipt_json ?? "null") as {
        outcome?: string; reason?: string;
        entries?: Array<{ source_id?: string; source_revision?: string; generation_id?: string; admitted?: boolean; excluded_entries?: unknown[] }>;
      } | null;
      if (!receipt) return true;
      if ((!Array.isArray(receipt.entries) || receipt.entries.length === 0) && receipt.outcome === "excluded" && ["no_summary", "no_window_summary"].includes(receipt.reason ?? ""))
        return false;
      if (!Array.isArray(receipt.entries) || receipt.entries.length === 0) return true;
      return receipt.entries.some((item) => {
        if (item.generation_id !== input.generationId || item.source_revision !== row.revision || !item.source_id) return true;
        const admission = outcomes.get(item.source_id);
        if (admission === 0 || (admission === undefined && (item.admitted === false || evicted.has(item.source_id)))) return false;
        const entry = entries.get(item.source_id);
        return !entry || entry.source_revision !== row.revision || !entry.current;
      });
    } catch { return true; }
  }).map((row) => row.job_id);
}

/** Called under the existing rebuild write gate; only cache work is requeued. */
export async function reconcileMemoryGenerationHotCache(context: MemoryExecutionContext): Promise<number> {
  if (context.target.kind !== "rebuild") throw new Error("memory_rebuild_invalid_request");
  const generation = resolveMemoryGeneration(context);
  const inventory = readJson(join(generation.sourceRoot, "memory-source-inventory.json")) as { as_of?: string };
  const db = new Database(generation.graphPath);
  try {
    ensureV2MemorySchema(db);
    // Retain provable legacy evictions before another job replaces its receipt.
    const present = new Set((await import("../../continuity/hot-cache-writer.ts")).readGenerationHotCacheCandidateEvidence({
      generation, sourceButlerData: generation.sourceRoot, now: inventory.as_of ?? new Date().toISOString(),
    }).map((entry) => entry.entry_id));
    const remember = db.query(`INSERT OR IGNORE INTO memory_hot_cache_outcomes
      (entry_id,generation,admitted,reason,receipt_json) VALUES(?,?,0,?,?)`);
    for (const row of db.query<{ receipt_json: string }, [string]>(`
      SELECT j.hot_cache_receipt_json receipt_json FROM memory_projection_jobs j
      JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
      WHERE j.generation=? AND j.hot_cache_receipt_json IS NOT NULL`).all(generation.generationId)) {
      try {
        const receipt = JSON.parse(row.receipt_json) as { entries?: Array<{
          generation_id?: string; excluded_entries?: Array<{ entry_id: string; reason: string }>;
        }> };
        for (const entry of receipt.entries ?? []) {
          if (entry.generation_id !== generation.generationId) continue;
          for (const excluded of entry.excluded_entries ?? [])
            if (!present.has(excluded.entry_id) && ["budget", "oversized", "expired", "invalidated"].includes(excluded.reason))
              remember.run(excluded.entry_id, generation.generationId, excluded.reason, JSON.stringify(entry));
        }
      } catch { /* Malformed evidence remains subject to readiness validation. */ }
    }
    const rows = db.query<{ job_id: string; revision: string; receipt_json: string | null }, [string]>(`
      SELECT j.job_id,j.revision,j.hot_cache_receipt_json receipt_json FROM memory_projection_jobs j
      JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
      WHERE j.generation=? AND json_extract(j.hot_cache_state,'$.state')='complete'`).all(generation.generationId);
    const invalid = await invalidCacheEvidenceJobs({ generationRoot: generation.root,
      generationId: generation.generationId, rows, sourceButlerData: generation.sourceRoot,
      now: inventory.as_of ?? new Date().toISOString() });
    return db.transaction(() => {
      let changed = 0;
      for (const job of invalid) changed += db.query(`UPDATE memory_projection_jobs
        SET hot_cache_state=?,hot_cache_next_attempt_at=NULL,hot_cache_attempt_count=0
        WHERE job_id=? AND json_extract(hot_cache_state,'$.state')='complete'`)
        .run(JSON.stringify({ state: "pending", blocked_by: "hot_cache_evidence_missing" }), job).changes;
      return changed;
    })();
  } finally { db.close(); }
}

export type MemoryGenerationCandidateWitness = {
  sha256: string;
  assertCurrent: () => Promise<void>;
  close: () => void;
};

function fileIdentity(path: string): { dev: number; ino: number; bytes: number; mtime_ms: number } | null {
  if (!existsSync(path)) return null;
  const value = statSync(path);
  return { dev: value.dev, ino: value.ino, bytes: value.size, mtime_ms: value.mtimeMs };
}

function boundedCacheIdentity(path: string): { identity: ReturnType<typeof fileIdentity>; sha256: string | null } {
  const identity = fileIdentity(path);
  if (!identity) return { identity: null, sha256: null };
  if (identity.bytes > 20 * 1024) throw new Error("memory_generation_not_ready");
  return { identity, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
}

export async function openMemoryGenerationCandidateWitness(
  butlerData: string,
  generationId: string,
): Promise<MemoryGenerationCandidateWitness> {
  const root = join(cognitionMemoryRoot(butlerData), "generations", safeGenerationId(generationId));
  const manifest = readMemoryGenerationManifest(butlerData, generationId);
  const snapshotPath = manifest.canonical_snapshot_path ? join(root, manifest.canonical_snapshot_path) : null;
  const graphPath = join(root, "graph.sqlite");
  const db = new Database(graphPath, { readonly: true });
  const dataVersion = () => Number(Object.values(db.query<Record<string, number>, []>("PRAGMA main.data_version").get() ?? {})[0] ?? -1);
  const initialDataVersion = dataVersion();
  const lanceRoot = join(root, "butler.lance");
  let connection: LanceConnection | null = null;
  let table: LanceTable | null = null;
  try {
    if (existsSync(lanceRoot)) {
      const lancedb = await import("@lancedb/lancedb");
      connection = await lancedb.connect(lanceRoot);
      if ((await connection.tableNames()).includes("butler_memory")) {
        table = await connection.openTable("butler_memory");
        await table.checkoutLatest();
      }
    }
  } catch (error) {
    table?.close();
    connection?.close();
    db.close();
    throw error;
  }
  let initialLanceVersion: number | null;
  try { initialLanceVersion = table ? await table.version() : null; }
  catch (error) { table?.close(); connection?.close(); db.close(); throw error; }
  const cachePath = join(root, "hot", "cache.md");
  const facts = async () => {
    if (table) await table.checkoutLatest();
    const currentManifest = readMemoryGenerationManifest(butlerData, generationId);
    return {
      manifest: {
        generation_id: currentManifest.generation_id,
        state: currentManifest.state,
        canonical_snapshot_id: currentManifest.canonical_snapshot_id,
        canonical_snapshot_path: currentManifest.canonical_snapshot_path,
        canonical_snapshot: currentManifest.canonical_snapshot,
        source_inventory_hash: currentManifest.source_inventory_hash,
        extraction_version: currentManifest.extraction_version,
        embedding: currentManifest.embedding,
        readiness_sha256: currentManifest.readiness?.sha256 ?? null,
        required_acceptance_passed: currentManifest.required_acceptance_passed,
        acceptance_binding: currentManifest.acceptance_binding ?? null,
      },
      graph: fileIdentity(graphPath),
      graph_data_version: dataVersion(),
      lance_root: fileIdentity(lanceRoot),
      lance_version: table ? await table.version() : null,
      snapshot: snapshotPath ? fileIdentity(snapshotPath) : null,
      cache: boundedCacheIdentity(cachePath),
    };
  };
  let initial: Awaited<ReturnType<typeof facts>>;
  try { initial = await facts(); }
  catch (error) { table?.close(); connection?.close(); db.close(); throw error; }
  if (initial.graph_data_version !== initialDataVersion || initial.lance_version !== initialLanceVersion) {
    table?.close(); connection?.close(); db.close();
    throw new Error("memory_generation_changed");
  }
  const sha256 = createHash("sha256").update(JSON.stringify(initial)).digest("hex");
  let closed = false;
  return {
    sha256,
    assertCurrent: async () => {
      if (closed || createHash("sha256").update(JSON.stringify(await facts())).digest("hex") !== sha256)
        throw new Error("memory_generation_changed");
    },
    close: () => {
      if (closed) return;
      closed = true;
      table?.close();
      connection?.close();
      db.close();
    },
  };
}

export async function readMemoryGenerationCandidatePreimage(
  butlerData: string,
  generationId: string,
): Promise<string> {
  const witness = await openMemoryGenerationCandidateWitness(butlerData, generationId);
  try { return witness.sha256; }
  finally { witness.close(); }
}

type StableQualificationFile = { sha256: string; fact: string; bytes: Buffer };

function qualificationFileFact(path: string): string {
  const value = statSync(path, { bigint: true });
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].map(String).join(":");
}

function readStableQualificationFile(path: string, expectedSha?: string): StableQualificationFile {
  let before: string, bytes: Buffer, after: string;
  try { before = qualificationFileFact(path); bytes = readFileSync(path); after = qualificationFileFact(path); }
  catch { throw new Error("memory_acceptance_evidence_changed"); }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (before !== after || expectedSha && sha256 !== expectedSha)
    throw new Error("memory_acceptance_evidence_changed");
  return { sha256, fact: after, bytes };
}

function prepareQualificationEvidence(
  acceptancePath: string,
  verificationRoot: string,
  acceptance: MemoryRecoveryAcceptance,
  acceptanceFile: StableQualificationFile,
): { closureSha: string; witness: QualificationEvidenceWitness } {
  const byPath = new Map<string, { ref: string; sha256: string; fact: string; bytes: Buffer }>();
  byPath.set(acceptancePath, { ref: "acceptance", ...acceptanceFile });
  const capture = (ref: string, expectedSha: string): Buffer => {
    const path = ref === "acceptance" ? acceptancePath : join(verificationRoot, ref);
    const prior = byPath.get(path);
    if (prior) {
      if (prior.sha256 !== expectedSha) throw new Error("memory_acceptance_evidence_changed");
      return prior.bytes;
    }
    const file = readStableQualificationFile(path, expectedSha);
    byPath.set(path, { ref, ...file });
    return file.bytes;
  };
  const parse = <T>(ref: string, sha256: string): T => {
    try { return JSON.parse(capture(ref, sha256).toString("utf8")) as T; }
    catch { throw new Error("memory_acceptance_evidence_changed"); }
  };
  for (const item of acceptance.cases) {
    const trace = parse<MemoryRecoveryCaseTrace>(item.trace_ref, item.trace_sha256);
    capture(trace.qualification_source_inventory_ref, trace.qualification_source_inventory_sha256);
    capture(trace.execution.source_inventory_ref, trace.execution.source_inventory_sha256);
    for (const source of trace.source_observations) {
      const binding = parse<MemorySourceBindingEvidence>(source.binding_ref, source.binding_sha256);
      capture(binding.read_result_ref, binding.read_result_sha256);
    }
    for (const ref of [
      ...trace.extractor_attempt_refs,
      ...trace.embedding_receipt_refs,
      ...(trace.owner_result_refs ?? []),
      ...(trace.owner_source_result_refs ?? []),
      ...(trace.supporting_execution_refs ?? []),
      ...trace.query.result_refs,
    ])
      capture(ref.ref, ref.sha256);
  }
  const report = parse<MemoryRecoveryPerformanceReport>(acceptance.performance.report_ref, acceptance.performance.report_sha256);
  for (const sample of report.samples) {
    capture(sample.result_ref, sample.result_sha256);
    capture(sample.metrics_ref, sample.metrics_sha256);
    for (const ref of sample.source_binding_refs) {
      const binding = parse<MemorySourceBindingEvidence>(ref.ref, ref.sha256);
      capture(binding.read_result_ref, binding.read_result_sha256);
    }
  }
  for (const ref of report.contention.queue_work_refs) capture(ref.ref, ref.sha256);
  const entries = [...byPath.entries()].map(([path, value]) => [value.ref, value.sha256, path] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return {
    closureSha: createHash("sha256").update(JSON.stringify(entries.map(([ref, sha256]) => [ref, sha256]))).digest("hex"),
    witness: { assertCurrent: () => {
    for (const [path, value] of byPath) {
      try { if (qualificationFileFact(path) !== value.fact) throw new Error("memory_acceptance_evidence_changed"); }
      catch { throw new Error("memory_acceptance_evidence_changed"); }
    }
    } },
  };
}

type QualificationEvidenceWitness = { assertCurrent: () => void };

export type PreparedMemoryGenerationValidation = {
  readiness: MemoryGenerationReadiness;
  acceptance: MemoryRecoveryAcceptance;
  qualificationSha: string;
  implementationCommit: string;
  candidatePreimageSha: string;
  qualificationClosureSha: string;
  qualificationWitness: QualificationEvidenceWitness;
  candidateWitness: MemoryGenerationCandidateWitness;
};

export type PreparedMemoryGenerationActivation = {
  manifestSha: string;
  readiness: MemoryGenerationReadiness;
  acceptance: MemoryRecoveryAcceptance;
  qualificationSha: string;
  implementationCommit: string;
  candidatePreimageSha: string;
  qualificationClosureSha: string;
  qualificationWitness: QualificationEvidenceWitness;
  inventorySourceCount: number;
  candidateWitness: MemoryGenerationCandidateWitness;
};

export type PreparedMemoryGenerationQualificationReuse = {
  manifestSha: string;
  acceptance: MemoryRecoveryAcceptance;
  qualificationSha: string;
  implementationCommit: string;
  qualificationClosureSha: string;
  qualificationWitness: QualificationEvidenceWitness;
  candidateWitness: MemoryGenerationCandidateWitness;
};

export async function prepareMemoryGenerationValidation(input: {
  butlerData: string; generationId: string; acceptancePath: string; verificationRoot: string;
  inventoryHash: string; inventorySourceCount: number;
}): Promise<PreparedMemoryGenerationValidation> {
  const candidateWitness = await openMemoryGenerationCandidateWitness(input.butlerData, input.generationId);
  try {
  let readiness: MemoryGenerationReadiness;
  try {
    readiness = await computeMemoryGenerationReadiness(input);
    await candidateWitness.assertCurrent();
  } catch (error) {
    candidateWitness.close();
    throw error;
  }
  if (!readiness.ready) throw new Error("memory_generation_not_ready");
  const acceptanceFile = readStableQualificationFile(input.acceptancePath);
  const bytes = acceptanceFile.bytes;
  const qualificationSha = acceptanceFile.sha256;
  let acceptance: MemoryRecoveryAcceptance;
  try { acceptance = JSON.parse(bytes.toString("utf8")) as MemoryRecoveryAcceptance; }
  catch { throw new Error("memory_acceptance_invalid"); }
  assertMemoryRecoveryAcceptance(acceptance, input.verificationRoot);
  const implementationCommit = currentMemoryImplementationCommit();
  const manifest = readMemoryGenerationManifest(input.butlerData, input.generationId);
  if (!implementationCommit || acceptance.implementation_commit !== implementationCommit ||
    acceptance.extraction_version !== manifest.extraction_version || acceptance.embedding_version !== manifest.embedding?.version)
    throw new Error("memory_acceptance_version_mismatch");
  const candidatePreimageSha = candidateWitness.sha256;
  const qualificationEvidence = prepareQualificationEvidence(
    input.acceptancePath, input.verificationRoot, acceptance, acceptanceFile,
  );
  const qualificationClosureSha = qualificationEvidence.closureSha;
  const qualificationWitness = qualificationEvidence.witness;
  persistQualificationEvidence(input.butlerData, input.generationId, input.acceptancePath, input.verificationRoot, acceptance);
  return { readiness, acceptance, qualificationSha, implementationCommit, candidatePreimageSha,
    qualificationClosureSha, qualificationWitness, candidateWitness };
  } catch (error) {
    candidateWitness.close();
    throw error;
  }
}

export async function prepareMemoryGenerationActivation(input: {
  butlerData: string;
  generationId: string;
  expectedInventoryHash: string;
  inventorySourceCount: number;
}): Promise<PreparedMemoryGenerationActivation> {
  const manifest = readMemoryGenerationManifest(input.butlerData, input.generationId);
  const binding = manifest.acceptance_binding;
  const generationRoot = join(cognitionMemoryRoot(input.butlerData), "generations", input.generationId);
  const acceptancePath = binding && safeVerificationRef(binding.qualification_ref)
    ? join(generationRoot, binding.qualification_ref)
    : null;
  const verificationRoot = binding && safeVerificationRef(binding.verification_root_ref)
    ? join(generationRoot, binding.verification_root_ref)
    : null;
  if (manifest.state !== "ready" || !manifest.required_acceptance_passed || !manifest.readiness?.ready ||
    manifest.source_inventory_hash !== input.expectedInventoryHash || !binding ||
    binding.target_generation_id !== input.generationId ||
    binding.target_source_inventory_hash !== input.expectedInventoryHash ||
    binding.target_readiness_sha256 !== manifest.readiness.sha256 || !acceptancePath || !verificationRoot ||
    !existsSync(acceptancePath)) throw new Error("activation_requires_catchup");
  const candidateWitness = await openMemoryGenerationCandidateWitness(input.butlerData, input.generationId);
  try {
  let readiness: MemoryGenerationReadiness;
  try {
    readiness = await computeMemoryGenerationReadiness({
      butlerData: input.butlerData,
      generationId: input.generationId,
      inventoryHash: input.expectedInventoryHash,
      inventorySourceCount: input.inventorySourceCount,
    });
    await candidateWitness.assertCurrent();
  } catch (error) {
    candidateWitness.close();
    throw error;
  }
  if (!readiness.ready || readiness.sha256 !== manifest.readiness.sha256)
    throw new Error("activation_requires_catchup");
  const acceptanceFile = readStableQualificationFile(acceptancePath, binding.qualification_sha256);
  const bytes = acceptanceFile.bytes;
  let acceptance: MemoryRecoveryAcceptance;
  try { acceptance = JSON.parse(bytes.toString("utf8")) as MemoryRecoveryAcceptance; }
  catch { throw new Error("memory_acceptance_invalid"); }
  assertMemoryRecoveryAcceptance(acceptance, verificationRoot);
  const implementationCommit = currentMemoryImplementationCommit();
  if (!implementationCommit || binding.implementation_commit !== implementationCommit ||
    acceptance.implementation_commit !== implementationCommit ||
    acceptance.extraction_version !== manifest.extraction_version ||
    acceptance.embedding_version !== manifest.embedding?.version)
    throw new Error("memory_acceptance_version_mismatch");
  const qualificationEvidence = prepareQualificationEvidence(
    acceptancePath, verificationRoot, acceptance, acceptanceFile,
  );
  const qualificationClosureSha = qualificationEvidence.closureSha;
  const qualificationWitness = qualificationEvidence.witness;
  const candidatePreimageSha = candidateWitness.sha256;
  if (readiness.evidence_sha256 !== binding.target_evidence_sha256)
    throw new Error("activation_requires_catchup");
  return {
    manifestSha: generationManifestSha(input.butlerData, input.generationId),
    readiness,
    acceptance,
    qualificationSha: binding.qualification_sha256,
    implementationCommit,
    candidatePreimageSha,
    qualificationClosureSha,
    qualificationWitness,
    inventorySourceCount: input.inventorySourceCount,
    candidateWitness,
  };
  } catch (error) {
    candidateWitness.close();
    throw error;
  }
}

export async function prepareMemoryGenerationQualificationReuse(input: {
  butlerData: string;
  generationId: string;
}): Promise<PreparedMemoryGenerationQualificationReuse> {
  const manifest = readMemoryGenerationManifest(input.butlerData, input.generationId);
  const binding = manifest.acceptance_binding;
  const generationRoot = join(cognitionMemoryRoot(input.butlerData), "generations", input.generationId);
  const acceptancePath = binding && safeVerificationRef(binding.qualification_ref)
    ? join(generationRoot, binding.qualification_ref)
    : null;
  const verificationRoot = binding && safeVerificationRef(binding.verification_root_ref)
    ? join(generationRoot, binding.verification_root_ref)
    : null;
  if (!binding || !acceptancePath || !verificationRoot || !existsSync(acceptancePath))
    throw new Error("memory_rollback_requires_validation");
  const acceptanceFile = readStableQualificationFile(acceptancePath, binding.qualification_sha256);
  const bytes = acceptanceFile.bytes;
  let acceptance: MemoryRecoveryAcceptance;
  try { acceptance = JSON.parse(bytes.toString("utf8")) as MemoryRecoveryAcceptance; }
  catch { throw new Error("memory_acceptance_invalid"); }
  assertMemoryRecoveryAcceptance(acceptance, verificationRoot);
  const implementationCommit = currentMemoryImplementationCommit();
  if (!implementationCommit || binding.implementation_commit !== implementationCommit ||
    acceptance.implementation_commit !== implementationCommit ||
    acceptance.extraction_version !== manifest.extraction_version ||
    acceptance.embedding_version !== manifest.embedding?.version)
    throw new Error("memory_acceptance_version_mismatch");
  const qualificationEvidence = prepareQualificationEvidence(
    acceptancePath, verificationRoot, acceptance, acceptanceFile,
  );
  const qualificationClosureSha = qualificationEvidence.closureSha;
  const qualificationWitness = qualificationEvidence.witness;
  const candidateWitness = await openMemoryGenerationCandidateWitness(input.butlerData, input.generationId);
  return {
    manifestSha: generationManifestSha(input.butlerData, input.generationId),
    acceptance,
    qualificationSha: binding.qualification_sha256,
    implementationCommit,
    qualificationClosureSha,
    qualificationWitness,
    candidateWitness,
  };
}

export function resumeRetiredMemoryGenerationForBuild(input: {
  butlerData: string;
  generationId: string;
  expectedActiveGeneration: string;
}, lease: ConsolidationLease): MemoryGenerationManifest {
  assertConsolidationLease(consolidationLockPath(input.butlerData), lease);
  if (lease.purpose !== "rebuild_prepare") throw new Error("memory_generation_changed");
  const descriptor = readActiveDescriptor(input.butlerData);
  const manifest = readMemoryGenerationManifest(input.butlerData, input.generationId);
  if (descriptor.generation_id !== input.expectedActiveGeneration ||
    descriptor.previous_generation_id !== input.generationId || manifest.format !== "v2" || manifest.state !== "retired")
    throw new Error("memory_generation_changed");
  return writeMemoryGenerationManifest(input.butlerData, input.generationId, (current) => ({ ...current, state: "building" }));
}

export async function validateMemoryGeneration(input: {
  butlerData: string; generationId: string; acceptancePath: string; verificationRoot: string;
  inventoryHash: string; inventorySourceCount: number;
  assertCurrentInventory: () => void;
}, prepared: PreparedMemoryGenerationValidation, lease: ConsolidationLease): Promise<MemoryGenerationManifest> {
  assertConsolidationLease(consolidationLockPath(input.butlerData), lease);
  await prepared.candidateWitness.assertCurrent();
  input.assertCurrentInventory();
  const candidatePreimageSha = prepared.candidateWitness.sha256;
  const readiness = prepared.readiness;
  if (!readiness.ready || candidatePreimageSha !== prepared.candidatePreimageSha)
    throw new Error("memory_generation_not_ready");
  const implementationCommit = currentMemoryImplementationCommit();
  const manifest = readMemoryGenerationManifest(input.butlerData, input.generationId);
  if (readiness.sha256 !== prepared.readiness.sha256 || !implementationCommit ||
    prepared.implementationCommit !== implementationCommit || prepared.acceptance.implementation_commit !== implementationCommit ||
    prepared.acceptance.extraction_version !== manifest.extraction_version || prepared.acceptance.embedding_version !== manifest.embedding?.version)
    throw new Error("memory_acceptance_version_mismatch");
  prepared.qualificationWitness.assertCurrent();
  return writeMemoryGenerationManifest(input.butlerData, input.generationId, (current) => ({
    ...current,
    state: "ready",
    registered_source_count: readiness.registered,
    unaccounted_source_count: readiness.unaccounted,
    required_acceptance_passed: true,
    readiness,
    acceptance_binding: {
      qualification_sha256: prepared.qualificationSha,
      qualification_ref: "qualification/acceptance.json",
      verification_root_ref: "qualification/evidence",
      implementation_commit: implementationCommit,
      verification_generation_id: prepared.acceptance.verification_generation_id,
      target_generation_id: input.generationId,
      target_source_inventory_hash: input.inventoryHash,
      target_readiness_sha256: readiness.sha256,
      target_evidence_sha256: readiness.evidence_sha256,
    },
  }));
}

function assertMemoryRecoveryAcceptance(value: MemoryRecoveryAcceptance, verificationRoot: string): void {
  if (!value || value.schema !== "butler.memory-recovery-acceptance.v3" || value.tool_contract_version !== 2 ||
    !["memory-extract-v2", MEMORY_EXTRACTION_VERSION].includes(value.extraction_version) || !validSha(value.verification_source_inventory_hash) ||
    !validGitCommit(value.implementation_commit) || !validSha(value.embedding_version) || !Array.isArray(value.cases))
    throw new Error("memory_acceptance_invalid");
  const ids = new Set<string>();
  const coverage = new Set<string>();
  for (const item of value.cases) {
    if (!item.id || ids.has(item.id) || item.outcome !== "passed" ||
      !["public_app_btcc", "native_tool", "owner_integration"].includes(item.path) ||
      !validSha(item.query_hash) || !validSha(item.trace_sha256) || !safeVerificationRef(item.trace_ref))
      throw new Error("memory_acceptance_invalid");
    ids.add(item.id);
    item.mr_ids.forEach((mr) => coverage.add(mr));
    const trace = readVerificationJson<MemoryRecoveryCaseTrace>(verificationRoot, item.trace_ref, item.trace_sha256);
    const finalInventory = readVerificationJson<MemorySourceInventoryLike>(verificationRoot,
      trace.qualification_source_inventory_ref, trace.qualification_source_inventory_sha256);
    const executionInventory = readVerificationJson<MemorySourceInventoryLike>(verificationRoot,
      trace.execution.source_inventory_ref, trace.execution.source_inventory_sha256);
    const queryRefs = Array.isArray(trace.query?.result_refs) ? trace.query.result_refs : [];
    const queryResults = queryRefs.map((ref) =>
      readVerificationJson<MemoryQueryResultEvidence>(verificationRoot, ref.ref, ref.sha256));
    const topBound = item.path !== "owner_integration";
    const ownerSourceRefs = trace.owner_source_result_refs ?? [];
    const ownerSourceResults = ownerSourceRefs.map((ref) =>
      readVerificationJson<MemoryOwnerResultEvidence>(verificationRoot, ref.ref, ref.sha256));
    const observedResults = topBound ? queryResults : ownerSourceResults;
    const observedResultIds = observedResults.map((result) => result.result_id);
    if (trace.schema !== "butler.memory-recovery-case-trace.v1" ||
      !trace.execution || !validGitCommit(trace.execution.implementation_commit) ||
      trace.execution.implementation_commit !== value.implementation_commit ||
      trace.execution.tool_contract_version !== value.tool_contract_version ||
      trace.execution.extraction_version !== value.extraction_version ||
      (topBound && trace.execution.embedding.status === "executed" &&
        trace.execution.embedding.version !== value.embedding_version) ||
      (topBound && trace.execution.embedding.status === "not_executed" && item.uses_real_embedding) ||
      (!topBound && trace.execution.embedding.status === "executed" && !validSha(trace.execution.embedding.version)) ||
      (!topBound && trace.execution.embedding.status === "not_executed" && item.uses_real_embedding) ||
      trace.query?.sha256 !== item.query_hash ||
      !Array.isArray(trace.query.result_refs) ||
      (topBound && queryResults.some((result, index) => result.schema !== "butler.memory-query-result-evidence.v1" ||
        result.result_id !== queryRefs[index]?.result_id ||
        result.query_hash !== item.query_hash || result.generation_id !== trace.execution.generation_id ||
        result.request_id !== trace.query.request_id || !["ok", "partial"].includes(result.status) ||
        !Array.isArray(result.source_handles) || !Array.isArray(result.observations))) ||
      (!topBound && ownerSourceResults.some((result, index) =>
        result.schema !== "butler.memory-owner-result-evidence.v1" ||
        result.result_id !== ownerSourceRefs[index]?.result_id || result.generation_id !== trace.execution.generation_id ||
        !["ok", "partial"].includes(result.status) || !Array.isArray(result.source_handles) ||
        !Array.isArray(result.observations) || !(trace.owner_result_refs ?? []).some((ref) =>
          ref.ref === ownerSourceRefs[index]?.ref && ref.sha256 === ownerSourceRefs[index]?.sha256))) ||
      (topBound && !sameStringSet(observedResultIds, trace.native_result_ids)) ||
      trace.qualification_source_inventory_hash !== value.verification_source_inventory_hash ||
      memorySourceInventoryHash(finalInventory) !== value.verification_source_inventory_hash ||
      memorySourceInventoryHash(executionInventory) !== trace.execution.stage_source_inventory_hash ||
      (topBound && trace.execution.generation_id !== value.verification_generation_id) ||
      !validSha(trace.execution.stage_source_inventory_hash) ||
      !sameStringSet(trace.expected_source_handles, item.expected_source_refs) ||
      !sameStringSet(trace.observed_source_handles, item.observed_source_refs) ||
      !sameStringSet(trace.observed_source_handles, item.source_refs) ||
      !Array.isArray(trace.expected_source_groups) ||
      !sameStringSet(trace.expected_source_groups.flat(), trace.expected_source_handles) ||
      trace.expected_source_groups.some((group) => !Array.isArray(group) || group.length === 0 ||
        !group.every((handle) => trace.expected_source_handles.includes(handle)) ||
        !group.some((handle) => trace.observed_source_handles.includes(handle))) ||
      !Array.isArray(trace.source_observations) ||
      trace.observed_source_handles.some((handle) =>
        trace.source_observations.filter((source) => source.handle === handle).length !== 1) ||
      trace.source_observations.some((source) => !trace.observed_source_handles.includes(source.handle)) ||
      trace.source_observations.some((source) =>
        !trace.observed_source_handles.includes(source.handle) || !validSha(source.revision) ||
        !validSha(source.source_hash) || !Number.isFinite(Date.parse(source.observed_at)) ||
        !["current", "historical", "as_of"].includes(source.currentness) ||
        source.inventory_hash !== trace.execution.stage_source_inventory_hash ||
        !inventoryContainsSourceObservation(executionInventory, source, trace.execution.generation_id,
          observedResults, verificationRoot) ||
        (topBound && !inventoryContainsSourceObservation(finalInventory, source, trace.execution.generation_id,
          observedResults, verificationRoot))) ||
      !allEvidenceRefsExist(verificationRoot, trace.extractor_attempt_refs) ||
      !allEvidenceRefsExist(verificationRoot, trace.embedding_receipt_refs) ||
      !allEvidenceRefsExist(verificationRoot, trace.owner_result_refs ?? []) ||
      !allEvidenceRefsExist(verificationRoot, trace.supporting_execution_refs ?? []) ||
      ((item.path === "public_app_btcc" || item.path === "native_tool") &&
        (queryRefs.length === 0 || !allEvidenceRefsExist(verificationRoot, queryRefs))) ||
      !Array.isArray(trace.completion_ids) || !Array.isArray(trace.projection_job_ids) || !Array.isArray(trace.native_result_ids) ||
      (item.path === "public_app_btcc" && (trace.completion_ids.length === 0 || trace.projection_job_ids.length === 0)) ||
      (item.path === "native_tool" && trace.native_result_ids.length === 0) ||
      (item.path === "owner_integration" && (trace.owner_result_refs?.length ?? 0) === 0) ||
      (item.path === "owner_integration" && trace.observed_source_handles.length > 0 && ownerSourceRefs.length === 0) ||
      (item.path === "owner_integration" && item.mr_ids.includes("MR-12") && trace.owner_route !== "production_transition") ||
      (item.uses_real_extractor && trace.extractor_attempt_refs.length === 0) ||
      (item.uses_real_embedding && trace.embedding_receipt_refs.length === 0))
      throw new Error("memory_acceptance_evidence_invalid");
  }
  for (let index = 1; index <= 12; index += 1) if (!coverage.has(`MR-${String(index).padStart(2, "0")}`))
    throw new Error("memory_acceptance_incomplete");
  if (!value.cases.some((item) => item.path === "public_app_btcc" && item.uses_real_extractor && item.mr_ids.includes("MR-03")) ||
    !value.cases.some((item) => item.path === "public_app_btcc" && item.uses_real_extractor && item.mr_ids.includes("MR-05")) ||
    !value.cases.some((item) => item.path === "native_tool" && item.mr_ids.includes("MR-09")) ||
    !value.cases.some((item) => item.uses_real_embedding && item.mr_ids.includes("MR-08")) ||
    !value.cases.some((item) => item.path === "owner_integration" && item.mr_ids.includes("MR-12")))
    throw new Error("memory_acceptance_incomplete");
  const performance = value.performance;
  if (performance.graph_samples !== 60 || performance.hybrid_samples !== 60 ||
    !Number.isFinite(performance.prepared_graph_p95_ms) || performance.prepared_graph_p95_ms > 500 ||
    !Number.isFinite(performance.prepared_hybrid_p95_ms) || performance.prepared_hybrid_p95_ms > 1_500 ||
    !safeVerificationRef(performance.report_ref) || !validSha(performance.report_sha256))
    throw new Error("memory_acceptance_performance_invalid");
  const report = readVerificationJson<MemoryRecoveryPerformanceReport>(verificationRoot, performance.report_ref, performance.report_sha256);
  const graph = report.samples?.filter((sample) => sample.mode === "graph") ?? [];
  const hybrid = report.samples?.filter((sample) => sample.mode === "hybrid") ?? [];
  const inventory = value.cases.length
    ? readVerificationJson<MemoryRecoveryCaseTrace>(verificationRoot, value.cases[0]!.trace_ref, value.cases[0]!.trace_sha256)
    : null;
  const inventoryValue = inventory
    ? readVerificationJson<MemorySourceInventoryLike>(verificationRoot, inventory.qualification_source_inventory_ref,
      inventory.qualification_source_inventory_sha256)
    : null;
  if (report.schema !== "butler.memory-recovery-performance.v1" ||
    report.execution?.generation_id !== value.verification_generation_id ||
    report.execution.implementation_commit !== value.implementation_commit ||
    report.execution.embedding_version !== value.embedding_version ||
    report.execution.qualification_source_inventory_hash !== value.verification_source_inventory_hash ||
    graph.length !== 60 || hybrid.length !== 60 || !inventoryValue ||
    report.samples.some((sample) => !validPerformanceSample(sample) ||
      !allEvidenceRefsExist(verificationRoot, [
        { ref: sample.result_ref, sha256: sample.result_sha256 },
        { ref: sample.metrics_ref, sha256: sample.metrics_sha256 },
      ]) || !validPerformanceArtifacts(sample, report.execution.generation_id,
        value.verification_source_inventory_hash, inventoryValue, verificationRoot)) ||
    !validTwelveByFive(graph) || !validTwelveByFive(hybrid) ||
    new Set(report.samples.map((sample) => sample.result_id)).size !== 120 ||
    !samePerformanceQueries(graph, hybrid) ||
    percentile95(graph.map((sample) => sample.elapsed_ms)) !== performance.prepared_graph_p95_ms ||
    percentile95(hybrid.map((sample) => sample.elapsed_ms)) !== performance.prepared_hybrid_p95_ms ||
    !validContentionEvidence(report.contention, verificationRoot,
      new Set(report.samples.map((sample) => sample.query_id))))
    throw new Error("memory_acceptance_performance_invalid");
}

type MemorySourceInventoryLike = {
  schema: string; origin?: { version?: string | null }; exclusions?: unknown;
  entries?: Array<{ episodeId?: string; revision?: string; sourceIds?: string[]; sourceHashes?: string[] }>;
  typed?: Array<{ revision?: string; source_ids?: string[]; content_hash?: string }>;
  typed_lifecycle?: unknown[]; history?: Array<{ source_ref?: string; revision?: string; source_hash?: string }>;
};

function allEvidenceRefsExist(root: string, refs: Array<{ ref: string; sha256: string }>): boolean {
  return Array.isArray(refs) && refs.every((item) => {
    if (!safeVerificationRef(item.ref) || !validSha(item.sha256)) return false;
    try { return createHash("sha256").update(readFileSync(join(root, item.ref))).digest("hex") === item.sha256; }
    catch { return false; }
  });
}

function inventoryContainsSourceObservation(
  inventory: MemorySourceInventoryLike,
  source: MemoryRecoveryCaseTrace["source_observations"][number],
  generationId: string,
  results: Array<MemoryQueryResultEvidence | MemoryOwnerResultEvidence>,
  verificationRoot: string,
): boolean {
  let binding: MemorySourceBindingEvidence;
  let readEvidence: MemorySourceReadEvidence;
  try { binding = readVerificationJson<MemorySourceBindingEvidence>(verificationRoot, source.binding_ref, source.binding_sha256); }
  catch { return false; }
  try { readEvidence = readVerificationJson<MemorySourceReadEvidence>(verificationRoot,
    binding.read_result_ref, binding.read_result_sha256); }
  catch { return false; }
  if (binding.schema !== "butler.memory-source-binding-evidence.v1" || binding.handle !== source.handle ||
    binding.generation_id !== generationId || binding.inventory_hash !== source.inventory_hash ||
    binding.revision !== source.revision || binding.source_hash !== source.source_hash ||
    binding.observed_at !== source.observed_at || binding.currentness !== source.currentness ||
    !results.some((result) => result.result_id === binding.returned_in_result_id && bindingReturnedByResult(binding, result)) ||
    !safeVerificationRef(binding.read_result_ref) ||
    !validSha(binding.read_result_sha256) ||
    !allEvidenceRefsExist(verificationRoot, [{ ref: binding.read_result_ref, sha256: binding.read_result_sha256 }])) return false;
  if (source.identity.kind === "memory_source" && binding.source_row?.source_id !== source.identity.source_id) return false;
  if (source.identity.kind === "conversation_source" && (!binding.canonical ||
    binding.canonical.message_id !== source.identity.message_id || binding.canonical.part_id !== source.identity.part_id ||
    binding.canonical.scalar_pointer !== source.identity.scalar_pointer)) return false;
  return validSourceReadEvidence(binding, readEvidence) &&
    sourceBindingBelongsToInventory(binding, inventory, generationId);
}

function validSourceReadEvidence(binding: MemorySourceBindingEvidence, evidence: MemorySourceReadEvidence): boolean {
  const row = binding.source_row;
  const canonical = evidence.canonical;
  if (!row || !binding.handle ||
    (binding.observation_kind === "source_ref" && binding.handle !== binding.returned_source_ref) ||
    evidence.schema !== "butler.memory-source-read-evidence.v1" ||
    evidence.result_id !== binding.returned_in_result_id || evidence.observation_kind !== binding.observation_kind ||
    evidence.source_ref !== binding.returned_source_ref || evidence.message_id !== binding.returned_message_id ||
    sourceRowIdentity(evidence.source_row) !== sourceRowIdentity(row) || !canonical ||
    canonical.revision !== binding.revision || canonical.sha256 !== binding.source_hash ||
    canonical.bytes !== Buffer.byteLength(canonical.text, "utf8") ||
    createHash("sha256").update(canonical.text).digest("hex") !== canonical.sha256 ||
    row.revision !== canonical.revision || row.content_hash !== canonical.sha256 ||
    row.conversation_message_id !== canonical.message_id || row.part_id !== canonical.part_id ||
    row.scalar_pointer !== canonical.scalar_pointer) return false;
  if (binding.canonical && (binding.canonical.message_id !== canonical.message_id ||
    binding.canonical.part_id !== canonical.part_id || binding.canonical.scalar_pointer !== canonical.scalar_pointer ||
    binding.canonical.scalar_hash !== canonical.sha256 || binding.canonical.revision !== canonical.revision)) return false;
  return row.byte_start >= 0 && row.byte_end <= canonical.bytes && row.byte_start < row.byte_end &&
    evidence.returned_text === canonical.text;
}

function sourceRowIdentity(row: NonNullable<MemorySourceBindingEvidence["source_row"]>): string {
  return JSON.stringify([row.source_id, row.episode_id, row.revision, row.content_hash,
    row.conversation_session_id, row.conversation_message_id, row.part_id, row.scalar_pointer,
    row.byte_start, row.byte_end, row.observed_at, row.conversation_start, row.conversation_end, row.project_id]);
}

function bindingReturnedByResult(
  binding: MemorySourceBindingEvidence,
  result: MemoryQueryResultEvidence | MemoryOwnerResultEvidence,
): boolean {
  if (binding.observation_kind === "source_ref") return Boolean(binding.returned_source_ref &&
    binding.returned_message_id === null && result.source_handles.includes(binding.returned_source_ref) &&
    result.observations.some((item) => item.kind === "source_ref" && item.source_ref === binding.returned_source_ref));
  return Boolean(binding.observation_kind === "session_message" && binding.returned_source_ref === null &&
    binding.returned_message_id &&
    result.observations.some((item) => item.kind === "session_message" && item.message_id === binding.returned_message_id));
}

function sourceBindingBelongsToInventory(
  binding: MemorySourceBindingEvidence,
  inventory: MemorySourceInventoryLike,
  generationId: string,
  expectedInventoryHash = binding.inventory_hash,
): boolean {
  if (binding.schema !== "butler.memory-source-binding-evidence.v1" || binding.generation_id !== generationId ||
    binding.inventory_hash !== expectedInventoryHash || !validSha(binding.inventory_hash) ||
    !validSha(binding.revision) || !validSha(binding.source_hash) ||
    !Number.isFinite(Date.parse(binding.observed_at)) ||
    !["current", "historical", "as_of"].includes(binding.currentness)) return false;
  try {
    if (binding.observation_kind === "source_ref" && binding.returned_source_ref?.startsWith("memory-source:v2:")) {
      const parts = binding.returned_source_ref.split(":");
      if (parts.length !== 4 || Buffer.from(parts[2]!, "base64url").toString("utf8") !== generationId) return false;
      const sourceId = Buffer.from(parts[3]!, "base64url").toString("utf8");
      const row = binding.source_row;
      if (!row || row.source_id !== sourceId || row.revision !== binding.revision ||
        row.content_hash !== binding.source_hash || binding.chunk?.current_revision !== row.revision ||
        binding.chunk.status !== "active" || !row.episode_id || row.observed_at !== binding.observed_at ||
        !Number.isFinite(Date.parse(row.conversation_start)) || !Number.isFinite(Date.parse(row.conversation_end)) ||
        !Number.isInteger(row.byte_start) || !Number.isInteger(row.byte_end) ||
        row.byte_start < 0 || row.byte_end <= row.byte_start) return false;
      if (row.conversation_message_id && (!binding.canonical || binding.canonical.message_id !== row.conversation_message_id ||
        binding.canonical.part_id !== row.part_id || binding.canonical.scalar_pointer !== row.scalar_pointer ||
        binding.canonical.scalar_hash !== row.content_hash || binding.canonical.revision !== row.revision)) return false;
      if (inventoryContainsRawSourceFact(inventory, sourceId, row.revision, row.content_hash, row.episode_id)) return true;
      let childId = sourceId;
      let childStart = row.byte_start;
      let childEnd = row.byte_end;
      for (const ancestor of binding.split_ancestry ?? []) {
        if (!validSha(ancestor.revision) || !validSha(ancestor.content_hash) ||
          ancestor.episode_id !== row.episode_id || ancestor.revision !== row.revision ||
          ancestor.content_hash !== row.content_hash || ancestor.conversation_session_id !== row.conversation_session_id ||
          ancestor.conversation_message_id !== row.conversation_message_id || ancestor.part_id !== row.part_id ||
          ancestor.scalar_pointer !== row.scalar_pointer || !ancestor.child_source_ids.includes(childId) ||
          ancestor.byte_start > childStart || ancestor.byte_end < childEnd) return false;
        childId = ancestor.source_id;
        childStart = ancestor.byte_start;
        childEnd = ancestor.byte_end;
      }
      return childId !== sourceId &&
        inventoryContainsRawSourceFact(inventory, childId, row.revision, row.content_hash, row.episode_id);
    }
    if (binding.observation_kind === "source_ref" && binding.returned_source_ref?.startsWith("conversation-source:v2:")) {
      const parts = binding.returned_source_ref.split(":");
      const canonical = binding.canonical;
      if (parts.length !== 6 || parts[5] !== binding.source_hash || !canonical ||
        Buffer.from(parts[2]!, "base64url").toString("utf8") !== canonical.message_id ||
        Buffer.from(parts[3]!, "base64url").toString("utf8") !== canonical.part_id ||
        Buffer.from(parts[4]!, "base64url").toString("utf8") !== canonical.scalar_pointer ||
        canonical.scalar_hash !== binding.source_hash || canonical.revision !== binding.revision) return false;
      const row = binding.source_row;
      return Boolean(row && row.revision === binding.revision && row.content_hash === binding.source_hash &&
        row.observed_at === binding.observed_at &&
        row.conversation_message_id === canonical.message_id && row.part_id === canonical.part_id &&
        row.scalar_pointer === canonical.scalar_pointer &&
        inventoryContainsRawSourceFact(inventory, row.source_id, row.revision, row.content_hash, row.episode_id));
    }
    if (binding.observation_kind === "session_message") {
      const canonical = binding.canonical;
      const row = binding.source_row;
      return Boolean(binding.returned_message_id && canonical && row &&
        binding.returned_message_id === canonical.message_id && canonical.revision === binding.revision &&
        canonical.scalar_hash === binding.source_hash && row.revision === canonical.revision &&
        row.content_hash === canonical.scalar_hash && row.observed_at === binding.observed_at &&
        row.conversation_message_id === canonical.message_id &&
        row.part_id === canonical.part_id && row.scalar_pointer === canonical.scalar_pointer &&
        inventoryContainsRawSourceFact(inventory, row.source_id, row.revision, row.content_hash, row.episode_id));
    }
  } catch { return false; }
  return false;
}

function inventoryContainsRawSourceFact(
  inventory: MemorySourceInventoryLike,
  sourceId: string,
  revision: string,
  sourceHash: string,
  episodeId: string,
): boolean {
  return (inventory.entries ?? []).some((entry) => entry.episodeId === episodeId && entry.revision === revision && entry.sourceIds?.includes(sourceId) &&
      entry.sourceHashes?.includes(sourceHash)) ||
    (inventory.typed ?? []).some((entry) => entry.revision === revision && entry.source_ids?.includes(sourceId) &&
      entry.content_hash === sourceHash) ||
    (inventory.history ?? []).some((entry) => entry.source_ref === sourceId && entry.revision === revision &&
      entry.source_hash === sourceHash);
}

function validPerformanceSample(
  sample: MemoryRecoveryPerformanceReport["samples"][number],
): boolean {
  return Boolean(sample.query_id && Number.isInteger(sample.repetition) && sample.repetition >= 1 && sample.repetition <= 5 &&
    sample.result_id && validSha(sample.query_hash) && safeVerificationRef(sample.result_ref) && validSha(sample.result_sha256) &&
    safeVerificationRef(sample.metrics_ref) && validSha(sample.metrics_sha256) && ["ok", "partial"].includes(sample.status) &&
    Number.isFinite(sample.elapsed_ms) && sample.elapsed_ms >= 0 && sample.coverage_ok === true &&
    Array.isArray(sample.expected_source_groups) && sample.expected_source_groups.length > 0 &&
    sample.expected_source_groups.every((group) => Array.isArray(group) && group.length > 0) &&
    Array.isArray(sample.observed_source_handles) && sample.source_binding_refs.length > 0 &&
    sample.expected_source_groups.every((group) => group.some((handle) => sample.observed_source_handles.includes(handle))));
}

function validTwelveByFive(samples: MemoryRecoveryPerformanceReport["samples"]): boolean {
  const byQuery = new Map<string, Set<number>>();
  for (const sample of samples) {
    const values = byQuery.get(sample.query_id) ?? new Set<number>();
    values.add(sample.repetition);
    byQuery.set(sample.query_id, values);
  }
  return byQuery.size === 12 && [...byQuery.values()].every((values) => values.size === 5 && [1, 2, 3, 4, 5].every((value) => values.has(value)));
}

function validPerformanceArtifacts(
  sample: MemoryRecoveryPerformanceReport["samples"][number],
  generationId: string,
  inventoryHash: string,
  inventory: MemorySourceInventoryLike,
  root: string,
): boolean {
  try {
    const result = readVerificationJson<MemoryQueryResultEvidence>(root, sample.result_ref, sample.result_sha256);
    const metrics = readVerificationJson<MemoryPerformanceMetricsEvidence>(root, sample.metrics_ref, sample.metrics_sha256);
    const bindings = sample.source_binding_refs.map((ref) =>
      readVerificationJson<MemorySourceBindingEvidence>(root, ref.ref, ref.sha256));
    const readEvidence = new Map(bindings.map((binding) => [binding.handle,
      readVerificationJson<MemorySourceReadEvidence>(root, binding.read_result_ref, binding.read_result_sha256)]));
    return result.schema === "butler.memory-query-result-evidence.v1" && result.generation_id === generationId &&
      result.result_id === sample.result_id && result.query_hash === sample.query_hash && result.status === sample.status &&
      sameStringSet(result.source_handles, sample.observed_source_handles) &&
      metrics.schema === "butler.memory-performance-metrics-evidence.v1" && metrics.mode === sample.mode &&
      metrics.query_id === sample.query_id && metrics.repetition === sample.repetition &&
      metrics.result_id === sample.result_id && metrics.query_hash === sample.query_hash &&
      metrics.status === sample.status && metrics.elapsed_ms === sample.elapsed_ms &&
      sample.observed_source_handles.every((handle) =>
        bindings.filter((binding) => binding.handle === handle && binding.returned_in_result_id === sample.result_id &&
          bindingReturnedByResult(binding, result) &&
          validSourceReadEvidence(binding, readEvidence.get(binding.handle)!) &&
          sourceBindingBelongsToInventory(binding, inventory, generationId, inventoryHash)).length === 1) &&
      bindings.every((binding) => sample.observed_source_handles.includes(binding.handle));
  } catch { return false; }
}

function samePerformanceQueries(
  graph: MemoryRecoveryPerformanceReport["samples"],
  hybrid: MemoryRecoveryPerformanceReport["samples"],
): boolean {
  const signatures = (values: MemoryRecoveryPerformanceReport["samples"]) => [...new Map(
    values.map((sample) => [sample.query_id, sample.query_hash]),
  ).entries()].sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(signatures(graph)) === JSON.stringify(signatures(hybrid)) &&
    [...graph, ...hybrid].every((sample) => [...graph, ...hybrid]
      .filter((candidate) => candidate.query_id === sample.query_id)
      .every((candidate) => candidate.query_hash === sample.query_hash));
}

function validContentionEvidence(
  value: MemoryRecoveryPerformanceReport["contention"],
  root: string,
  preparedQueryIds: Set<string>,
): boolean {
  if (!value || value.overlapped !== true || new Set(value.source_window_ids).size !== 4 ||
    !sameStringSet(value.query_intervals.map((query) => query.query_id), [...preparedQueryIds]) ||
    value.query_intervals.some((query) => !query.query_id || !Number.isFinite(Date.parse(query.started_at)) ||
      !preparedQueryIds.has(query.query_id) || !Number.isFinite(Date.parse(query.ended_at)) ||
      Date.parse(query.started_at) >= Date.parse(query.ended_at)) ||
    value.queue_work_refs.some((work) => !work.result_id || !Number.isFinite(Date.parse(work.started_at)) ||
      !Number.isFinite(Date.parse(work.ended_at)) || Date.parse(work.started_at) >= Date.parse(work.ended_at) ||
      !Array.isArray(work.source_window_ids) || work.source_window_ids.length === 0) ||
    !sameStringSet(value.source_window_ids, value.queue_work_refs.flatMap((work) => work.source_window_ids)) ||
    !allEvidenceRefsExist(root, value.queue_work_refs.map(({ ref, sha256 }) => ({ ref, sha256 })))) return false;
  if (!value.queue_work_refs.every((work) => {
    try {
      const evidence = readVerificationJson<MemoryQueueWorkEvidence>(root, work.ref, work.sha256);
      return evidence.schema === "butler.memory-queue-work-evidence.v1" && evidence.result_id === work.result_id &&
        evidence.work_class === "background" &&
        evidence.started_at === work.started_at && evidence.ended_at === work.ended_at &&
        sameStringSet(evidence.source_window_ids, work.source_window_ids);
    } catch { return false; }
  })) return false;
  return value.query_intervals.some((query) => value.queue_work_refs.some((work) =>
    Date.parse(query.started_at) < Date.parse(work.ended_at) && Date.parse(work.started_at) < Date.parse(query.ended_at)));
}

function safeVerificationRef(value: string): boolean {
  return Boolean(value) && !value.startsWith("/") && !value.split(/[\\/]/u).includes("..");
}

function readVerificationJson<T>(root: string, ref: string, expected: string): T {
  const path = join(root, ref);
  const bytes = readFileSync(path);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error("memory_acceptance_evidence_changed");
  try { return JSON.parse(bytes.toString("utf8")) as T; }
  catch { throw new Error("memory_acceptance_evidence_invalid"); }
}

function sameStringSet(left: unknown, right: unknown): boolean {
  return Array.isArray(left) && Array.isArray(right) && left.every((item) => typeof item === "string") &&
    right.every((item) => typeof item === "string") &&
    JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
}

function percentile95(values: number[]): number {
  if (!values.every((value) => Number.isFinite(value) && value >= 0)) return Number.NaN;
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? Number.NaN;
}

function persistQualificationEvidence(
  butlerData: string,
  generationId: string,
  acceptancePath: string,
  verificationRoot: string,
  acceptance: MemoryRecoveryAcceptance,
): void {
  const root = join(cognitionMemoryRoot(butlerData), "generations", safeGenerationId(generationId), "qualification");
  writeBytesDurable(join(root, "acceptance.json"), readFileSync(acceptancePath));
  const refs = new Set<string>([acceptance.performance.report_ref]);
  for (const item of acceptance.cases) {
    refs.add(item.trace_ref);
    const trace = readVerificationJson<MemoryRecoveryCaseTrace>(verificationRoot, item.trace_ref, item.trace_sha256);
    refs.add(trace.qualification_source_inventory_ref);
    refs.add(trace.execution.source_inventory_ref);
    for (const source of trace.source_observations) {
      refs.add(source.binding_ref);
      const binding = readVerificationJson<MemorySourceBindingEvidence>(verificationRoot, source.binding_ref, source.binding_sha256);
      refs.add(binding.read_result_ref);
    }
    for (const evidence of [
      ...trace.extractor_attempt_refs,
      ...trace.embedding_receipt_refs,
      ...(trace.owner_result_refs ?? []),
      ...(trace.owner_source_result_refs ?? []),
      ...(trace.supporting_execution_refs ?? []),
      ...trace.query.result_refs,
    ])
      refs.add(evidence.ref);
  }
  const report = readVerificationJson<MemoryRecoveryPerformanceReport>(verificationRoot,
    acceptance.performance.report_ref, acceptance.performance.report_sha256);
  for (const evidence of report.contention.queue_work_refs) refs.add(evidence.ref);
  for (const sample of report.samples) {
    refs.add(sample.result_ref);
    refs.add(sample.metrics_ref);
    for (const ref of sample.source_binding_refs) {
      refs.add(ref.ref);
      const binding = readVerificationJson<MemorySourceBindingEvidence>(verificationRoot, ref.ref, ref.sha256);
      refs.add(binding.read_result_ref);
    }
  }
  for (const ref of refs) {
    if (!safeVerificationRef(ref)) throw new Error("memory_acceptance_invalid");
    writeBytesDurable(join(root, "evidence", ref), readFileSync(join(verificationRoot, ref)));
  }
}

function currentMemoryImplementationCommit(): string | null {
  const rootResult = Bun.spawnSync(["git", "-C", import.meta.dir, "rev-parse", "--show-toplevel"]);
  if (rootResult.exitCode !== 0) return null;
  const root = rootResult.stdout.toString().trim();
  const paths = [
    "packages/butler-agent/src/agent/cognition/memory",
    "packages/butler-agent/src/agent/cognition/continuity/hot-cache-writer.ts",
    "packages/butler-agent/src/agent/cognition/continuity/continuity-store.ts",
    "packages/butler-agent/src/agent/cognition/feedback/buffer.ts",
    "packages/butler-agent/src/agent/cognition/consolidation",
    "packages/butler-agent/src/personalization/profiling.ts",
    "packages/butler-agent/src/agent/work/task-store.ts",
    "packages/butler-agent/src/agent/work/planned-task.ts",
    "packages/butler-agent/src/agent/conversation",
    "packages/butler-agent/src/agent/context/conversation-context.ts",
    "packages/butler-agent/src/agent/context/conversation-session-reference.ts",
    "packages/butler-agent/src/agent/prompt/prompt-assembler.ts",
    "packages/butler-agent/src/agent/btcc",
    "packages/butler-agent/src/agent/adapters/btcc",
    "packages/butler-agent/src/gateways/core",
    "packages/butler-agent/src/agent/tools/memory",
    "packages/butler-agent/src/agent/tools/monitoring/get_memory_health",
    "packages/butler-agent/src/agent/tools/tool-result-serialization.ts",
    "packages/butler-agent/src/agent/tools/butler-tools.ts",
    "packages/butler-agent/src/interfaces/cli/operator-command.ts",
    "packages/butler-agent/src/integrations/providers",
    "tests/e2e/memory-recovery-multilingual-live-e2e.ts",
    "tests/unit/memory-recovery-t1.test.ts",
  ];
  const clean = Bun.spawnSync([
    "git", "-C", root, "status", "--porcelain=v1", "-z",
    "--untracked-files=all", "--", ...paths,
  ]);
  if (clean.exitCode !== 0 || clean.stdout.byteLength !== 0) return null;
  const head = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"]);
  const value = head.exitCode === 0 ? head.stdout.toString().trim() : "";
  return validGitCommit(value) ? value : null;
}

export async function activateMemoryGeneration(input: {
  butlerData: string; generationId: string; expectedActiveGeneration: string;
  expectedInventoryHash: string; expectedReadinessHash: string;
  assertCurrentInventory: () => void;
}, prepared: PreparedMemoryGenerationActivation, lease: ConsolidationLease): Promise<ActiveMemoryGeneration> {
  assertConsolidationLease(consolidationLockPath(input.butlerData), lease);
  const current = readActiveDescriptor(input.butlerData);
  if (current.generation_id !== input.expectedActiveGeneration) throw new Error("memory_generation_changed");
  const manifest = readMemoryGenerationManifest(input.butlerData, input.generationId);
  const implementationCommit = currentMemoryImplementationCommit();
  const generationRoot = join(cognitionMemoryRoot(input.butlerData), "generations", input.generationId);
  const acceptanceBinding = manifest.acceptance_binding;
  const storedAcceptancePath = acceptanceBinding && safeVerificationRef(acceptanceBinding.qualification_ref)
    ? join(generationRoot, acceptanceBinding.qualification_ref)
    : null;
  const storedEvidenceRoot = acceptanceBinding && safeVerificationRef(acceptanceBinding.verification_root_ref)
    ? join(generationRoot, acceptanceBinding.verification_root_ref)
    : null;
  await prepared.candidateWitness.assertCurrent();
  prepared.qualificationWitness.assertCurrent();
  input.assertCurrentInventory();
  const candidatePreimageSha = prepared.candidateWitness.sha256;
  const manifestSha = generationManifestSha(input.butlerData, input.generationId);
  if (manifest.state !== "ready" || !manifest.required_acceptance_passed ||
    prepared.readiness.sha256 !== input.expectedReadinessHash || manifestSha !== prepared.manifestSha ||
    manifest.source_inventory_hash !== input.expectedInventoryHash ||
    manifest.readiness?.sha256 !== input.expectedReadinessHash || !manifest.readiness.ready ||
    manifest.acceptance_binding?.target_generation_id !== input.generationId ||
    manifest.acceptance_binding.target_source_inventory_hash !== input.expectedInventoryHash ||
    manifest.acceptance_binding.target_readiness_sha256 !== input.expectedReadinessHash ||
    candidatePreimageSha !== prepared.candidatePreimageSha ||
    manifest.acceptance_binding.target_evidence_sha256 !== prepared.readiness.evidence_sha256 ||
    !implementationCommit || prepared.implementationCommit !== implementationCommit ||
    manifest.acceptance_binding.implementation_commit !== implementationCommit ||
    !["memory-extract-v2", MEMORY_EXTRACTION_VERSION].includes(manifest.extraction_version ?? "") || !manifest.embedding?.version ||
    !storedAcceptancePath || !storedEvidenceRoot ||
    manifest.acceptance_binding.qualification_sha256 !== prepared.qualificationSha)
    throw new Error("activation_requires_catchup");
  const descriptor: ActiveMemoryGeneration = {
    schema: "butler.memory-active-generation.v2", generation_id: input.generationId,
    previous_generation_id: current.generation_id, activated_at: new Date().toISOString(), projection_mode: "running",
  };
  const transitioned = commitMemoryDescriptorTransition({
    butlerData: input.butlerData,
    expectedDescriptor: current,
    targetGenerationId: input.generationId,
    expectedTargetManifestSha256: manifestSha,
    nextDescriptor: descriptor,
  }, lease);
  writeJsonDurable(join(cognitionMemoryRoot(input.butlerData), "generations", input.generationId, "manifest.json"), { ...manifest, state: "active" });
  const previousManifest = readMemoryGenerationManifest(input.butlerData, current.generation_id);
  writeJsonDurable(join(cognitionMemoryRoot(input.butlerData), "generations", current.generation_id, "manifest.json"), { ...previousManifest, state: "retired" });
  return transitioned;
}

export async function rollbackMemoryGeneration(input: {
  butlerData: string; expectedActiveGeneration: string;
  sourceInventoryHash: string;
  sourceCount: number;
  assertCurrentInventory: () => void;
}, prepared: PreparedMemoryGenerationQualificationReuse | null,
candidateWitness: MemoryGenerationCandidateWitness | null,
lease: ConsolidationLease): Promise<ActiveMemoryGeneration> {
  assertConsolidationLease(consolidationLockPath(input.butlerData), lease);
  const current = readActiveDescriptor(input.butlerData);
  if (current.generation_id !== input.expectedActiveGeneration || !current.previous_generation_id)
    throw new Error("memory_rollback_unavailable");
  const previous = readMemoryGenerationManifest(input.butlerData, current.previous_generation_id);
  input.assertCurrentInventory();
  if (previous.format === "v2") {
    if (!candidateWitness) throw new Error("memory_rollback_requires_catchup");
    await candidateWitness.assertCurrent();
    input.assertCurrentInventory();
    const implementationCommit = currentMemoryImplementationCommit();
    const binding = previous.acceptance_binding;
    const generationRoot = join(cognitionMemoryRoot(input.butlerData), "generations", previous.generation_id);
    const acceptancePath = binding && safeVerificationRef(binding.qualification_ref)
      ? join(generationRoot, binding.qualification_ref)
      : null;
    const verificationRoot = binding && safeVerificationRef(binding.verification_root_ref)
      ? join(generationRoot, binding.verification_root_ref)
      : null;
    const readiness = previous.readiness;
    const bootstrap = previous.initialization_origin === "empty" && previous.schema_version === 3 &&
      ["memory-extract-v2", MEMORY_EXTRACTION_VERSION].includes(previous.extraction_version ?? "") && !previous.required_acceptance_passed && !binding;
    const qualified = Boolean(prepared && binding && input.sourceInventoryHash === previous.source_inventory_hash && readiness &&
      readiness.unaccounted === 0 && readiness.semantic.failed === 0 && readiness.vectors.failed === 0 &&
      readiness.cache.failed === 0 && generationManifestSha(input.butlerData, previous.generation_id) === prepared?.manifestSha &&
      implementationCommit && prepared?.implementationCommit === implementationCommit &&
      binding?.implementation_commit === implementationCommit && binding?.qualification_sha256 === prepared?.qualificationSha &&
      acceptancePath && verificationRoot);
    prepared?.qualificationWitness.assertCurrent();
    if (!bootstrap && !qualified)
      throw new Error("memory_rollback_requires_catchup");
  }
  const descriptor: ActiveMemoryGeneration = {
    schema: "butler.memory-active-generation.v2", generation_id: previous.generation_id,
    previous_generation_id: current.generation_id, activated_at: new Date().toISOString(),
    projection_mode: previous.format === "v2" ? "running" : "paused",
  };
  const transitioned = commitMemoryDescriptorTransition({
    butlerData: input.butlerData,
    expectedDescriptor: current,
    targetGenerationId: previous.generation_id,
    expectedTargetManifestSha256: generationManifestSha(input.butlerData, previous.generation_id),
    nextDescriptor: descriptor,
  }, lease);
  writeJsonDurable(join(cognitionMemoryRoot(input.butlerData), "generations", previous.generation_id, "manifest.json"), { ...previous, state: "active" });
  const retired = readMemoryGenerationManifest(input.butlerData, current.generation_id);
  writeJsonDurable(join(cognitionMemoryRoot(input.butlerData), "generations", current.generation_id, "manifest.json"), { ...retired, state: "retired" });
  return transitioned;
}

/** Internal production cutover primitive. Callers must hold the memory writer gate. */
export function commitMemoryDescriptorTransition(input: {
  butlerData: string;
  expectedDescriptor: ActiveMemoryGeneration;
  targetGenerationId: string;
  expectedTargetManifestSha256: string;
  nextDescriptor: ActiveMemoryGeneration;
}, lease: ConsolidationLease): ActiveMemoryGeneration {
  assertConsolidationLease(consolidationLockPath(input.butlerData), lease);
  if (lease.purpose !== "cutover") throw new Error("memory_generation_changed");
  const current = readActiveDescriptor(input.butlerData);
  if (JSON.stringify(current) !== JSON.stringify(input.expectedDescriptor) ||
    input.nextDescriptor.generation_id !== input.targetGenerationId ||
    generationManifestSha(input.butlerData, input.targetGenerationId) !== input.expectedTargetManifestSha256)
    throw new Error("memory_generation_changed");
  writeJsonDurable(activeMemoryDescriptorPath(input.butlerData), input.nextDescriptor);
  return input.nextDescriptor;
}

function generationManifestSha(butlerData: string, generationId: string): string {
  const path = join(cognitionMemoryRoot(butlerData), "generations", safeGenerationId(generationId), "manifest.json");
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertTrulyEmpty(butlerData: string): void {
  const memoryRoot = cognitionMemoryRoot(butlerData);
  if (existsSync(activeMemoryDescriptorPath(butlerData)))
    throw new Error("memory_initialization_requires_rebuild");
  if (directoryHasEntries(join(memoryRoot, "generations")))
    throw new Error("memory_initialization_requires_rebuild");
  const store = new AgentConversationStore({ butlerData });
  try {
    if (store.countSourceBearingMessages() > 0)
      throw new Error("memory_initialization_requires_rebuild");
  } finally {
    store.close();
  }
  if (
    new TaskStore(butlerData).taskIds().length > 0 ||
    listFeedbackEntries(butlerData).length > 0 ||
    listBoxManifests(butlerData).length > 0
  ) {
    throw new Error("memory_initialization_requires_rebuild");
  }
  if (
    directoryHasSourceFiles(join(butlerData, "tasks")) ||
    directoryHasSourceFiles(cognitionBoxRoot(butlerData))
  ) {
    throw new Error("memory_initialization_requires_rebuild");
  }
  const rules = join(memoryRoot, "rules");
  if (directoryHasSourceFiles(rules)) {
    throw new Error("memory_initialization_requires_rebuild");
  }
  for (const path of [
    join(memoryRoot, "db", "graph.sqlite"),
    join(memoryRoot, "metadata.sqlite"),
  ]) {
    if (sqliteHasRows(path))
      throw new Error("memory_initialization_requires_rebuild");
  }
  for (const path of [
    join(memoryRoot, "db", "butler.lance"),
    join(memoryRoot, "hot"),
  ]) {
    if (directoryHasEntries(path))
      throw new Error("memory_initialization_requires_rebuild");
  }
}

function sqliteHasRows(path: string): boolean {
  if (!existsSync(path)) return false;
  const db = new Database(path, { readonly: true });
  try {
    const metadataTables = new Set([
      "memory_state",
      "schema_migrations",
      "migrations",
    ]);
    const contentTables = [
      "memory_chunks",
      "memory_chunk_sources",
      "memory_nodes",
      "entities", // Detect old content before bootstrap; never treat an old DB as empty.
      "edges",
      "memory_evidence",
      "memory_projection_jobs",
      "memory_projection_windows",
    ];
    const existing = new Set(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all()
        .map(({ name }) => name),
    );
    if (
      contentTables.some(
        (name) =>
          existing.has(name) &&
          Number(
            db
              .query<
                { count: number },
                []
              >(`SELECT COUNT(*) count FROM "${name}"`)
              .get()?.count ?? 0,
          ) > 0,
      )
    )
      return true;
    return [...existing].some((name) => {
      if (metadataTables.has(name)) return false;
      const safeName = name.replaceAll('"', '""');
      return (
        Number(
          db
            .query<
              { count: number },
              []
            >(`SELECT COUNT(*) count FROM "${safeName}"`)
            .get()?.count ?? 0,
        ) > 0
      );
    });
  } finally {
    db.close();
  }
}

function directoryHasSourceFiles(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const info = statSync(path);
    if (!info.isDirectory()) return info.size > 0;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory() && directoryHasSourceFiles(child)) return true;
      if (entry.isFile() && statSync(child).size > 0) return true;
      if (!entry.isDirectory() && !entry.isFile()) {
        throw new Error("memory_initialization_source_unreadable");
      }
    }
    return false;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "memory_initialization_source_unreadable"
    ) {
      throw error;
    }
    throw new Error("memory_initialization_source_unreadable", { cause: error });
  }
}

function directoryHasEntries(path: string): boolean {
  if (!existsSync(path)) return false;
  if (!statSync(path).isDirectory())
    throw new Error("memory_initialization_source_unreadable");
  return readdirSync(path).length > 0;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("memory_generation_unavailable");
  }
}

function writeJsonDurable(path: string, value: unknown): void {
  writeBytesDurable(path, Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
}

function writeBytesDurable(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, bytes, { mode: 0o600 });
    const file = openSync(temp, "r");
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temp, path);
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    rmSync(temp, { force: true });
  }
}

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function safeGenerationId(value: string): string {
  if (!/^[0-9a-f-]{36}$/u.test(value))
    throw new Error("memory_generation_version_unsupported");
  return value;
}

function requiredRuntimeVersion(name: "unicode" | "icu"): string {
  const value = process.versions[name];
  if (!value) throw new Error(`memory_${name}_version_unavailable`);
  return value;
}
