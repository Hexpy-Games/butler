import type { ParentInputSink, SubsessionDelegationStore } from "./contracts.ts";

/** Replays only persisted pending obligations through the existing App queue. */
export async function recoverPendingParentInputs(input: {
  store: SubsessionDelegationStore;
  sink: ParentInputSink;
}): Promise<{ attempted: number; delivered: number }> {
  const pending = input.store.pendingParentInputs();
  let delivered = 0;
  for (const parentInput of pending) {
    if (parentSubsessionIsTerminal(input.store, parentInput.parent_session_id)) {
      input.store.markParentInputDelivered(parentInput.result_id);
      delivered += 1;
      continue;
    }
    // Startup readiness is only true after the durable obligation is handed
    // off and marked delivered.  A failed handoff must reject readiness so a
    // later process restart retries the still-pending row; swallowing the
    // error would make the composition look ready while losing the wake-up.
    await input.sink(parentInput);
    input.store.markParentInputDelivered(parentInput.result_id);
    delivered += 1;
  }
  return { attempted: pending.length, delivered };
}

export function parentSubsessionIsTerminal(
  store: SubsessionDelegationStore,
  parentSessionId: string,
): boolean {
  const parentRelation = store.relationByChildSessionId(parentSessionId);
  return Boolean(
    parentRelation && store.resultByRelationId(parentRelation.relation_id),
  );
}
