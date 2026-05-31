// Sleep-cycle sub-phase: graph consolidation.
// - Merges near-duplicate entities using pure primitives from lib/dedup-entities.ts
// - Applies ACT-R activation decay per entity using lib/activation.ts
// - Boosts edge weights by ln(1 + 7-day cross-session mentions) via lib/edge-boost.ts
// - Archives attribute conflicts to entity_conflicts
//
// Schema assumed (additive, created by runConsolidate if missing):
//   entities.activation REAL NULL
//   entity_conflicts(id,entity_id,attribute_key,losing_value,losing_ts,winning_ts,reason,created_at)
import type { Database } from "bun:sqlite";
import {
  planMerges,
  type EntityRow,
  type MergePlan,
} from "../lib/dedup-entities.ts";
import { computeActivation } from "../lib/activation.ts";
import { computeEdgeWeightBoost } from "../lib/edge-boost.ts";

export interface ConsolidateOptions {
  db: Database;
  nowMs: number;
  decayD: number;
  edgeBoostWindowMs: number;
}

export interface ConsolidateMetrics {
  candidates_considered: number;
  merges_applied: number;
  edges_boosted: number;
  conflicts_archived: number;
  activations_written: number;
}

const SECONDS_TIMESTAMP_CUTOFF = 10_000_000_000;

function timestampToMs(value: number): number {
  if (!Number.isFinite(value)) return value;
  return Math.abs(value) < SECONDS_TIMESTAMP_CUTOFF ? value * 1000 : value;
}

export function ensureConsolidateSchema(db: Database): void {
  try {
    db.exec("ALTER TABLE entities ADD COLUMN activation REAL");
  } catch {}
  db.exec(`
CREATE TABLE IF NOT EXISTS entity_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL,
  attribute_key TEXT NOT NULL,
  losing_value TEXT,
  losing_ts INTEGER,
  winning_ts INTEGER,
  reason TEXT,
  created_at INTEGER NOT NULL
);
`);
}

function loadEntityRows(db: Database): EntityRow[] {
  return db
    .query(
      "SELECT id, type, name, activation FROM entities ORDER BY id",
    )
    .all() as EntityRow[];
}

function unionProperties(
  db: Database,
  plan: MergePlan,
  nowSec: number,
): number {
  let conflictsWritten = 0;

  const canonicalRow = db.query("SELECT properties, updated_at FROM entities WHERE id = ?").get(plan.canonical.id) as any;
  const canonicalProps = JSON.parse(canonicalRow?.properties ?? "{}");
  const canonicalTs = typeof canonicalRow?.updated_at === "number" ? canonicalRow.updated_at : nowSec;

  for (const loser of plan.losers) {
    const row = db.query("SELECT properties, updated_at FROM entities WHERE id = ?").get(loser.id) as any;
    if (!row) continue;
    const loserProps = JSON.parse(row.properties ?? "{}");
    const loserTs = row.updated_at as number;

    for (const [k, v] of Object.entries(loserProps)) {
      if (!(k in canonicalProps)) {
        canonicalProps[k] = v;
        continue;
      }
      // Conflict — canonical already has a value for k. Keep canonical (latest ts assumed).
      db.prepare(
        "INSERT INTO entity_conflicts (entity_id, attribute_key, losing_value, losing_ts, winning_ts, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        plan.canonical.id,
        k,
        JSON.stringify(v),
        loserTs,
        canonicalTs,
        "merge_conflict",
        nowSec,
      );
      conflictsWritten += 1;
    }
  }

  db.prepare("UPDATE entities SET properties = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(canonicalProps),
    nowSec,
    plan.canonical.id,
  );
  return conflictsWritten;
}

function redirectEdges(db: Database, plan: MergePlan): void {
  for (const loser of plan.losers) {
    // Redirect sources.
    const sourceEdges = db
      .query("SELECT id, source_id, target_id, rel_type FROM edges WHERE source_id = ?")
      .all(loser.id) as Array<{ id: number; target_id: string; rel_type: string }>;
    for (const e of sourceEdges) {
      if (e.target_id === plan.canonical.id) {
        db.prepare("DELETE FROM edges WHERE id = ?").run(e.id);
        continue;
      }
      const existing = db
        .query(
          "SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND rel_type = ?",
        )
        .get(plan.canonical.id, e.target_id, e.rel_type) as { id: number } | null;
      if (existing && existing.id !== e.id) {
        db.prepare("DELETE FROM edges WHERE id = ?").run(e.id);
      } else {
        db.prepare("UPDATE edges SET source_id = ? WHERE id = ?").run(
          plan.canonical.id,
          e.id,
        );
      }
    }
    // Redirect targets.
    const targetEdges = db
      .query("SELECT id, source_id, rel_type FROM edges WHERE target_id = ?")
      .all(loser.id) as Array<{ id: number; source_id: string; rel_type: string }>;
    for (const e of targetEdges) {
      if (e.source_id === plan.canonical.id) {
        db.prepare("DELETE FROM edges WHERE id = ?").run(e.id);
        continue;
      }
      const existing = db
        .query(
          "SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND rel_type = ?",
        )
        .get(e.source_id, plan.canonical.id, e.rel_type) as { id: number } | null;
      if (existing && existing.id !== e.id) {
        db.prepare("DELETE FROM edges WHERE id = ?").run(e.id);
      } else {
        db.prepare("UPDATE edges SET target_id = ? WHERE id = ?").run(
          plan.canonical.id,
          e.id,
        );
      }
    }
    // Redirect mentions.
    db.prepare("UPDATE entity_mentions SET entity_id = ? WHERE entity_id = ?").run(
      plan.canonical.id,
      loser.id,
    );
    // Drop the loser row.
    db.prepare("DELETE FROM entities WHERE id = ?").run(loser.id);
  }
}

function updateActivations(
  db: Database,
  nowMs: number,
  decayD: number,
): number {
  const entities = db.query("SELECT id FROM entities").all() as { id: string }[];
  let written = 0;
  const update = db.prepare("UPDATE entities SET activation = ? WHERE id = ?");
  for (const e of entities) {
    const refs = db
      .query("SELECT timestamp FROM entity_mentions WHERE entity_id = ?")
      .all(e.id) as Array<{ timestamp: number }>;
    const act = computeActivation(refs.map((r) => timestampToMs(r.timestamp)), nowMs, decayD);
    update.run(act, e.id);
    written += 1;
  }
  return written;
}

function boostEdges(db: Database, nowMs: number, windowMs: number): number {
  const cutoffMs = nowMs - windowMs;
  const coMentionCounts = buildCoMentionCounts(db, cutoffMs);
  const edges = db
    .query(
      "SELECT id, source_id, target_id, rel_type, weight FROM edges",
    )
    .all() as Array<{
      id: number;
      source_id: string;
      target_id: string;
      rel_type: string;
      weight: number;
    }>;
  const stmt = db.prepare("UPDATE edges SET weight = ? WHERE id = ?");
  let boosted = 0;
  for (const e of edges) {
    const coMentionSessions = coMentionCounts.get(pairKey(e.source_id, e.target_id)) ?? 0;
    const boost = computeEdgeWeightBoost(coMentionSessions);
    if (boost > 0) {
      stmt.run(e.weight + boost, e.id);
      boosted += 1;
    }
  }
  return boosted;
}

function pairKey(left: string, right: string): string {
  return `${left}\u0000${right}`;
}

function buildCoMentionCounts(db: Database, cutoffMs: number): Map<string, number> {
  const rows = db
    .query("SELECT entity_id, session_id, timestamp FROM entity_mentions")
    .all() as Array<{
      entity_id: string;
      session_id: string;
      timestamp: number;
    }>;
  const bySession = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.session_id) continue;
    if (timestampToMs(row.timestamp) < cutoffMs) continue;
    const entities = bySession.get(row.session_id) ?? new Set<string>();
    entities.add(row.entity_id);
    bySession.set(row.session_id, entities);
  }

  const counts = new Map<string, number>();
  for (const entities of bySession.values()) {
    const ids = [...entities];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const left = ids[i]!;
        const right = ids[j]!;
        counts.set(pairKey(left, right), (counts.get(pairKey(left, right)) ?? 0) + 1);
        counts.set(pairKey(right, left), (counts.get(pairKey(right, left)) ?? 0) + 1);
      }
    }
  }
  return counts;
}

export function runConsolidate(opts: ConsolidateOptions): ConsolidateMetrics {
  ensureConsolidateSchema(opts.db);
  return opts.db.transaction(() => {
    const nowSec = Math.floor(opts.nowMs / 1000);

    const rows = loadEntityRows(opts.db);
    const plans = planMerges(rows);

    let merges = 0;
    let conflicts = 0;
    for (const plan of plans) {
      conflicts += unionProperties(opts.db, plan, nowSec);
      redirectEdges(opts.db, plan);
      merges += 1;
    }

    const edges_boosted = boostEdges(opts.db, opts.nowMs, opts.edgeBoostWindowMs);
    const activations_written = updateActivations(opts.db, opts.nowMs, opts.decayD);

    return {
      candidates_considered: plans.reduce((n, p) => n + p.losers.length + 1, 0),
      merges_applied: merges,
      edges_boosted,
      conflicts_archived: conflicts,
      activations_written,
    };
  })();
}
