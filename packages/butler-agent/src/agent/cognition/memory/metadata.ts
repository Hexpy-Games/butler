import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { Database } from "bun:sqlite";
import { cognitionMemoryRoot } from "../paths.ts";
import { readBoxManifest } from "../box/store.ts";
import { readFeedbackEntry } from "../feedback/buffer.ts";

export const MEMORY_METADATA_SCHEMA_VERSION = "butler.cognition.memory-metadata.v1";

export type MemoryChunkStatus = "active" | "needs_review" | "superseded" | "forgotten";
export type MemoryPrivacyClass = "public" | "private" | "sensitive" | "secret";
export type MemoryFreshnessClass = "unknown" | "current" | "stale" | "historical";

export type MemoryChunk = {
  memory_chunk_id: string;
  schema_version: typeof MEMORY_METADATA_SCHEMA_VERSION;
  status: MemoryChunkStatus;
  scope: string;
  project_id: string | null;
  summary: string;
  text_ref: string | null;
  text_hash: string | null;
  privacy_class: MemoryPrivacyClass;
  freshness_class: MemoryFreshnessClass;
  source: string;
  created_at: string;
  updated_at: string;
  consolidated_at: string | null;
  consolidation_run_id: string | null;
  superseded_by: string | null;
};

export type MemoryOriginRef = {
  ref_type: string;
  ref_id: string;
};

export type MemoryBoxRef = {
  box_item_id: string;
  relation: string;
};

export type MemoryFeedbackRef = {
  feedback_id: string;
  relation: string;
};

export type MemoryGraphRef = {
  graph_ref_type: string;
  graph_ref_id: string;
  relation: string;
};

export type MemoryVectorRef = {
  vector_store: string;
  vector_table: string;
  vector_row_id: string;
  embedding_model: string;
  embedding_dimension: number | null;
  indexed_at: string;
};

export type CreateMemoryChunkInput = {
  memoryChunkId?: string;
  status?: MemoryChunkStatus;
  scope: string;
  projectId?: string | null;
  summary: string;
  textRef?: string | null;
  text?: string | null;
  privacyClass?: MemoryPrivacyClass;
  freshnessClass?: MemoryFreshnessClass;
  source: string;
  consolidatedAt?: string | null;
  consolidationRunId?: string | null;
  supersededBy?: string | null;
  origins?: MemoryOriginRef[];
  boxRefs?: MemoryBoxRef[];
  feedbackRefs?: MemoryFeedbackRef[];
  graphRefs?: MemoryGraphRef[];
  vectorRefs?: Array<Omit<MemoryVectorRef, "indexed_at"> & { indexed_at?: string }>;
  now?: Date;
};

export type MemoryChunkWithRefs = MemoryChunk & {
  origins: MemoryOriginRef[];
  box_refs: MemoryBoxRef[];
  feedback_refs: MemoryFeedbackRef[];
  graph_refs: MemoryGraphRef[];
  vector_refs: MemoryVectorRef[];
};

export type MemoryMetadataIntegrityReport = {
  schema: "butler.cognition.memory-metadata.integrity.v1";
  checked_at: string;
  chunk_count: number;
  missing_box_refs: Array<{ memory_chunk_id: string; box_item_id: string }>;
  missing_feedback_refs: Array<{ memory_chunk_id: string; feedback_id: string }>;
};

export type MemoryMetadataRepairReport = MemoryMetadataIntegrityReport & {
  repaired_box_refs: number;
  repaired_feedback_refs: number;
};

function iso(date: Date = new Date()): string {
  return date.toISOString();
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function hashText(text: string | null | undefined): string | null {
  return text ? createHash("sha256").update(text).digest("hex") : null;
}

export function memoryChunkId(): string {
  return `mem_${randomUUID()}`;
}

export function memoryMetadataPath(butlerData: string): string {
  return join(cognitionMemoryRoot(butlerData), "metadata.sqlite");
}

export function openMemoryMetadataDb(butlerData: string, options: { readonly?: boolean } = {}): Database {
  const path = memoryMetadataPath(butlerData);
  if (!options.readonly) ensureDir(dirname(path));
  const db = new Database(path, options.readonly ? { readonly: true } : { create: true });
  if (!options.readonly) ensureMemoryMetadataSchema(db);
  return db;
}

export function ensureMemoryMetadataSchema(db: Database): void {
  db.run("PRAGMA foreign_keys = ON");
  db.run(`
    CREATE TABLE IF NOT EXISTS memory_chunks (
      memory_chunk_id TEXT PRIMARY KEY,
      schema_version TEXT NOT NULL,
      status TEXT NOT NULL,
      scope TEXT NOT NULL,
      project_id TEXT,
      summary TEXT NOT NULL,
      text_ref TEXT,
      text_hash TEXT,
      privacy_class TEXT NOT NULL,
      freshness_class TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      consolidated_at TEXT,
      consolidation_run_id TEXT,
      superseded_by TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS memory_chunk_origins (
      memory_chunk_id TEXT NOT NULL REFERENCES memory_chunks(memory_chunk_id),
      ref_type TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      PRIMARY KEY (memory_chunk_id, ref_type, ref_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS memory_chunk_box_refs (
      memory_chunk_id TEXT NOT NULL REFERENCES memory_chunks(memory_chunk_id),
      box_item_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      PRIMARY KEY (memory_chunk_id, box_item_id, relation)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS memory_chunk_feedback_refs (
      memory_chunk_id TEXT NOT NULL REFERENCES memory_chunks(memory_chunk_id),
      feedback_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      PRIMARY KEY (memory_chunk_id, feedback_id, relation)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS memory_chunk_graph_refs (
      memory_chunk_id TEXT NOT NULL REFERENCES memory_chunks(memory_chunk_id),
      graph_ref_type TEXT NOT NULL,
      graph_ref_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      PRIMARY KEY (memory_chunk_id, graph_ref_type, graph_ref_id, relation)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS memory_chunk_vector_refs (
      memory_chunk_id TEXT NOT NULL REFERENCES memory_chunks(memory_chunk_id),
      vector_store TEXT NOT NULL,
      vector_table TEXT NOT NULL,
      vector_row_id TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      embedding_dimension INTEGER,
      indexed_at TEXT NOT NULL,
      PRIMARY KEY (memory_chunk_id, vector_store, vector_table, vector_row_id)
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_memory_chunks_project ON memory_chunks(project_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_memory_chunks_status ON memory_chunks(status)");
  db.run("CREATE INDEX IF NOT EXISTS idx_memory_chunks_consolidation ON memory_chunks(consolidation_run_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_memory_chunk_origins_ref ON memory_chunk_origins(ref_type, ref_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_memory_chunk_box_refs_box ON memory_chunk_box_refs(box_item_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_memory_chunk_feedback_refs_feedback ON memory_chunk_feedback_refs(feedback_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_memory_chunk_graph_refs_ref ON memory_chunk_graph_refs(graph_ref_type, graph_ref_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_memory_chunk_vector_refs_row ON memory_chunk_vector_refs(vector_store, vector_table, vector_row_id)");
}

export function createMemoryChunk(butlerData: string, input: CreateMemoryChunkInput): MemoryChunkWithRefs {
  const db = openMemoryMetadataDb(butlerData);
  try {
    const now = iso(input.now);
    const chunk: MemoryChunk = {
      memory_chunk_id: input.memoryChunkId ?? memoryChunkId(),
      schema_version: MEMORY_METADATA_SCHEMA_VERSION,
      status: input.status ?? "active",
      scope: input.scope,
      project_id: input.projectId ?? null,
      summary: input.summary,
      text_ref: input.textRef ?? null,
      text_hash: hashText(input.text),
      privacy_class: input.privacyClass ?? "private",
      freshness_class: input.freshnessClass ?? "unknown",
      source: input.source,
      created_at: now,
      updated_at: now,
      consolidated_at: input.consolidatedAt ?? null,
      consolidation_run_id: input.consolidationRunId ?? null,
      superseded_by: input.supersededBy ?? null,
    };
    const insertAll = db.transaction(() => {
      db.query(`
        INSERT INTO memory_chunks (
          memory_chunk_id, schema_version, status, scope, project_id, summary, text_ref, text_hash,
          privacy_class, freshness_class, source, created_at, updated_at, consolidated_at,
          consolidation_run_id, superseded_by
        )
        VALUES ($memory_chunk_id, $schema_version, $status, $scope, $project_id, $summary, $text_ref, $text_hash,
          $privacy_class, $freshness_class, $source, $created_at, $updated_at, $consolidated_at,
          $consolidation_run_id, $superseded_by)
      `).run(toChunkParams(chunk));
      for (const origin of input.origins ?? []) linkMemoryChunkOriginDb(db, chunk.memory_chunk_id, origin);
      for (const ref of input.boxRefs ?? []) linkMemoryChunkBoxDb(db, chunk.memory_chunk_id, ref);
      for (const ref of input.feedbackRefs ?? []) linkMemoryChunkFeedbackDb(db, chunk.memory_chunk_id, ref);
      for (const ref of input.graphRefs ?? []) linkMemoryChunkGraphDb(db, chunk.memory_chunk_id, ref);
      for (const ref of input.vectorRefs ?? []) {
        linkMemoryChunkVectorDb(db, chunk.memory_chunk_id, {
          ...ref,
          indexed_at: ref.indexed_at ?? now,
        });
      }
    });
    insertAll();
    return readMemoryChunkWithRefs(butlerData, chunk.memory_chunk_id) ?? {
      ...chunk,
      origins: [],
      box_refs: [],
      feedback_refs: [],
      graph_refs: [],
      vector_refs: [],
    };
  } finally {
    db.close();
  }
}

export function readMemoryChunkWithRefs(butlerData: string, memoryChunkId: string): MemoryChunkWithRefs | null {
  if (!existsSync(memoryMetadataPath(butlerData))) return null;
  const db = openMemoryMetadataDb(butlerData, { readonly: true });
  try {
    const chunk = db.query("SELECT * FROM memory_chunks WHERE memory_chunk_id = ?").get(memoryChunkId) as MemoryChunk | null;
    if (!chunk) return null;
    return {
      ...chunk,
      origins: db.query("SELECT ref_type, ref_id FROM memory_chunk_origins WHERE memory_chunk_id = ? ORDER BY ref_type, ref_id").all(memoryChunkId) as MemoryOriginRef[],
      box_refs: db.query("SELECT box_item_id, relation FROM memory_chunk_box_refs WHERE memory_chunk_id = ? ORDER BY box_item_id, relation").all(memoryChunkId) as MemoryBoxRef[],
      feedback_refs: db.query("SELECT feedback_id, relation FROM memory_chunk_feedback_refs WHERE memory_chunk_id = ? ORDER BY feedback_id, relation").all(memoryChunkId) as MemoryFeedbackRef[],
      graph_refs: db.query("SELECT graph_ref_type, graph_ref_id, relation FROM memory_chunk_graph_refs WHERE memory_chunk_id = ? ORDER BY graph_ref_type, graph_ref_id, relation").all(memoryChunkId) as MemoryGraphRef[],
      vector_refs: db.query("SELECT vector_store, vector_table, vector_row_id, embedding_model, embedding_dimension, indexed_at FROM memory_chunk_vector_refs WHERE memory_chunk_id = ? ORDER BY vector_store, vector_table, vector_row_id").all(memoryChunkId) as MemoryVectorRef[],
    };
  } finally {
    db.close();
  }
}

export function listMemoryChunks(butlerData: string, limit = 100): MemoryChunk[] {
  if (!existsSync(memoryMetadataPath(butlerData))) return [];
  const db = openMemoryMetadataDb(butlerData, { readonly: true });
  try {
    return db.query("SELECT * FROM memory_chunks ORDER BY updated_at DESC, memory_chunk_id DESC LIMIT $limit").all({ $limit: limit }) as MemoryChunk[];
  } finally {
    db.close();
  }
}

export function linkMemoryChunkOrigin(butlerData: string, memoryChunkId: string, ref: MemoryOriginRef): void {
  const db = openMemoryMetadataDb(butlerData);
  try {
    linkMemoryChunkOriginDb(db, memoryChunkId, ref);
  } finally {
    db.close();
  }
}

export function linkMemoryChunkBox(butlerData: string, memoryChunkId: string, ref: MemoryBoxRef): void {
  const db = openMemoryMetadataDb(butlerData);
  try {
    linkMemoryChunkBoxDb(db, memoryChunkId, ref);
  } finally {
    db.close();
  }
}

export function linkMemoryChunkFeedback(butlerData: string, memoryChunkId: string, ref: MemoryFeedbackRef): void {
  const db = openMemoryMetadataDb(butlerData);
  try {
    linkMemoryChunkFeedbackDb(db, memoryChunkId, ref);
  } finally {
    db.close();
  }
}

export function linkMemoryChunkGraph(butlerData: string, memoryChunkId: string, ref: MemoryGraphRef): void {
  const db = openMemoryMetadataDb(butlerData);
  try {
    linkMemoryChunkGraphDb(db, memoryChunkId, ref);
  } finally {
    db.close();
  }
}

export function linkMemoryChunkVector(butlerData: string, memoryChunkId: string, ref: MemoryVectorRef): void {
  const db = openMemoryMetadataDb(butlerData);
  try {
    linkMemoryChunkVectorDb(db, memoryChunkId, ref);
  } finally {
    db.close();
  }
}

export function checkMemoryMetadataIntegrity(butlerData: string): MemoryMetadataIntegrityReport {
  const chunks = listMemoryChunks(butlerData, 10_000);
  const missingBoxRefs: MemoryMetadataIntegrityReport["missing_box_refs"] = [];
  const missingFeedbackRefs: MemoryMetadataIntegrityReport["missing_feedback_refs"] = [];
  for (const chunk of chunks) {
    const withRefs = readMemoryChunkWithRefs(butlerData, chunk.memory_chunk_id);
    for (const ref of withRefs?.box_refs ?? []) {
      if (!readBoxManifest(butlerData, ref.box_item_id)) missingBoxRefs.push({ memory_chunk_id: chunk.memory_chunk_id, box_item_id: ref.box_item_id });
    }
    for (const ref of withRefs?.feedback_refs ?? []) {
      if (!readFeedbackEntry(butlerData, ref.feedback_id)) missingFeedbackRefs.push({ memory_chunk_id: chunk.memory_chunk_id, feedback_id: ref.feedback_id });
    }
  }
  return {
    schema: "butler.cognition.memory-metadata.integrity.v1",
    checked_at: iso(),
    chunk_count: chunks.length,
    missing_box_refs: missingBoxRefs,
    missing_feedback_refs: missingFeedbackRefs,
  };
}

export function repairMemoryMetadataIntegrity(butlerData: string): MemoryMetadataRepairReport {
  const before = checkMemoryMetadataIntegrity(butlerData);
  if (!existsSync(memoryMetadataPath(butlerData))) {
    return { ...before, repaired_box_refs: 0, repaired_feedback_refs: 0 };
  }
  const db = openMemoryMetadataDb(butlerData);
  try {
    const removeBox = db.query("DELETE FROM memory_chunk_box_refs WHERE memory_chunk_id = ? AND box_item_id = ?");
    for (const ref of before.missing_box_refs) removeBox.run(ref.memory_chunk_id, ref.box_item_id);
    const removeFeedback = db.query("DELETE FROM memory_chunk_feedback_refs WHERE memory_chunk_id = ? AND feedback_id = ?");
    for (const ref of before.missing_feedback_refs) removeFeedback.run(ref.memory_chunk_id, ref.feedback_id);
  } finally {
    db.close();
  }
  return {
    ...checkMemoryMetadataIntegrity(butlerData),
    repaired_box_refs: before.missing_box_refs.length,
    repaired_feedback_refs: before.missing_feedback_refs.length,
  };
}

function toChunkParams(chunk: MemoryChunk): Record<string, string | null> {
  return {
    $memory_chunk_id: chunk.memory_chunk_id,
    $schema_version: chunk.schema_version,
    $status: chunk.status,
    $scope: chunk.scope,
    $project_id: chunk.project_id,
    $summary: chunk.summary,
    $text_ref: chunk.text_ref,
    $text_hash: chunk.text_hash,
    $privacy_class: chunk.privacy_class,
    $freshness_class: chunk.freshness_class,
    $source: chunk.source,
    $created_at: chunk.created_at,
    $updated_at: chunk.updated_at,
    $consolidated_at: chunk.consolidated_at,
    $consolidation_run_id: chunk.consolidation_run_id,
    $superseded_by: chunk.superseded_by,
  };
}

function linkMemoryChunkOriginDb(db: Database, memoryChunkId: string, ref: MemoryOriginRef): void {
  db.query("INSERT OR IGNORE INTO memory_chunk_origins (memory_chunk_id, ref_type, ref_id) VALUES (?, ?, ?)")
    .run(memoryChunkId, ref.ref_type, ref.ref_id);
}

function linkMemoryChunkBoxDb(db: Database, memoryChunkId: string, ref: MemoryBoxRef): void {
  db.query("INSERT OR IGNORE INTO memory_chunk_box_refs (memory_chunk_id, box_item_id, relation) VALUES (?, ?, ?)")
    .run(memoryChunkId, ref.box_item_id, ref.relation);
}

function linkMemoryChunkFeedbackDb(db: Database, memoryChunkId: string, ref: MemoryFeedbackRef): void {
  db.query("INSERT OR IGNORE INTO memory_chunk_feedback_refs (memory_chunk_id, feedback_id, relation) VALUES (?, ?, ?)")
    .run(memoryChunkId, ref.feedback_id, ref.relation);
}

function linkMemoryChunkGraphDb(db: Database, memoryChunkId: string, ref: MemoryGraphRef): void {
  db.query("INSERT OR IGNORE INTO memory_chunk_graph_refs (memory_chunk_id, graph_ref_type, graph_ref_id, relation) VALUES (?, ?, ?, ?)")
    .run(memoryChunkId, ref.graph_ref_type, ref.graph_ref_id, ref.relation);
}

function linkMemoryChunkVectorDb(db: Database, memoryChunkId: string, ref: MemoryVectorRef): void {
  db.query(`
    INSERT OR IGNORE INTO memory_chunk_vector_refs (
      memory_chunk_id, vector_store, vector_table, vector_row_id, embedding_model, embedding_dimension, indexed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(memoryChunkId, ref.vector_store, ref.vector_table, ref.vector_row_id, ref.embedding_model, ref.embedding_dimension, ref.indexed_at);
}
