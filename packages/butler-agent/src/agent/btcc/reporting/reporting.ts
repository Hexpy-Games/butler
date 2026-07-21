import type { PhaseInvocation } from "../core/index.ts";
import { withPhaseState } from "../core/index.ts";
import {
  requireManagedState,
  type TurnEvent,
  type TurnRecord,
} from "../turn/index.ts";
import { prepareReport } from "./prepare-report.ts";

export async function reporting(command: {
  turn: TurnRecord;
  phase: PhaseInvocation;
}): Promise<Extract<TurnEvent, { kind: "PreparedReportAccepted" }>> {
  if (command.turn.semanticState !== "reporting") {
    throw new Error(`Reporting cannot advance ${command.turn.semanticState}`);
  }
  const product = await prepareReport(withPhaseState(command.phase, {
    finalDossier: requireManagedState(command.turn).finalDossier,
  }));
  return { kind: "PreparedReportAccepted", product };
}
