export function resolveSubsessionAuthorityOwner(input: {
  sourceSessionId: string;
  relationForChild(sessionId: string): { parent_session_id: string } | null;
}): string {
  let currentSessionId = input.sourceSessionId;
  const visited = new Set<string>();
  while (true) {
    if (visited.has(currentSessionId)) {
      throw new Error("subsession_authority_relation_cycle");
    }
    visited.add(currentSessionId);
    const relation = input.relationForChild(currentSessionId);
    if (!relation) return currentSessionId;
    currentSessionId = relation.parent_session_id;
  }
}
