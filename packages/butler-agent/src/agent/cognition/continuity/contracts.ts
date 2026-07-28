export const CONTINUITY_SCOPES = ["project", "session", "global"] as const;
export type ContinuityScope = typeof CONTINUITY_SCOPES[number];

export const CONTINUITY_KINDS = [
  "instruction",
  "decision",
  "constraint",
  "working_state",
  "preference",
  "correction",
] as const;
export type ContinuityKind = typeof CONTINUITY_KINDS[number];

export const CONTINUITY_OPERATIONS = ["upsert", "supersede", "forget"] as const;
export type ContinuityOperation = typeof CONTINUITY_OPERATIONS[number];

export interface ContinuityUpdate {
  scope: ContinuityScope;
  kind: ContinuityKind;
  operation: ContinuityOperation;
  summary: string;
  target_ref?: string;
}
