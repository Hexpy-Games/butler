import type { OpeningContext, PhaseEnvelope } from "../../core/index.ts";
import type {
  OpeningAnswerSubmission,
  PersonalizationApplication,
  PublicClaim,
} from "./contracts.ts";

export function decodeOpeningAnswer(value: unknown, envelope: PhaseEnvelope) {
  const submitted = decodeStructuredAnswer(value);
  const route = submitted.kind === "direct_answer" ? "direct" : "assisted";
  const admittedPersonalizationRefs = collectPersonalizationRefs(envelope.context);
  const personalizationApplications = admitPersonalization(
    submitted.personalizationApplications,
    admittedPersonalizationRefs,
  );
  const publicClaims = admitPublicClaimSources(submitted.publicClaims, envelope);
  const answer = {
    ...submitted,
    personalizationApplications,
    publicClaims,
  };
  const personalizationRefs = answer.personalizationApplications.map(({ ref }) => ref);
  return { answer, route, personalizationRefs } as const;
}

function decodeStructuredAnswer(value: unknown): OpeningAnswerSubmission {
  if (
    !isRecord(value) ||
    (value.kind !== "direct_answer" &&
      value.kind !== "assisted_answer" &&
      value.kind !== "local_effect_answer")
  ) {
    throw new Error("Opening submission must be a Direct or Assisted answer");
  }
  if (
    !isNonEmptyString(value.requestObligation) ||
    !isNonEmptyString(value.interpretedIntent) ||
    !isNonEmptyString(value.requiredOutcome) ||
    !isNonEmptyString(value.answer) ||
    !Array.isArray(value.nonGoals) ||
    !value.nonGoals.every(isNonEmptyString) ||
    !Array.isArray(value.personalizationApplications) ||
    !Array.isArray(value.publicClaims) ||
    (value.requiredOutcomeResolution !== "fulfilled" &&
      value.requiredOutcomeResolution !== "truthfully_limited") ||
    (value.kind === "direct_answer" && value.requiredResultKind !== "response_content") ||
    (value.kind === "assisted_answer" &&
      value.requiredResultKind !== "current_observation" &&
      value.requiredResultKind !== "turn_local_effect") ||
    (value.kind === "local_effect_answer" &&
      (value.requiredResultKind !== "turn_local_effect" || !isLocalEffect(value.effect)))
  ) {
    throw new Error("Opening answer has an invalid structured product");
  }
  const personalizationApplications = value.personalizationApplications.map(
    decodePersonalizationApplication,
  );
  const publicClaims = value.publicClaims.map(decodePublicClaim);
  const requiredOutcomeResolution: OpeningAnswerSubmission["requiredOutcomeResolution"] =
    value.requiredOutcomeResolution === "fulfilled"
    ? "fulfilled"
    : "truthfully_limited";
  const fields = {
    requestObligation: value.requestObligation,
    interpretedIntent: value.interpretedIntent,
    requiredOutcome: value.requiredOutcome,
    requiredOutcomeResolution,
    nonGoals: value.nonGoals,
    answer: value.answer,
    personalizationApplications,
    publicClaims,
  };
  if (value.kind === "direct_answer") {
    return { kind: "direct_answer", requiredResultKind: "response_content", ...fields };
  }
  if (value.kind === "local_effect_answer") {
    return {
      kind: "local_effect_answer",
      requiredResultKind: "turn_local_effect",
      effect: requireLocalEffect(value.effect),
      ...fields,
    };
  }
  return {
    kind: "assisted_answer",
    requiredResultKind: value.requiredResultKind === "turn_local_effect"
      ? "turn_local_effect"
      : "current_observation",
    ...fields,
  };
}

function isLocalEffect(value: unknown): value is {
  capabilityRef: string;
  publicTitle: string;
  input: Record<string, unknown>;
} {
  return isRecord(value) &&
    isNonEmptyString(value.capabilityRef) &&
    isNonEmptyString(value.publicTitle) &&
    value.publicTitle.length <= 120 &&
    isRecord(value.input) &&
    Object.keys(value.input).length > 0;
}

function requireLocalEffect(value: unknown) {
  if (!isLocalEffect(value)) throw new Error("Opening local effect is invalid");
  return value;
}

function decodePublicClaim(value: unknown): PublicClaim {
  if (!isRecord(value) || !isNonEmptyString(value.claim) || !Array.isArray(value.sourceRefs)) {
    throw new Error("Opening public claim is invalid");
  }
  return {
    claim: value.claim,
    sourceRefs: value.sourceRefs.map((source) => {
      if (!isRecord(source) || !isNonEmptyString(source.id) || !isNonEmptyString(source.sha256)) {
        throw new Error("Opening public claim source is invalid");
      }
      return { id: source.id, sha256: source.sha256 };
    }),
  };
}

function decodePersonalizationApplication(value: unknown): PersonalizationApplication {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.ref) ||
    (value.decision !== "applied" && value.decision !== "not_applicable")
  ) {
    throw new Error("Opening personalization application is invalid");
  }
  return { ref: value.ref, decision: value.decision };
}

function admitPublicClaimSources(
  claims: PublicClaim[],
  envelope: PhaseEnvelope,
): PublicClaim[] {
  const observations = new Map(
    successfulObservations(envelope)
      .map(({ observationRef }) => [observationRef.id, observationRef.sha256]),
  );
  return claims.map((claim) => ({
    ...claim,
    sourceRefs: claim.sourceRefs.filter(
      (ref) => observations.get(ref.id) === ref.sha256,
    ),
  }));
}

function collectPersonalizationRefs(context: OpeningContext): string[] {
  return [
    ...context.profileRefs,
    ...context.recentFeedbackRefs,
    ...context.mandatoryHotCacheRefs,
    ...context.optionalHotCacheRefs,
  ];
}

function admitPersonalization(
  applications: OpeningAnswerSubmission["personalizationApplications"],
  admitted: string[],
): OpeningAnswerSubmission["personalizationApplications"] {
  const admittedRefs = new Set(admitted);
  const seen = new Set<string>();
  return applications.filter(({ ref }) => {
    if (!admittedRefs.has(ref) || seen.has(ref)) return false;
    seen.add(ref);
    return true;
  });
}

function successfulObservations(envelope: PhaseEnvelope) {
  return envelope.operationResults.filter(({ outcome }) => outcome === "observed");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
