import type { BtccPersistenceTypes } from "../../../btcc/index.ts";

type ManagedTurnState = BtccPersistenceTypes["managedTurnState"];
type TurnSemanticState = BtccPersistenceTypes["semanticState"];

export function checkpointKind(state: TurnSemanticState): "runtime" | "phase" {
  return state === "work_frontier" || state === "delivery_committed" ? "runtime" : "phase";
}

export function persistedManagedState(managed: ManagedTurnState): ManagedTurnState {
  if (!managed.program) return managed;
  const phaseState = { ...managed };
  delete phaseState.program;
  return { ...phaseState, programId: managed.program.programId };
}
