import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { ensureV2MemorySchema, installAndBackfillRecallIndexes } from "./store.ts";
import { insertClaim, recordMention, sourceClass } from "./claim-store.ts";
import { backfillSourceIndex } from "./source-index-migration.ts";

const preservedTables = ["memory_chunk_sources", "memory_projection_windows", "memory_projection_attempts", "memory_vector_units", "edges", "edge_evidence"];
function hasTable(db: Database, table: string): boolean {
  return Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}
export function migrationFingerprints(db: Database): Record<string, { rows: number; sha256: string }> {
  return Object.fromEntries(preservedTables.filter((table) => hasTable(db, table)).map((table) => {
    const hash = createHash("sha256");
    let rows = 0;
    // These tables have stable primary keys and rowids. No aggregate of large saved responses.
    for (const row of db.query(`SELECT * FROM ${table} ORDER BY rowid`).iterate()) { hash.update(JSON.stringify(row)); hash.update("\n"); rows++; }
    return [table, { rows, sha256: hash.digest("hex") }];
  }));
}

/** Called only on an offline destination. No provider, identity merge, or re-extraction. */
export function migrateSourceGraph(db: Database, sourceRoot: string) {
  if (!hasTable(db, "entities")) {
    if (!hasTable(db, "memory_claims")) throw new Error("memory_migration_unsupported_schema");
    ensureV2MemorySchema(db);
    installAndBackfillRecallIndexes(db);
    return { migrated: false, modelCalls: 0, preserved: migrationFingerprints(db) };
  }
  const before = migrationFingerprints(db);
  const report = db.transaction(() => {
    for (const suffix of ["insert", "update", "delete", "scope"]) db.exec(`DROP TRIGGER IF EXISTS memory_alias_index_${suffix}`);
    db.query("DELETE FROM memory_state WHERE key='alias_postings_incremental_v1'").run();
    db.exec("ALTER TABLE entities RENAME TO memory_nodes");
    for (const [oldName, newName] of [["entity_mentions", "memory_evidence"], ["entity_aliases", "memory_aliases"], ["entity_alias_postings", "memory_alias_postings"]]) {
      if (hasTable(db, oldName!)) db.exec(`ALTER TABLE ${oldName} RENAME TO ${newName}`);
      if (hasTable(db, newName!)) db.exec(`ALTER TABLE ${newName} RENAME COLUMN entity_id TO node_id`);
    }
    if (hasTable(db, "memory_alias_index_dirty")) db.exec("ALTER TABLE memory_alias_index_dirty RENAME COLUMN entity_id TO node_id");
    ensureV2MemorySchema(db);
    const counts = { claims: 0, unknownSpeechActs: 0, mixedOrigins: 0, missingProperties: 0, literalMentions: 0, inferredMentions: 0 };
    const readEvidence = db.query<{ role: string; source_kind: string }, [string]>("SELECT s.role,s.source_kind FROM memory_evidence e JOIN memory_chunk_sources s ON s.source_id=e.source_id WHERE e.node_id=?");
    for (const row of db.query<{ id: string; type: string; label_original: string; properties: string }, []>("SELECT id,type,label_original,properties FROM memory_nodes ORDER BY id").iterate()) {
      if (["entity", "project", "episode"].includes(row.type)) continue;
      const properties = JSON.parse(row.properties || "{}");
      const origin = sourceClass(readEvidence.all(row.id));
      // Legacy goal/assertion does not distinguish a command from a desired outcome.
      const speechAct = row.type === "goal" || !properties.speech_act ? "unknown" : properties.speech_act;
      insertClaim(db, row.id, {
        statement: properties.statement ?? row.label_original, speech_act: speechAct,
        basis: properties.basis ?? "inference", polarity: properties.polarity ?? "unspecified",
        condition: properties.condition ?? null, requirement: properties.requirement,
        valid_from: properties.valid_from ?? null, valid_to: properties.valid_to ?? null,
        salience: properties.salience ?? "unspecified",
      }, origin);
      counts.claims++; counts.unknownSpeechActs += Number(speechAct === "unknown");
      counts.mixedOrigins += Number(origin === "mixed"); counts.missingProperties += Number(!properties.statement);
    }
    db.exec("ALTER TABLE memory_nodes DROP COLUMN properties");
    const index = backfillSourceIndex(db, sourceRoot);
    if (index.remaining || index.failures.length) throw new Error(`memory_migration_source_unavailable:${index.remaining}`);
    for (const row of db.query<{ node_id: string; source_id: string; surface: string; text: string; byte_start: number }, []>(`
      SELECT a.node_id,a.source_id,a.surface_original surface,t.text,s.byte_start
      FROM memory_aliases a JOIN memory_nodes n ON n.id=a.node_id
      JOIN memory_source_text t ON t.source_id=a.source_id JOIN memory_chunk_sources s ON s.source_id=a.source_id
      WHERE n.type IN ('entity','project') ORDER BY a.node_id,a.source_id,a.surface_original`).iterate()) {
      recordMention(db, row.node_id, row.source_id, row.surface, row.text, 0);
      if (row.text.includes(row.surface)) counts.literalMentions++; else counts.inferredMentions++;
    }
    // Ownership is filled only for unambiguously created nodes, never legacy reused identities.
    for (const row of db.query<{ window_ref: string; normalized_plan_json: string; output_json: string }, []>("SELECT window_ref,normalized_plan_json,output_json FROM memory_projection_windows WHERE normalized_plan_json IS NOT NULL AND output_json IS NOT NULL").iterate()) {
      const plan = JSON.parse(row.normalized_plan_json), output = JSON.parse(row.output_json);
      for (const item of [...(output.nodes ?? []), ...(output.claims ?? [])]) {
        if (item.resolution?.kind === "create" && plan.refs?.[item.local_ref]) db.query("UPDATE memory_nodes SET window_ref=? WHERE id=? AND window_ref IS NULL").run(row.window_ref, plan.refs[item.local_ref]);
      }
    }
    db.query("INSERT OR REPLACE INTO memory_state(key,value) VALUES('source_graph_schema','3')").run();
    installAndBackfillRecallIndexes(db);
    const after = migrationFingerprints(db);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("memory_migration_preservation_failed");
    if (db.query("PRAGMA foreign_key_check").all().length) throw new Error("memory_migration_foreign_key_failed");
    return { migrated: true, ...counts, index, modelCalls: 0, preserved: after };
  })();
  return report;
}
