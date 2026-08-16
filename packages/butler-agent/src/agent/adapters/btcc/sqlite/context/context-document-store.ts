import type { Database } from "bun:sqlite";
import { digest } from "../identity.ts";
import type {
  ContextDocumentRead,
  ContextProjectionClass,
  ContextScopeKind,
} from "../../../../context/context-projection.ts";

export type { ContextProjectionClass } from "../../../../context/context-projection.ts";

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

  read(contextRef: string): ContextDocumentRead {
    const row = this.db.query<{
      context_ref: string;
      content_sha256: string;
      scope_kind: string;
      scope_id: string;
      projection_class: string;
      source_id: string;
      source_revision: string;
      content: string;
    }, [string]>(`
      SELECT context_ref, content_sha256, scope_kind, scope_id,
             projection_class, source_id, source_revision, content
      FROM btcc_context_documents
      WHERE context_ref = ?
    `).get(contextRef);
    if (!row || !isSha256(contextRef) || row.context_ref !== contextRef ||
        !isSha256(row.content_sha256) || digest(row.content) !== row.content_sha256 ||
        !isProjectionClass(row.projection_class) || !isScopeKind(row.scope_kind) ||
        !isBoundedPublicIdentity(row.source_id) ||
        !isBoundedPublicIdentity(row.source_revision)) {
      throw new Error("btcc_context_document_identity_invalid");
    }
    const expectedRef = digest([
      "btcc-context-document.v1",
      row.scope_kind,
      row.scope_id,
      row.projection_class,
      row.source_id,
      row.source_revision,
      row.content_sha256,
    ].join("\0"));
    if (expectedRef !== contextRef) {
      throw new Error("btcc_context_document_identity_invalid");
    }
    return {
      contextRef,
      contentSha256: row.content_sha256,
      sourceId: row.source_id,
      projectionClass: row.projection_class,
      scopeKind: row.scope_kind,
      sourceRevision: row.source_revision,
      content: row.content,
    };
  }
}

const PROJECTION_CLASSES = new Set<ContextProjectionClass>([
  "profile", "recent_feedback", "mandatory_hot_cache", "optional_hot_cache",
]);
const SCOPE_KINDS = new Set<ContextScopeKind>(["user", "session", "project"]);

function isProjectionClass(value: string): value is ContextProjectionClass {
  return PROJECTION_CLASSES.has(value as ContextProjectionClass);
}

function isScopeKind(value: string): value is ContextScopeKind {
  return SCOPE_KINDS.has(value as ContextScopeKind);
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function isBoundedPublicIdentity(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/u.test(value);
}
