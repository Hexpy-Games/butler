import type { WorkTurnScope } from "../../../btcc/work/index.ts";
import type { GuidedWorkRow } from "./guided-work-records.ts";

export function guidedWorkMatchesScope(
  work: GuidedWorkRow,
  scope: WorkTurnScope,
): boolean {
  if (work.session_id !== scope.sessionId) return false;
  return scope.projectRef === undefined
    ? work.scope_kind === "session" && work.scope_ref === scope.sessionId
    : work.scope_kind === "project" && work.scope_ref === scope.projectRef;
}
