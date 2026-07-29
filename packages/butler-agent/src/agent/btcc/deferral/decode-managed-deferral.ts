import {
  contentRef,
  requireRecord,
  requireString,
  turnAccessMode,
  type PhaseCodec,
  type PhaseEnvelope,
} from "../core/index.ts";
import type {
  ManagedDeferralContext,
  ManagedDeferralProduct,
  ManagedReadinessCondition,
  PromotionDeferralProduct,
} from "./contracts.ts";
import {
  withManagedDeferralSchema,
  withTaskExecutionDeferralSchema,
} from "./submission-schema.ts";

export function withManagedDeferral<Product>(
  phaseCodec: PhaseCodec<Product>,
): PhaseCodec<Product | ManagedDeferralProduct> {
  return {
    submissionSchema: withManagedDeferralSchema(phaseCodec.submissionSchema),
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
    submissionSchema: withTaskExecutionDeferralSchema(phaseCodec.submissionSchema),
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
  const readiness = decodeReadiness(submission.readiness, envelope);
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

function decodeReadiness(
  value: unknown,
  envelope: PhaseEnvelope,
): ManagedReadinessCondition {
  const readiness = requireRecord(value, "Managed deferral readiness");
  if (readiness.kind === "user_authority") {
    const requiredAuthorityScopeRefs = requireNonEmptyStrings(
      readiness.requiredAuthorityScopeRefs,
      "requiredAuthorityScopeRefs",
    );
    rejectAuthorityAlreadyGranted(requiredAuthorityScopeRefs, envelope);
    return {
      kind: "user_authority",
      requiredAuthorityScopeRefs,
    };
  }
  if (readiness.kind === "external_readiness") {
    const observationScopeRefs = requireNonEmptyStrings(
      readiness.observationScopeRefs,
      "observationScopeRefs",
    );
    if (
      envelope.phase === "task_execution" &&
      observationScopeRefs.some((scopeRef) =>
        envelope.operationAuthority.observationScopeRefs.includes(scopeRef),
      )
    ) {
      throw new Error(
        "Task Execution external readiness names ordinary admitted observation authority",
      );
    }
    return {
      kind: "external_readiness",
      observationScopeRefs,
      currentObservationRefs: currentObservationRefs(observationScopeRefs, envelope),
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

function rejectAuthorityAlreadyGranted(
  requiredScopeRefs: string[],
  envelope: PhaseEnvelope,
): void {
  if (turnAccessMode(envelope) !== "full_access") return;
  const admittedScopes = new Set(envelope.context.baselineObservationScopeRefs);
  const alreadyGranted = requiredScopeRefs.filter((scopeRef) => admittedScopes.has(scopeRef));
  if (alreadyGranted.length === 0) return;
  throw new Error(
    "user_authority names a scope already granted by the full-access Turn; " +
      "revise the internal Plan or Task authority",
  );
}

function currentObservationRefs(
  scopeRefs: readonly string[],
  envelope: PhaseEnvelope,
) {
  const refs = scopeRefs.flatMap((scopeRef) => {
    const result = envelope.operationResults.find((candidate) =>
      candidate.request.kind === "observe" &&
      candidate.request.scopeRef === scopeRef &&
      candidate.outcome === "observed",
    );
    if (!result) {
      throw new Error(
        `Managed external readiness lacks a current observation for scope: ${scopeRef}`,
      );
    }
    return [result.observationRef];
  });
  return refs.filter((ref, index) =>
    refs.findIndex((candidate) =>
      candidate.id === ref.id && candidate.sha256 === ref.sha256,
    ) === index,
  );
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
