import type { PrincipalAuthority } from "../authority/index.ts";
import { deriveUncertainAuthorityOutcomeReceipt } from "../authority/index.ts";
import type { GuidedEffectOutcome } from "../effects/index.ts";

type NonAppliedGuidedEffectOutcome = Extract<
  GuidedEffectOutcome,
  { ok: false }
>;

type NonAppliedAuthorityIdentity = {
  requestRef: string;
  ownerSessionId: string;
  sourceWorkId: string;
};

export function settleNonAppliedAuthorityOutcome(
  authority: PrincipalAuthority,
  identity: NonAppliedAuthorityIdentity,
  outcome: NonAppliedGuidedEffectOutcome,
): boolean {
  if (outcome.status === "rejected" || outcome.status === "failed") {
    authority.recordOutcome({
      requestRef: identity.requestRef,
      ownerSessionId: identity.ownerSessionId,
      sourceWorkId: identity.sourceWorkId,
      status: "failed",
    });
    return true;
  }
  if (!outcome.evidence) return false;
  const receipt = deriveUncertainAuthorityOutcomeReceipt(outcome.evidence);
  if (!receipt) return false;
  authority.recordOutcome({
    requestRef: identity.requestRef,
    ownerSessionId: identity.ownerSessionId,
    sourceWorkId: identity.sourceWorkId,
    status: "uncertain",
    receipt,
  });
  return true;
}
