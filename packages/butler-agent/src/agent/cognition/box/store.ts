import { createHash, randomUUID } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { Database } from "bun:sqlite";
import { cognitionBoxRoot } from "../paths.ts";

export const BOX_ITEM_SCHEMA = "butler.cognition.box.item.v1";
export const BOX_ARTIFACT_EVENT_SCHEMA = "butler.cognition.box.artifact-event.v1";

export type BoxItemKind =
  | "file"
  | "web_snapshot"
  | "source_snapshot"
  | "tool_result"
  | "worker_artifact"
  | "report"
  | "collection"
  | "external_ref";

export type BoxItemStatus =
  | "pending"
  | "indexed"
  | "summarized"
  | "linked"
  | "failed_retryable"
  | "failed_terminal"
  | "forgotten";

export type BoxFileOwnership = "box-owned" | "external-user-owned";
export type BoxPrivacyClass = "public" | "private" | "sensitive" | "secret";
export type BoxRetentionClass = "working" | "pinned" | "archive";
export type BoxFreshnessClass = "unknown" | "current" | "stale" | "historical";

export type BoxOriginRefs = {
  producer: string;
  session_id: string | null;
  turn_id: string | null;
  message_id: string | null;
  tool_call_id: string | null;
  worker_run_id: string | null;
  consolidation_run_id: string | null;
};

export type BoxSourceRef = {
  uri: string | null;
  local_path: string | null;
  provider: string | null;
  fetched_at: string | null;
  observed_at: string | null;
};

export type BoxFileRef = {
  role: string;
  path: string | null;
  box_relative_path: string | null;
  ownership: BoxFileOwnership;
  size_bytes: number | null;
  sha256: string | null;
  mime_type: string | null;
  mtime: string | null;
};

export type BoxManifest = {
  schema: typeof BOX_ITEM_SCHEMA;
  box_item_id: string;
  collection_id: string | null;
  kind: BoxItemKind;
  status: BoxItemStatus;
  created_at: string;
  captured_at: string;
  updated_at: string;
  title: string;
  summary: string;
  tags: string[];
  origin: BoxOriginRefs;
  source: BoxSourceRef;
  files: BoxFileRef[];
  privacy: {
    class: BoxPrivacyClass;
    external_provider_allowed: boolean;
    reason: string;
  };
  retention: {
    class: BoxRetentionClass;
    pinned: boolean;
    expires_at: string | null;
  };
  freshness: {
    class: BoxFreshnessClass;
    source_timestamp: string | null;
    checked_at: string | null;
    expires_at: string | null;
  };
  refs: {
    memory_chunk_ids: string[];
    feedback_ids: string[];
    knowhow_ids: string[];
    graph_edge_ids: string[];
    parent_box_item_id: string | null;
  };
  quality: {
    score: number | null;
    signals: string[];
  };
  citations: string[];
  provenance: string[];
};

export type CreateBoxItemInput = {
  boxItemId?: string;
  collectionId?: string | null;
  kind: BoxItemKind;
  status?: BoxItemStatus;
  capturedAt?: string;
  title: string;
  summary: string;
  tags?: string[];
  origin?: Partial<BoxOriginRefs>;
  source?: Partial<BoxSourceRef>;
  files?: BoxFileRef[];
  content?: Array<{
    role?: string;
    filename: string;
    data: string | Uint8Array;
    mimeType?: string | null;
  }>;
  privacy?: Partial<BoxManifest["privacy"]>;
  retention?: Partial<BoxManifest["retention"]>;
  freshness?: Partial<BoxManifest["freshness"]>;
  refs?: Partial<BoxManifest["refs"]>;
  quality?: Partial<BoxManifest["quality"]>;
  citations?: string[];
  provenance?: string[];
  now?: Date;
};

export type BoxArtifactEvent = {
  schema: typeof BOX_ARTIFACT_EVENT_SCHEMA;
  artifact_event_id: string;
  created_at: string;
  origin: Omit<BoxOriginRefs, "producer">;
  artifacts: Array<{
    kind: string;
    path: string;
    ownership: BoxFileOwnership;
  }>;
  status: "pending" | "ingested" | "failed";
};

export type BoxIndexItem = {
  box_item_id: string;
  schema_version: string;
  kind: string;
  status: string;
  title: string | null;
  summary: string | null;
  privacy_class: string;
  retention_class: string;
  freshness_class: string;
  created_at: string;
  captured_at: string | null;
  updated_at: string;
  manifest_path: string;
  content_hash: string | null;
};

export type BoxIndexRebuildReport = {
  schema: "butler.cognition.box.index-rebuild-report.v1";
  rebuilt_at: string;
  status: "ok" | "partial";
  indexed_count: number;
  skipped_count: number;
  skipped: Array<{ path: string; issues: string[] }>;
  index_path: string;
};

const VALID_KINDS = new Set<BoxItemKind>(["file", "web_snapshot", "source_snapshot", "tool_result", "worker_artifact", "report", "collection", "external_ref"]);
const VALID_STATUSES = new Set<BoxItemStatus>(["pending", "indexed", "summarized", "linked", "failed_retryable", "failed_terminal", "forgotten"]);
const VALID_OWNERSHIP = new Set<BoxFileOwnership>(["box-owned", "external-user-owned"]);
const VALID_PRIVACY = new Set<BoxPrivacyClass>(["public", "private", "sensitive", "secret"]);
const VALID_RETENTION = new Set<BoxRetentionClass>(["working", "pinned", "archive"]);
const VALID_FRESHNESS = new Set<BoxFreshnessClass>(["unknown", "current", "stale", "historical"]);

function iso(date: Date = new Date()): string {
  return date.toISOString();
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function atomicWriteFile(path: string, content: string | Uint8Array): void {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function writeJsonFile(path: string, value: unknown): void {
  atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function boxItemId(): string {
  return `box_${randomUUID()}`;
}

export function artifactEventId(): string {
  return `artev_${randomUUID()}`;
}

export function boxItemsRoot(butlerData: string): string {
  return join(cognitionBoxRoot(butlerData), "items");
}

export function boxItemRoot(butlerData: string, id: string): string {
  return join(boxItemsRoot(butlerData), id);
}

export function boxManifestPath(butlerData: string, id: string): string {
  return join(boxItemRoot(butlerData, id), "manifest.json");
}

export function boxIndexPath(butlerData: string): string {
  return join(cognitionBoxRoot(butlerData), "index.sqlite");
}

export function boxEventsPath(butlerData: string): string {
  return join(cognitionBoxRoot(butlerData), "events", "artifact-created.jsonl");
}

export function boxIngestQueuePath(butlerData: string): string {
  return join(cognitionBoxRoot(butlerData), "queue", "ingest.jsonl");
}

export function writeBoxBlob(butlerData: string, data: string | Uint8Array): { sha256: string; size_bytes: number; path: string; box_relative_path: string } {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const relative = join("blobs", sha256.slice(0, 2), sha256);
  const path = join(cognitionBoxRoot(butlerData), relative);
  if (!existsSync(path)) atomicWriteFile(path, bytes);
  return { sha256, size_bytes: bytes.byteLength, path, box_relative_path: relative };
}

export function appendBoxArtifactEvent(
  butlerData: string,
  input: {
    artifactEventId?: string;
    origin?: Partial<BoxArtifactEvent["origin"]>;
    artifacts: BoxArtifactEvent["artifacts"];
    now?: Date;
  },
): BoxArtifactEvent {
  const event: BoxArtifactEvent = {
    schema: BOX_ARTIFACT_EVENT_SCHEMA,
    artifact_event_id: input.artifactEventId ?? artifactEventId(),
    created_at: iso(input.now),
    origin: {
      session_id: input.origin?.session_id ?? null,
      turn_id: input.origin?.turn_id ?? null,
      message_id: input.origin?.message_id ?? null,
      tool_call_id: input.origin?.tool_call_id ?? null,
      worker_run_id: input.origin?.worker_run_id ?? null,
      consolidation_run_id: input.origin?.consolidation_run_id ?? null,
    },
    artifacts: input.artifacts,
    status: "pending",
  };
  const line = `${JSON.stringify(event)}\n`;
  ensureDir(dirname(boxEventsPath(butlerData)));
  ensureDir(dirname(boxIngestQueuePath(butlerData)));
  appendFileSync(boxEventsPath(butlerData), line, "utf8");
  appendFileSync(boxIngestQueuePath(butlerData), line, "utf8");
  return event;
}

export function createBoxItem(butlerData: string, input: CreateBoxItemInput): BoxManifest {
  const id = input.boxItemId ?? boxItemId();
  const now = iso(input.now);
  const root = boxItemRoot(butlerData, id);
  const contentFiles: BoxFileRef[] = [];
  for (const content of input.content ?? []) {
    const relative = join("content", content.filename);
    const path = join(root, relative);
    const bytes = typeof content.data === "string" ? Buffer.from(content.data, "utf8") : Buffer.from(content.data);
    atomicWriteFile(path, bytes);
    contentFiles.push({
      role: content.role ?? "primary",
      path: null,
      box_relative_path: relative,
      ownership: "box-owned",
      size_bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mime_type: content.mimeType ?? null,
      mtime: now,
    });
  }
  const manifest: BoxManifest = {
    schema: BOX_ITEM_SCHEMA,
    box_item_id: id,
    collection_id: input.collectionId ?? null,
    kind: input.kind,
    status: input.status ?? "pending",
    created_at: now,
    captured_at: input.capturedAt ?? now,
    updated_at: now,
    title: input.title,
    summary: input.summary,
    tags: [...new Set(input.tags ?? [])],
    origin: {
      producer: input.origin?.producer ?? "unknown",
      session_id: input.origin?.session_id ?? null,
      turn_id: input.origin?.turn_id ?? null,
      message_id: input.origin?.message_id ?? null,
      tool_call_id: input.origin?.tool_call_id ?? null,
      worker_run_id: input.origin?.worker_run_id ?? null,
      consolidation_run_id: input.origin?.consolidation_run_id ?? null,
    },
    source: {
      uri: input.source?.uri ?? null,
      local_path: input.source?.local_path ?? null,
      provider: input.source?.provider ?? null,
      fetched_at: input.source?.fetched_at ?? null,
      observed_at: input.source?.observed_at ?? null,
    },
    files: [...(input.files ?? []), ...contentFiles],
    privacy: {
      class: input.privacy?.class ?? "private",
      external_provider_allowed: input.privacy?.external_provider_allowed ?? false,
      reason: input.privacy?.reason ?? "local-user-data",
    },
    retention: {
      class: input.retention?.class ?? "working",
      pinned: input.retention?.pinned ?? false,
      expires_at: input.retention?.expires_at ?? null,
    },
    freshness: {
      class: input.freshness?.class ?? "unknown",
      source_timestamp: input.freshness?.source_timestamp ?? null,
      checked_at: input.freshness?.checked_at ?? null,
      expires_at: input.freshness?.expires_at ?? null,
    },
    refs: {
      memory_chunk_ids: input.refs?.memory_chunk_ids ?? [],
      feedback_ids: input.refs?.feedback_ids ?? [],
      knowhow_ids: input.refs?.knowhow_ids ?? [],
      graph_edge_ids: input.refs?.graph_edge_ids ?? [],
      parent_box_item_id: input.refs?.parent_box_item_id ?? null,
    },
    quality: {
      score: input.quality?.score ?? null,
      signals: input.quality?.signals ?? [],
    },
    citations: input.citations ?? [],
    provenance: input.provenance ?? [],
  };
  const issues = validateBoxManifest(manifest, id);
  if (issues.length > 0) throw new Error(`invalid Box manifest: ${issues.join("; ")}`);
  writeJsonFile(boxManifestPath(butlerData, id), manifest);
  return manifest;
}

export function writeBoxManifest(butlerData: string, manifest: BoxManifest): void {
  const issues = validateBoxManifest(manifest, manifest.box_item_id);
  if (issues.length > 0) throw new Error(`invalid Box manifest: ${issues.join("; ")}`);
  writeJsonFile(boxManifestPath(butlerData, manifest.box_item_id), manifest);
}

export function readBoxManifest(butlerData: string, id: string): BoxManifest | null {
  const path = boxManifestPath(butlerData, id);
  return existsSync(path) ? readJsonFile<BoxManifest>(path) : null;
}

export function listBoxManifests(butlerData: string): BoxManifest[] {
  const root = boxItemsRoot(butlerData);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readBoxManifest(butlerData, entry.name))
    .filter((manifest): manifest is BoxManifest => Boolean(manifest));
}

export function validateBoxManifest(manifest: BoxManifest, expectedId: string | null = null): string[] {
  const issues: string[] = [];
  if (manifest.schema !== BOX_ITEM_SCHEMA) issues.push("schema must be butler.cognition.box.item.v1");
  if (!manifest.box_item_id?.startsWith("box_")) issues.push("box_item_id must start with box_");
  if (expectedId && manifest.box_item_id !== expectedId) issues.push("box_item_id must match item directory");
  if (!VALID_KINDS.has(manifest.kind)) issues.push(`invalid kind: ${manifest.kind}`);
  if (!VALID_STATUSES.has(manifest.status)) issues.push(`invalid status: ${manifest.status}`);
  if (!VALID_PRIVACY.has(manifest.privacy?.class)) issues.push(`invalid privacy class: ${manifest.privacy?.class}`);
  if (!VALID_RETENTION.has(manifest.retention?.class)) issues.push(`invalid retention class: ${manifest.retention?.class}`);
  if (!VALID_FRESHNESS.has(manifest.freshness?.class)) issues.push(`invalid freshness class: ${manifest.freshness?.class}`);
  for (const file of manifest.files ?? []) {
    if (!VALID_OWNERSHIP.has(file.ownership)) issues.push(`invalid file ownership: ${file.ownership}`);
  }
  return issues;
}

export function rebuildBoxIndex(butlerData: string): BoxIndexRebuildReport {
  const root = cognitionBoxRoot(butlerData);
  ensureDir(root);
  const indexPath = boxIndexPath(butlerData);
  const tmpPath = `${indexPath}.tmp-${randomUUID()}`;
  const reportPath = join(root, "index-rebuild-report.json");
  const db = new Database(tmpPath, { create: true });
  const skipped: BoxIndexRebuildReport["skipped"] = [];
  let indexedCount = 0;
  try {
    createBoxIndexSchema(db);
    for (const dir of existsSync(boxItemsRoot(butlerData)) ? readdirSync(boxItemsRoot(butlerData), { withFileTypes: true }) : []) {
      if (!dir.isDirectory()) continue;
      const manifestPath = boxManifestPath(butlerData, dir.name);
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = readJsonFile<BoxManifest>(manifestPath);
        const issues = validateBoxManifest(manifest, dir.name);
        if (issues.length > 0) {
          skipped.push({ path: manifestPath, issues });
          continue;
        }
        insertBoxIndexRows(db, butlerData, manifest);
        indexedCount += 1;
      } catch (error) {
        skipped.push({ path: manifestPath, issues: [error instanceof Error ? error.message : String(error)] });
      }
    }
  } finally {
    db.close();
  }
  renameSync(tmpPath, indexPath);
  const report: BoxIndexRebuildReport = {
    schema: "butler.cognition.box.index-rebuild-report.v1",
    rebuilt_at: iso(),
    status: skipped.length === 0 ? "ok" : "partial",
    indexed_count: indexedCount,
    skipped_count: skipped.length,
    skipped,
    index_path: indexPath,
  };
  writeJsonFile(reportPath, report);
  return report;
}

export function listIndexedBoxItems(butlerData: string, limit = 100): BoxIndexItem[] {
  if (!existsSync(boxIndexPath(butlerData))) rebuildBoxIndex(butlerData);
  const db = new Database(boxIndexPath(butlerData), { readonly: true });
  try {
    return db.query(`
      SELECT box_item_id, schema_version, kind, status, title, summary, privacy_class,
        retention_class, freshness_class, created_at, captured_at, updated_at, manifest_path, content_hash
      FROM box_items
      ORDER BY created_at DESC, box_item_id DESC
      LIMIT $limit
    `).all({ $limit: limit }) as BoxIndexItem[];
  } finally {
    db.close();
  }
}

function createBoxIndexSchema(db: Database): void {
  db.run("PRAGMA journal_mode = DELETE");
  db.run(`
    CREATE TABLE box_items (
      box_item_id TEXT PRIMARY KEY,
      schema_version TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT,
      summary TEXT,
      privacy_class TEXT NOT NULL,
      retention_class TEXT NOT NULL,
      freshness_class TEXT NOT NULL,
      created_at TEXT NOT NULL,
      captured_at TEXT,
      updated_at TEXT NOT NULL,
      manifest_path TEXT NOT NULL,
      content_hash TEXT
    )
  `);
  db.run(`
    CREATE TABLE box_item_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      box_item_id TEXT NOT NULL REFERENCES box_items(box_item_id),
      role TEXT NOT NULL,
      path TEXT,
      box_relative_path TEXT,
      ownership TEXT NOT NULL,
      size_bytes INTEGER,
      sha256 TEXT,
      mime_type TEXT,
      mtime TEXT
    )
  `);
  db.run(`
    CREATE TABLE box_item_origins (
      box_item_id TEXT NOT NULL REFERENCES box_items(box_item_id),
      ref_type TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      PRIMARY KEY (box_item_id, ref_type, ref_id)
    )
  `);
  db.run(`
    CREATE TABLE box_item_refs (
      box_item_id TEXT NOT NULL REFERENCES box_items(box_item_id),
      ref_type TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      PRIMARY KEY (box_item_id, ref_type, ref_id, relation)
    )
  `);
  db.run(`
    CREATE TABLE box_item_tags (
      box_item_id TEXT NOT NULL REFERENCES box_items(box_item_id),
      tag TEXT NOT NULL,
      PRIMARY KEY (box_item_id, tag)
    )
  `);
  db.run("CREATE INDEX idx_box_items_kind ON box_items(kind)");
  db.run("CREATE INDEX idx_box_items_status ON box_items(status)");
  db.run("CREATE INDEX idx_box_items_created_at ON box_items(created_at)");
  db.run("CREATE INDEX idx_box_items_privacy ON box_items(privacy_class)");
  db.run("CREATE INDEX idx_box_item_origins_ref ON box_item_origins(ref_type, ref_id)");
  db.run("CREATE INDEX idx_box_item_refs_ref ON box_item_refs(ref_type, ref_id)");
  db.run("CREATE INDEX idx_box_item_tags_tag ON box_item_tags(tag)");
}

function insertBoxIndexRows(db: Database, butlerData: string, manifest: BoxManifest): void {
  const manifestPath = boxManifestPath(butlerData, manifest.box_item_id);
  db.query(`
    INSERT INTO box_items (
      box_item_id, schema_version, kind, status, title, summary, privacy_class,
      retention_class, freshness_class, created_at, captured_at, updated_at, manifest_path, content_hash
    )
    VALUES ($box_item_id, $schema_version, $kind, $status, $title, $summary, $privacy_class,
      $retention_class, $freshness_class, $created_at, $captured_at, $updated_at, $manifest_path, $content_hash)
  `).run({
    $box_item_id: manifest.box_item_id,
    $schema_version: manifest.schema,
    $kind: manifest.kind,
    $status: manifest.status,
    $title: manifest.title,
    $summary: manifest.summary,
    $privacy_class: manifest.privacy.class,
    $retention_class: manifest.retention.class,
    $freshness_class: manifest.freshness.class,
    $created_at: manifest.created_at,
    $captured_at: manifest.captured_at,
    $updated_at: manifest.updated_at,
    $manifest_path: manifestPath,
    $content_hash: manifest.files.find((file) => file.role === "primary")?.sha256 ?? null,
  });
  const insertFile = db.query(`
    INSERT INTO box_item_files (box_item_id, role, path, box_relative_path, ownership, size_bytes, sha256, mime_type, mtime)
    VALUES ($box_item_id, $role, $path, $box_relative_path, $ownership, $size_bytes, $sha256, $mime_type, $mtime)
  `);
  for (const file of manifest.files) {
    insertFile.run({
      $box_item_id: manifest.box_item_id,
      $role: file.role,
      $path: file.path,
      $box_relative_path: file.box_relative_path,
      $ownership: file.ownership,
      $size_bytes: file.size_bytes,
      $sha256: file.sha256,
      $mime_type: file.mime_type,
      $mtime: file.mtime,
    });
  }
  const insertOrigin = db.query(`
    INSERT OR IGNORE INTO box_item_origins (box_item_id, ref_type, ref_id)
    VALUES ($box_item_id, $ref_type, $ref_id)
  `);
  for (const [refType, refId] of originPairs(manifest.origin)) {
    insertOrigin.run({ $box_item_id: manifest.box_item_id, $ref_type: refType, $ref_id: refId });
  }
  const insertRef = db.query(`
    INSERT OR IGNORE INTO box_item_refs (box_item_id, ref_type, ref_id, relation)
    VALUES ($box_item_id, $ref_type, $ref_id, $relation)
  `);
  for (const [refType, refId, relation] of refPairs(manifest)) {
    insertRef.run({ $box_item_id: manifest.box_item_id, $ref_type: refType, $ref_id: refId, $relation: relation });
  }
  const insertTag = db.query("INSERT OR IGNORE INTO box_item_tags (box_item_id, tag) VALUES ($box_item_id, $tag)");
  for (const tag of manifest.tags) insertTag.run({ $box_item_id: manifest.box_item_id, $tag: tag });
}

function originPairs(origin: BoxOriginRefs): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const key of ["session_id", "turn_id", "message_id", "tool_call_id", "worker_run_id", "consolidation_run_id"] as const) {
    const value = origin[key];
    if (value) pairs.push([key, value]);
  }
  return pairs;
}

function refPairs(manifest: BoxManifest): Array<[string, string, string]> {
  const pairs: Array<[string, string, string]> = [];
  for (const id of manifest.refs.memory_chunk_ids) pairs.push(["memory_chunk", id, "evidence"]);
  for (const id of manifest.refs.feedback_ids) pairs.push(["feedback", id, "feedback_context"]);
  for (const id of manifest.refs.knowhow_ids) pairs.push(["knowhow", id, "training_evidence"]);
  for (const id of manifest.refs.graph_edge_ids) pairs.push(["graph_edge", id, "graph_evidence"]);
  if (manifest.refs.parent_box_item_id) pairs.push(["box_item", manifest.refs.parent_box_item_id, "parent"]);
  return pairs;
}

export function boxItemSummary(manifest: BoxManifest): Record<string, unknown> {
  return {
    box_item_id: manifest.box_item_id,
    kind: manifest.kind,
    status: manifest.status,
    title: manifest.title,
    summary: manifest.summary,
    privacy_class: manifest.privacy.class,
    retention_class: manifest.retention.class,
    freshness_class: manifest.freshness.class,
    created_at: manifest.created_at,
    captured_at: manifest.captured_at,
    updated_at: manifest.updated_at,
    tags: manifest.tags,
    file_count: manifest.files.length,
  };
}
