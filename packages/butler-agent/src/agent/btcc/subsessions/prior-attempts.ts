import type { SubsessionDelegationDependencies } from "./contracts.ts";

export type PriorAttempt = { attempt: number; status: string; code: string | null; summary: string };

/** Earlier settled assignments of the same parent Work action, oldest first. */
export function priorWorkerAttempts(
  store: Pick<SubsessionDelegationDependencies["store"], "relationsByParentSessionId" | "packetByRelationId" | "resultByRelationId">,
  input: { parentSessionId: string; parentWorkId: string; actionKey: string },
): PriorAttempt[] {
  return store.relationsByParentSessionId(input.parentSessionId).flatMap((relation) => {
    const packet = store.packetByRelationId(relation.relation_id);
    const result = store.resultByRelationId(relation.relation_id);
    return packet?.parent_work_ref.work_id === input.parentWorkId &&
      packet.plan_action?.action_key === input.actionKey && result ? [result] : [];
  }).sort((left, right) => left.created_at.localeCompare(right.created_at))
    .map((result, index) => ({ attempt: index + 1, status: result.status, code: result.code, summary: result.summary }));
}

export function renderPriorAttempts(attempts: readonly PriorAttempt[]): string[] {
  if (!attempts.length) return [];
  return [
    "prior_attempts: this action was assigned before. Build on these results instead of repeating them:",
    ...attempts.map((item) => `- attempt ${item.attempt}: ${item.status}${item.code ? ` (${item.code})` : ""}: ${item.summary}`),
  ];
}
