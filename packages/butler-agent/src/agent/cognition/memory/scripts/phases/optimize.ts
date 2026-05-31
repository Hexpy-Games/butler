// Sleep-cycle sub-phase: optimize.
// - Compacts per-topic hot caches above the threshold.
// - Prunes LanceDB vectors whose backing entity activation is below the floor.
// - Calls LanceDB table-level compaction when the client exposes optimize().
import type { Database } from "bun:sqlite";
import { createRequire } from "node:module";
import { join } from "path";

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
