const PUBLIC_DECISION_SOURCES = new Set([
  "assistant-authored",
]);

export function isPublicDecisionSource(source: unknown): source is string {
  return typeof source === "string" && PUBLIC_DECISION_SOURCES.has(source);
}
