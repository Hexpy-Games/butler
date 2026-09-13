import type { Database } from "bun:sqlite";
import { insertClaim, type ClaimContent } from "../../packages/butler-agent/src/agent/cognition/memory/projection/claim-store.ts";

/** Small database fixtures for search tests; public ingestion is covered separately. */
export function insertMemoryNodeFixture(db: Database, row: { id: string; type: string; label_original: string; identity_scope: string; project_id?: string | null; created_at: string; claim?: string | Partial<ClaimContent> }): void {
  db.query("INSERT INTO memory_nodes(id,type,label_original,identity_scope,project_id,created_at) VALUES(?,?,?,?,?,?)")
    .run(row.id, row.type, row.label_original, row.identity_scope, row.project_id ?? null, row.created_at);
  if (["entity", "project", "episode"].includes(row.type)) return;
  const fields: Partial<ClaimContent> = typeof row.claim === "string" ? JSON.parse(row.claim) : row.claim ?? {};
  insertClaim(db, row.id, { statement: row.label_original, speech_act: "assertion", basis: "user_statement",
    polarity: "unspecified", condition: null, valid_from: null, valid_to: null, salience: "unspecified", ...fields }, "user");
}
