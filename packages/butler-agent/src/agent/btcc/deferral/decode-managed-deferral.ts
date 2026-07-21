import {
  contentRef,
  requireRecord,
  requireString,
  type PhaseCodec,
  type PhaseEnvelope,
} from "../core/index.ts";
import type {
  ManagedDeferralContext,
  ManagedDeferralProduct,
  ManagedReadinessCondition,
  PromotionDeferralProduct,
} from "./contracts.ts";

export function withManagedDeferral<Product>(
  phaseCodec: PhaseCodec<Product>,
): PhaseCodec<Product | ManagedDeferralProduct> {
  return {
    decode(submission, envelope) {
      const value = requireRecord(submission, "Managed phase submission");
      return value.kind === "managed_deferral"
        ? decodeManagedDeferral(value, envelope, false)
        : phaseCodec.decode(submission, envelope);
    },
  };
}

export function withTaskExecutionDeferral<Product>(
  phaseCodec: PhaseCodec<Product>,
): PhaseCodec<Product | ManagedDeferralProduct | PromotionDeferralProduct> {
  const managed = withManagedDeferral(phaseCodec);
  return {
    decode(submission, envelope) {
      const value = requireRecord(submission, "Task Execution submission");
      if (value.kind !== "promotion_deferral") {
        return managed.decode(submission, envelope);
      }
      const base = decodeManagedDeferral(
        { ...value, kind: "managed_deferral" },
        envelope,
        true,
      );
      if (
        base.anchor.promotionContext.kind !== "pre_commit_before_transaction" ||
        !base.anchor.currentTaskRef || !base.anchor.currentAttemptRef
      ) {
        throw new Error("Promotion deferral lacks its exact authorized Task context");
      }
      const body = {
        authorizationRef: base.anchor.promotionContext.authorizationRef,
        promotionTaskRef: base.anchor.currentTaskRef,
        attemptRef: base.anchor.currentAttemptRef,
        blockerRef: base.blocker.ref,
        anchorRef: base.anchor.ref,
        preCommit: { kind: "transaction_not_started" as const },
      };
      return {
        kind: "promotion_deferral",
        deferral: { ref: contentRef("promotion-deferral", body), ...body },
        blocker: base.blocker,
        anchor: base.anchor,
      };
    },
  };
}

function decodeManagedDeferral(
  submission: Record<string, unknown>,
  envelope: PhaseEnvelope,
  allowPromotion: boolean,
): ManagedDeferralProduct {
  const state = requireRecord(envelope.context.stateInput, "Managed phase state");
  const context = state.deferralContext as ManagedDeferralContext | undefined;
  if (!context || context.sourceState !== envelope.binding.semanticState) {
    throw new Error("Managed deferral is missing its exact phase context");
  }
  if (!allowPromotion && context.promotionContext.kind !== "not_promotion") {
    throw new Error("Authorized promotion requires a typed promotion deferral");
  }
  const reason = requireString(submission.reason, "Managed deferral reason");
  const readiness = decodeReadiness(submission.readiness);
  const blockerBody = {
    programId: context.programId,
    sourceState: context.sourceState,
    sourceGoalFieldIds: ["request", "intended_result"] as const,
    sourceRequiredOutcomeRefs: [context.requiredOutcomeId] as [string],
    reason,
    readiness,
  };
  const blocker = {
    ref: contentRef("managed-blocker", blockerBody),
    ...blockerBody,
  };
  const anchorBody = {
    ...withoutDeferralFields(context),
    blockerRef: blocker.ref,
  };
  return {
    kind: "managed_deferral",
    blocker,
    anchor: { ref: contentRef("deferral-anchor", anchorBody), ...anchorBody },
  };
}

function decodeReadiness(value: unknown): ManagedReadinessCondition {
  const readiness = requireRecord(value, "Managed deferral readiness");
  if (readiness.kind === "user_authority") {
    return {
      kind: "user_authority",
      requiredAuthorityScopeRefs: requireNonEmptyStrings(
        readiness.requiredAuthorityScopeRefs,
        "requiredAuthorityScopeRefs",
      ),
    };
  }
  if (readiness.kind === "external_readiness") {
    return {
      kind: "external_readiness",
      observationScopeRefs: requireNonEmptyStrings(
        readiness.observationScopeRefs,
        "observationScopeRefs",
      ),
      currentObservationRefs: [],
    };
  }
  if (readiness.kind === "scheduled_time") {
    return {
      kind: "scheduled_time",
      notBefore: requireString(readiness.notBefore, "notBefore"),
    };
  }
  throw new Error("Managed deferral readiness kind is invalid");
}

function requireNonEmptyStrings(
  value: unknown,
  label: string,
): [string, ...string[]] {
  if (
    !Array.isArray(value) || value.length === 0 ||
    !value.every((item) => typeof item === "string" && item.length > 0)
  ) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  return value as [string, ...string[]];
}

function withoutDeferralFields(context: ManagedDeferralContext) {
  const { sourceState: _sourceState, requiredOutcomeId: _outcome, ...anchor } = context;
  return anchor;
}
