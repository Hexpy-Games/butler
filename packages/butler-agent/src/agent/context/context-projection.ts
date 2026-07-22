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
