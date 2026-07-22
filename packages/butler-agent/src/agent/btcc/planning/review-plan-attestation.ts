import { requireRecord, requireString, type ContentRef } from "../core/index.ts";
import type { PlanningCandidate } from "./contracts.ts";

export function attestReviewedPlanReferences(
  submission: Record<string, unknown>,
  candidate: PlanningCandidate,
): void {
  attestExactRefs(
    submission.reviewedEffectIntentRefs,
    candidate.effectIntents.map((item) => item.ref),
    "EffectIntent",
  );
  attestExactRefs(
    submission.reviewedIntegrationCriterionRefs,
    candidate.integrationCriteria.map((item) => item.ref),
    "IntegrationCriterion",
  );
}

function attestExactRefs(value: unknown, expected: ContentRef[], label: string): void {
  if (!Array.isArray(value)) throw new Error(`Planning Review ${label} refs must be an array`);
  const actual = value.map((item, index) => {
    const ref = requireRecord(item, `${label}[${index}]`);
    return {
      id: requireString(ref.id, `${label}[${index}].id`),
      sha256: requireString(ref.sha256, `${label}[${index}].sha256`),
    };
  });
  const identities = actual.map((ref) => `${ref.id}\0${ref.sha256}`);
  if (new Set(identities).size !== identities.length) {
    throw new Error(`Planning Review ${label} refs contain duplicates`);
  }
  const expectedIdentities = new Set(expected.map((ref) => `${ref.id}\0${ref.sha256}`));
  if (
    identities.length !== expectedIdentities.size ||
    identities.some((identity) => !expectedIdentities.has(identity))
  ) {
    throw new Error(`Planning Review ${label} refs do not match the exact candidate set`);
  }
}
