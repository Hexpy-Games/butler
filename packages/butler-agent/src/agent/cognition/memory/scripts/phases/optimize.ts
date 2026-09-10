// Sleep-cycle sub-phase: optimize.
// - Compacts per-topic hot caches above the threshold.
// - Prunes LanceDB vectors whose backing entity activation is below the floor.
// - Calls LanceDB table-level compaction when the client exposes optimize().
import type { Database } from "bun:sqlite";
import { createRequire } from "node:module";
import { join } from "path";
import type { MemoryExecutionContext } from "../../projection/contracts.ts";
import { withMemoryWriteGateAsync } from "../../projection/ingestion.ts";

const fs: typeof import("fs") = createRequire(import.meta.url)("fs");

export interface OptimizeTable {
  delete(predicate: string): Promise<unknown>;
  optimize?: () => Promise<unknown>;
}

export interface CompactResult {
  filesCompacted: number;
  summariesReEmbedded: number;
}

export interface OptimizeOptions {
  db: Database;
  table: OptimizeTable;
  hotCacheDir: string;
  hotCacheCompactThresholdBytes: number;
  activationPruneFloor: number;
  compactHotCache: (filePath: string) => CompactResult;
}

export interface OptimizeMetrics {
  caches_compacted: number;
  summaries_re_embedded: number;
  vectors_pruned: number;
  lancedb_compacted: boolean;
}

function listHotCacheFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".md") || n.endsWith(".jsonl") || n.endsWith(".cache"))
    .map((n) => join(dir, n));
}

function pruneLowActivationSessionIds(
  db: Database,
  floor: number,
): string[] {
  // LanceDB rows are keyed by session_id, not entity_id. Translate activation
  // (an entity-level concept) into session-level by selecting sessions whose
  // every mentioned entity is below the floor — i.e. no mention anchors the
  // session to a still-active entity. Null activation sorts as -Infinity and
  // therefore does not rescue a session.
  const tableExists = db
    .query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('entities','entity_mentions')",
    )
    .all() as Array<{ name: string }>;
  if (tableExists.length < 2) return [];
  return (
    db
      .query(
        `SELECT DISTINCT em.session_id AS sid
         FROM entity_mentions em
         WHERE em.session_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
             FROM entity_mentions em2
             JOIN entities e ON e.id = em2.entity_id
             WHERE em2.session_id = em.session_id
               AND e.activation IS NOT NULL
               AND e.activation >= ?
           )`,
      )
      .all(floor) as Array<{ sid: string }>
  ).map((r) => r.sid);
}

async function batchDelete(
  table: OptimizeTable,
  ids: string[],
  batchSize = 100,
): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const quoted = batch.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
    await table.delete(`session_id IN (${quoted})`);
    deleted += batch.length;
  }
  return deleted;
}

export async function runOptimize(opts: OptimizeOptions): Promise<OptimizeMetrics> {
  const metrics: OptimizeMetrics = {
    caches_compacted: 0,
    summaries_re_embedded: 0,
    vectors_pruned: 0,
    lancedb_compacted: false,
  };

  // 1. Hot-cache compaction for files above threshold.
  for (const file of listHotCacheFiles(opts.hotCacheDir)) {
    const size = fs.statSync(file).size;
    if (size > opts.hotCacheCompactThresholdBytes) {
      const r = opts.compactHotCache(file);
      metrics.caches_compacted += r.filesCompacted;
      metrics.summaries_re_embedded += r.summariesReEmbedded;
    }
  }

  // 2. Prune vectors of sessions with no active-entity anchor.
  const lowSessionIds = pruneLowActivationSessionIds(
    opts.db,
    opts.activationPruneFloor,
  );
  if (lowSessionIds.length > 0) {
    metrics.vectors_pruned = await batchDelete(opts.table, lowSessionIds);
  }

  // 3. LanceDB table-level compaction (optional; older clients lack it).
  if (typeof opts.table.optimize === "function") {
    try {
      await opts.table.optimize();
      metrics.lancedb_compacted = true;
    } catch {
      metrics.lancedb_compacted = false;
    }
  }

  return metrics;
}

export async function runRevisionAwareOptimize(input: { db: Database; table: OptimizeTable; context: MemoryExecutionContext }): Promise<OptimizeMetrics> {
  const eligibleRows = () => input.db.query<{ receipt_json: string }, []>(`
    SELECT u.receipt_json FROM memory_vector_units u
    JOIN memory_projection_jobs j ON j.job_id=u.job_id
    JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id
    WHERE j.revision<>c.current_revision AND u.state='complete' AND u.receipt_json IS NOT NULL
      AND json_extract(j.semantic_graph_state,'$.state')='complete'
      AND EXISTS (
        SELECT 1 FROM memory_projection_jobs current_job
        WHERE current_job.episode_id=j.episode_id AND current_job.revision=c.current_revision
          AND json_extract(current_job.semantic_graph_state,'$.state')='complete'
          AND CASE u.record_kind
            WHEN 'episode' THEN json_extract(current_job.episode_vectors_state,'$.state')
            WHEN 'node' THEN json_extract(current_job.node_vectors_state,'$.state')
          END='complete'
          AND NOT EXISTS (
            SELECT 1 FROM memory_vector_units current_unit
            WHERE current_unit.job_id=current_job.job_id AND current_unit.record_kind=u.record_kind
              AND current_unit.state NOT IN ('complete','superseded')
          )
      )
  `).all();
  const liveRowsNow = () => input.db.query<{ receipt_json: string }, []>(`
    SELECT u.receipt_json FROM memory_vector_units u
    JOIN memory_projection_jobs j ON j.job_id=u.job_id
    JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
    WHERE u.receipt_json IS NOT NULL AND u.state!='superseded'
  `).all();
  const rows = eligibleRows();
  const liveRows = liveRowsNow();
  const receiptKeys = (receiptJson: string): string[] => {
    try {
      const receipt = JSON.parse(receiptJson) as { vector_keys?: unknown };
      return Array.isArray(receipt.vector_keys)
        ? receipt.vector_keys.filter((key): key is string => typeof key === "string" && Boolean(key))
        : [];
    } catch { return []; }
  };
  const liveKeys = new Set(liveRows.flatMap((row) => receiptKeys(row.receipt_json)));
  const keys = new Set<string>();
  for (const row of rows) {
    for (const key of receiptKeys(row.receipt_json)) if (!liveKeys.has(key)) keys.add(key);
  }
  let vectorsPruned = 0;
  let compacted = false;
  const commit = async () => {
    const currentLiveRows = liveRowsNow();
    const currentLiveKeys = new Set(currentLiveRows.flatMap((row) => receiptKeys(row.receipt_json)));
    const currentEligibleKeys = new Set(eligibleRows().flatMap((row) => receiptKeys(row.receipt_json)));
    const ordered = [...keys].filter((key) => currentEligibleKeys.has(key) && !currentLiveKeys.has(key)).sort();
    for (let index = 0; index < ordered.length; index += 100) {
      const batch = ordered.slice(index, index + 100);
      await input.table.delete(`vector_key IN (${batch.map((key) => `'${key.replace(/'/gu, "''")}'`).join(",")})`);
      vectorsPruned += batch.length;
    }
    if (ordered.length && input.table.optimize) {
      try { await input.table.optimize(); compacted = true; } catch {}
    }
  };
  await withMemoryWriteGateAsync(input.context, commit);
  return { caches_compacted: 0, summaries_re_embedded: 0, vectors_pruned: vectorsPruned, lancedb_compacted: compacted };
}
