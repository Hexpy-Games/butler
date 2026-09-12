import type { Database } from "bun:sqlite";
import type { ExtractOutput } from "./contracts.ts";

export type ClaimContent = Pick<ExtractOutput["claims"][number],
  "statement" | "speech_act" | "basis" | "polarity" | "condition" | "requirement" | "valid_from" | "valid_to" | "salience">;
export type SourceClass = "user" | "assistant" | "task_report" | "explicit" | "mixed" | "unknown";
export type StoredClaim = ClaimContent & { node_id: string; source_class: SourceClass; authority: "model_interpretation" };

export function ensureClaimSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_claims(
      node_id TEXT PRIMARY KEY REFERENCES memory_nodes(id),
      statement TEXT NOT NULL, speech_act TEXT NOT NULL, basis TEXT NOT NULL,
      polarity TEXT NOT NULL, condition TEXT, requirement TEXT,
      valid_from TEXT, valid_to TEXT, salience TEXT NOT NULL,
      source_class TEXT NOT NULL CHECK(source_class IN ('user','assistant','task_report','explicit','mixed','unknown')),
      authority TEXT NOT NULL DEFAULT 'model_interpretation' CHECK(authority='model_interpretation')
    );
    CREATE TABLE IF NOT EXISTS memory_mentions(
      node_id TEXT NOT NULL REFERENCES memory_nodes(id),
      source_id TEXT NOT NULL REFERENCES memory_chunk_sources(source_id),
      byte_start INTEGER, byte_end INTEGER, surface TEXT NOT NULL,
      method TEXT NOT NULL CHECK(method IN ('literal','inferred')),
      CHECK((method='literal' AND byte_start>=0 AND byte_end>byte_start) OR
        (method='inferred' AND byte_start IS NULL AND byte_end IS NULL)),
      PRIMARY KEY(node_id,source_id,surface)
    );
    CREATE TABLE IF NOT EXISTS memory_meaning_commits(
      window_ref TEXT PRIMARY KEY REFERENCES memory_projection_windows(window_ref),
      input_hash TEXT NOT NULL,output_json TEXT NOT NULL,plan_json TEXT NOT NULL,committed_at TEXT NOT NULL
    );
  `);
}

export function sourceClass(rows: Array<{ role: string; source_kind: string }>): SourceClass {
  const classes = new Set<SourceClass>(rows.map((row) => {
    if (row.source_kind === "task_report") return "task_report";
    if (row.source_kind === "explicit_record") return "explicit";
    return row.role === "user" ? "user" : row.role === "assistant" ? "assistant" : "unknown";
  }));
  return classes.size > 1 ? "mixed" : [...classes][0] ?? "unknown";
}

export function readClaim(db: Database, nodeId: string): StoredClaim | null {
  const row = db.query<Omit<StoredClaim, "requirement"> & { requirement: string | null }, [string]>(
    "SELECT * FROM memory_claims WHERE node_id=?",
  ).get(nodeId);
  if (!row) return null;
  return { ...row, requirement: row.requirement === null ? undefined : JSON.parse(row.requirement) };
}

export function insertClaim(db: Database, nodeId: string, content: ClaimContent, origin: SourceClass): void {
  const values = [nodeId, content.statement, content.speech_act, content.basis, content.polarity,
    content.condition, content.requirement ? JSON.stringify(content.requirement) : null,
    content.valid_from, content.valid_to, content.salience, origin] as const;
  const existing = readClaim(db, nodeId);
  if (existing) {
    const normalized = { ...content, requirement: content.requirement ?? undefined };
    for (const key of Object.keys(normalized) as Array<keyof ClaimContent>) {
      if (JSON.stringify(existing[key]) !== JSON.stringify(normalized[key])) throw new Error("memory_claim_changed");
    }
    if (existing.source_class !== origin) throw new Error("memory_claim_origin_changed");
    return;
  }
  db.query(`INSERT INTO memory_claims(node_id,statement,speech_act,basis,polarity,condition,requirement,valid_from,valid_to,salience,source_class)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(...values);
}

export function recordMention(db: Database, nodeId: string, sourceId: string, surface: string, text: string, byteStart: number): void {
  if (!surface) throw new Error("memory_mention_empty");
  const offset = text.indexOf(surface);
  const start = offset < 0 ? null : byteStart + Buffer.byteLength(text.slice(0, offset));
  const end = start === null ? null : start + Buffer.byteLength(surface);
  db.query(`INSERT OR IGNORE INTO memory_mentions(node_id,source_id,byte_start,byte_end,surface,method)
    VALUES(?,?,?,?,?,?)`).run(nodeId, sourceId, start, end, surface, start === null ? "inferred" : "literal");
}
