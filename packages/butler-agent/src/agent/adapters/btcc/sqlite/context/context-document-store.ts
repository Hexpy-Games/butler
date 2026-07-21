import type { Database } from "bun:sqlite";
import { digest } from "../identity.ts";

export type ContextProjectionClass =
  | "profile"
  | "recent_feedback"
  | "mandatory_hot_cache"
  | "optional_hot_cache";

export type ContextDocumentInput = {
  scopeKind: "project" | "session" | "user";
  scopeId: string;
  projectionClass: ContextProjectionClass;
  sourceId: string;
  sourceRevision: string;
  content: string;
};

export class SqliteContextDocumentStore {
  constructor(private readonly db: Database) {}

  persist(input: ContextDocumentInput): string {
    const contentSha256 = digest(input.content);
    const contextRef = digest([
      "btcc-context-document.v1",
      input.scopeKind,
      input.scopeId,
      input.projectionClass,
      input.sourceId,
      input.sourceRevision,
      contentSha256,
    ].join("\0"));
    this.db.query(`
      INSERT OR IGNORE INTO btcc_context_documents (
        context_ref, content_sha256, scope_kind, scope_id, projection_class,
        source_id, source_revision, content, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      contextRef,
      contentSha256,
      input.scopeKind,
      input.scopeId,
      input.projectionClass,
      input.sourceId,
      input.sourceRevision,
      input.content,
      new Date().toISOString(),
    );
    return contextRef;
  }

  resolve(contextRef: string): string {
    const row = this.db.query<{ content: string; content_sha256: string }, [string]>(`
      SELECT content, content_sha256
      FROM btcc_context_documents
      WHERE context_ref = ?
    `).get(contextRef);
    if (!row || digest(row.content) !== row.content_sha256) {
      throw new Error(`BTCC context document is unavailable or corrupt: ${contextRef}`);
    }
    return row.content;
  }
}
