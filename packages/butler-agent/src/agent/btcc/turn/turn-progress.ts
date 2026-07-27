import type { BtccTurnProgressObserver } from "../contracts.ts";
import type { OpeningContinuationProduct } from "../conception/index.ts";
import type { OperationalActivation } from "../recovery/index.ts";
import type { TurnRecord } from "./contracts.ts";
import {
  projectWorkProgress,
  retiredWorkProgress,
} from "../work-ledger/index.ts";

export async function publishOpeningDecision(
  observer: BtccTurnProgressObserver | undefined,
  turnId: string,
  turnRevision: number,
  product: OpeningContinuationProduct,
): Promise<void> {
  if (!observer?.openingDecisionAccepted) return;
  try {
    await observer.openingDecisionAccepted({
      turnId,
      turnRevision,
      decisionId: product.projection.ref.id,
      summary: product.projection.summary,
      rationale: product.projection.rationale,
      nextStep: product.projection.nextStep,
    });
  } catch {
    // Projection cannot veto committed semantic truth.
  }
}

export async function publishTurnProgress(
  observer: BtccTurnProgressObserver | undefined,
  turn: TurnRecord,
  previous?: TurnRecord,
): Promise<void> {
  if (!observer) return;
  try {
    const program = turn.managed?.program;
    if (program?.planningState === "reviewed" && observer.workProgressChanged) {
      const previousProgram = previous?.managed?.program;
      const retiredTasks = previousProgram?.planningState === "reviewed"
        ? retiredWorkProgress(previousProgram, program)
        : [];
      await observer.workProgressChanged({
        turnId: turn.turnId,
        turnRevision: turn.revision,
        programId: program.programId,
        tasks: [
          ...retiredTasks,
          ...projectWorkProgress(program, turn.finalDisposition),
        ],
      });
    }
    await observer.stateChanged({
      turnId: turn.turnId,
      semanticState: turn.semanticState,
      turnRevision: turn.revision,
    });
  } catch {
    // Projection cannot veto committed semantic truth.
  }
}

export async function publishOperationalNotice(
  observer: BtccTurnProgressObserver | undefined,
  update: {
    turnId: string;
    semanticState: string;
    status: "recovering" | "interrupted" | "cleared";
    code?: string;
    activationKind?: OperationalActivation["kind"];
  },
): Promise<void> {
  if (!observer?.operationalNoticeChanged) return;
  try {
    await observer.operationalNoticeChanged(update);
  } catch {
    // Projection cannot change durable recovery ownership.
  }
}
