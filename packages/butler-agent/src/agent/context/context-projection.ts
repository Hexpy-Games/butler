export type ContextProjectionClass =
  | "profile"
  | "recent_feedback"
  | "mandatory_hot_cache"
  | "optional_hot_cache";

export type ContextScopeKind = "user" | "session" | "project";

export type ContextProjection = {
  projectionClass: ContextProjectionClass;
  scopeKind: ContextScopeKind;
};

export type ContextDocumentRead = {
  contextRef: string;
  contentSha256: string;
  sourceId: string;
  projectionClass: ContextProjectionClass;
  scopeKind: ContextScopeKind;
  sourceRevision: string;
  content: string;
};

export interface ContextDocumentReader {
  resolve(contextRef: string): string;
  read(contextRef: string): ContextDocumentRead;
}

export type PhaseScopedMemoryProjectionErrorCode =
  | "phase_scoped_memory_dependency_missing"
  | "phase_scoped_memory_document_invalid"
  | "phase_scoped_memory_projection_too_large"
  | "phase_scoped_memory_serializer_failed";

export class PhaseScopedMemoryProjectionError extends Error {
  constructor(
    readonly code: PhaseScopedMemoryProjectionErrorCode,
    options?: { cause?: unknown },
  ) {
    super(code, options);
    this.name = "PhaseScopedMemoryProjectionError";
  }
}

export function isPhaseScopedMemoryProjectionError(
  error: unknown,
): error is PhaseScopedMemoryProjectionError {
  return error instanceof PhaseScopedMemoryProjectionError;
}
