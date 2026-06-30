import type { TurnLocalWorkOutcome } from "../../agent/work/work-stream.ts";
import type { TurnState } from "./protocol.ts";

export function turnLocalWorkOutcomeForAppTurn(
  state: TurnState,
): TurnLocalWorkOutcome | null {
  if (state === "delivered") return "completed";
  if (state === "failed" || state === "runtime_fault") return "failed";
  if (state === "cancelled") return "cancelled";
  return null;
}

export function turnLocalWorkOutcomeStatusNote(
  outcome: TurnLocalWorkOutcome,
): string {
  if (outcome === "completed") return "Reconciled after delivered turn replay.";
  if (outcome === "failed") return "Reconciled after failed turn replay.";
  if (outcome === "cancelled") return "Reconciled after cancelled turn replay.";
  if (outcome === "waiting_user") return "Reconciled waiting turn replay.";
  return "Reconciled recoverable turn replay.";
}
