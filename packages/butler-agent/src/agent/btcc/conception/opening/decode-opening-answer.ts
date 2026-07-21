import type { OpeningContext, PhaseEnvelope } from "../../core/index.ts";
import type {
  OpeningAnswerSubmission,
  PersonalizationApplication,
  PublicClaim,
} from "./contracts.ts";

export function decodeOpeningAnswer(value: unknown, envelope: PhaseEnvelope) {
  const answer = decodeStructuredAnswer(value);
  const route = answer.kind === "assisted_answer" ? "assisted" : "direct";
  assertRouteConversation(route, envelope);
  const personalizationRefs = collectPersonalizationRefs(envelope.context);
  assertExactPersonalization(answer.personalizationApplications, personalizationRefs);
  assertPublicClaimSources(answer.publicClaims, envelope);
  return { answer, route, personalizationRefs } as const;
}

function decodeStructuredAnswer(value: unknown): OpeningAnswerSubmission {
  if (
    !isRecord(value) ||
    (value.kind !== "direct_answer" && value.kind !== "assisted_answer")
  ) {
    throw new Error("Opening submission must be a Direct or Assisted answer");
  }
  if (
    !isNonEmptyString(value.interpretedIntent) ||
    !isNonEmptyString(value.requiredOutcome) ||
    !isNonEmptyString(value.answer) ||
    !Array.isArray(value.nonGoals) ||
    !value.nonGoals.every(isNonEmptyString) ||
    !Array.isArray(value.personalizationApplications) ||
    !Array.isArray(value.publicClaims) ||
    (value.requiredOutcomeResolution !== "fulfilled" &&
      value.requiredOutcomeResolution !== "truthfully_limited")
  ) {
    throw new Error("Opening answer has an invalid structured product");
  }
  const personalizationApplications = value.personalizationApplications.map(
    decodePersonalizationApplication,
  );
  const publicClaims = value.publicClaims.map(decodePublicClaim);
  return {
    kind: value.kind,
    interpretedIntent: value.interpretedIntent,
    requiredOutcome: value.requiredOutcome,
    requiredOutcomeResolution: value.requiredOutcomeResolution,
    nonGoals: value.nonGoals,
    answer: value.answer,
    personalizationApplications,
    publicClaims,
    guard: decodeGuard(
      value.guard,
      personalizationApplications,
      publicClaims,
      value.requiredOutcomeResolution,
    ),
  };
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

function decodeGuard(
  value: unknown,
  applications: OpeningAnswerSubmission["personalizationApplications"],
  publicClaims: OpeningAnswerSubmission["publicClaims"],
  resolution: OpeningAnswerSubmission["requiredOutcomeResolution"],
): OpeningAnswerSubmission["guard"] {
  if (
    !isRecord(value) ||
    value.verdict !== "accepted" ||
    !Array.isArray(value.personalizationVerdicts) ||
    !Array.isArray(value.publicClaimVerdicts) ||
    (value.responseVerdict !== "responsive" && value.responseVerdict !== "truthfully_limited")
  ) {
    throw new Error("Opening output guard is invalid");
  }
  const expectedResponseVerdict = resolution === "fulfilled" ? "responsive" : "truthfully_limited";
  if (value.responseVerdict !== expectedResponseVerdict) {
    throw new Error("Opening output guard does not match outcome coverage");
  }
  const personalizationVerdicts = value.personalizationVerdicts.map((item) => {
    if (!isRecord(item) || !isNonEmptyString(item.ref) ||
      item.verdict !== "faithful_and_public_safe") {
      throw new Error("Opening personalization guard verdict is invalid");
    }
    return { ref: item.ref, verdict: "faithful_and_public_safe" as const };
  });
  if (!sameArray(
    personalizationVerdicts.map(({ ref }) => ref),
    applications.map(({ ref }) => ref),
  )) {
    throw new Error("Opening output guard subjects do not match personalization applications");
  }
  const publicClaimVerdicts = value.publicClaimVerdicts.map((item) => {
    if (!isRecord(item) || !Number.isInteger(item.claimIndex) ||
      item.verdict !== "supported_or_not_observation_dependent") {
      throw new Error("Opening public claim guard verdict is invalid");
    }
    return {
      claimIndex: item.claimIndex as number,
      verdict: "supported_or_not_observation_dependent" as const,
    };
  });
  if (!sameArray(
    publicClaimVerdicts.map(({ claimIndex }) => claimIndex),
    publicClaims.map((_, index) => index),
  )) {
    throw new Error("Opening output guard subjects do not match public claims");
  }
  return {
    responseVerdict: value.responseVerdict,
    personalizationVerdicts,
    publicClaimVerdicts,
    verdict: "accepted",
  };
}

function assertRouteConversation(route: "direct" | "assisted", envelope: PhaseEnvelope): void {
  if (route === "direct" && envelope.operationResults.length !== 0) {
    throw new Error("BTCC Direct answer cannot follow an Assisted observation");
  }
  if (route === "assisted" && envelope.operationResults.length === 0) {
    throw new Error("BTCC Assisted answer requires an admitted observation");
  }
}

function assertPublicClaimSources(claims: PublicClaim[], envelope: PhaseEnvelope): void {
  const observations = new Map(
    envelope.operationResults.map(({ observationRef }) => [observationRef.id, observationRef.sha256]),
  );
  for (const claim of claims) {
    for (const ref of claim.sourceRefs) {
      if (observations.get(ref.id) !== ref.sha256) {
        throw new Error("Opening public claim cites an unavailable observation");
      }
    }
  }
  if (claims.length !== 0 && envelope.operationResults.length !== 0 &&
    claims.some((claim) => claim.sourceRefs.length === 0)) {
    throw new Error("Opening observation-dependent answer has an uncited public claim");
  }
}

function collectPersonalizationRefs(context: OpeningContext): string[] {
  return [
    ...context.profileRefs,
    ...context.recentFeedbackRefs,
    ...context.mandatoryHotCacheRefs,
    ...context.optionalHotCacheRefs,
  ];
}

function assertExactPersonalization(
  applications: OpeningAnswerSubmission["personalizationApplications"],
  expected: string[],
): void {
  const actual = applications.map(({ ref }) => ref);
  if (new Set(actual).size !== actual.length || !sameArray(actual, expected)) {
    throw new Error("Opening answer did not account for the exact Butler context");
  }
}

function sameArray(left: unknown[], right: unknown[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
