import type {
  DurableWorkService,
  DurableWorkView,
  WorkTurnScope,
} from "../work/index.ts";
import { dispositionMaterialFingerprint } from "../work/index.ts";
import {
  safeBoundWork,
  safeRecordCloseoutMissing,
} from "./guided-work-runtime.ts";

type GuidedTurnCloseoutInput = {
  durableWork: DurableWorkService;
  workScope: WorkTurnScope;
  turnId: string;
  trackingMode: "ledger" | "local" | "none";
};

type GuidedTurnCloseoutReview =
  | { status: "accepted" }
  | { status: "continue"; observation: string };

/**
 * A disposition is a closeout declaration only while it still describes the
 * current durable Work snapshot.  Result/checkpoint/review/action/effect
 * writes change the material fingerprint, so a same-Turn declaration cannot
 * silently settle a Work after later progress.
 */
export function isFreshCurrentDisposition(
  work: DurableWorkView | null,
  turnId: string,
): boolean {
  if (!work || work.status === "abandoned") return true;
  const disposition = work.latestDisposition;
  return Boolean(
    disposition &&
    disposition.originTurnId === turnId &&
    disposition.disposition === work.status &&
    disposition.materialFingerprint &&
    disposition.materialFingerprint === dispositionMaterialFingerprint(work),
  );
}

/**
 * Owns the bounded final-candidate reconciliation policy.  A bound Work that
 * has no successful disposition from this Turn gets one extra model
 * opportunity; a still-missing declaration records one idempotent diagnostic
 * without changing Work status or delivery.
 */
export function createGuidedTurnCloseout(input: GuidedTurnCloseoutInput): {
  reviewFinalCandidate(): Promise<GuidedTurnCloseoutReview>;
  recordMissingDiagnostic(): Promise<void>;
} {
  let opportunityUsed = false;
  let diagnosticWorkId: string | undefined;

  return {
    async reviewFinalCandidate() {
      if (opportunityUsed || input.trackingMode === "none") {
        return { status: "accepted" as const };
      }
      const bound = await safeBoundWork(input.durableWork, input.turnId);
      if (!bound || isFreshCurrentDisposition(bound, input.turnId)) {
        return { status: "accepted" as const };
      }
      opportunityUsed = true;
      diagnosticWorkId = bound.workId;
      return {
        status: "continue" as const,
        observation: [
          "Before reporting the final answer, call record_work_disposition for the explicitly bound Work.",
          "Choose completed, open, or blocked with a concise summary and valid action/evidence details, then report.",
        ].join(" "),
      };
    },

    async recordMissingDiagnostic() {
      if (!diagnosticWorkId) return;
      const bound = await safeBoundWork(input.durableWork, input.turnId);
      if (
        bound?.workId === diagnosticWorkId &&
        !isFreshCurrentDisposition(bound, input.turnId)
      ) {
        await safeRecordCloseoutMissing(
          input.durableWork,
          input.workScope,
          diagnosticWorkId,
        );
      }
    },
  };
}
