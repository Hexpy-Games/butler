import { contentRef, type ContentRef } from "../core/index.ts";
import type {
  PromotionPermit,
  ReviewedPromotionAssembly,
} from "./contracts.ts";

export function createPromotionPermit(input: {
  programId: string;
  currentAuthorityRef: ContentRef;
  acceptedPlanRef: ContentRef;
  planningReviewRef: ContentRef;
  assemblies: ReviewedPromotionAssembly[];
}): PromotionPermit | undefined {
  if (input.assemblies.length === 0) return undefined;
  const body = {
    programId: input.programId,
    currentAuthorityRef: input.currentAuthorityRef,
    acceptedPlanRef: input.acceptedPlanRef,
    planningReviewRef: input.planningReviewRef,
    candidateRefs: input.assemblies.map((assembly) => assembly.candidate.ref),
    resolutionRefs: input.assemblies.map((assembly) => assembly.resolution.ref),
    promotionTaskRefs: input.assemblies.map(
      (assembly) => assembly.candidate.promotionTaskRef,
    ),
    basis: "accepted_implementation_and_integration_reviews" as const,
  };
  return { ref: contentRef("promotion-permit", body), ...body };
}

export function assertPromotionPermit(input: {
  programId: string;
  currentAuthorityRef: ContentRef;
  acceptedPlanRef: ContentRef;
  planningReviewRef: ContentRef;
  assemblies: ReviewedPromotionAssembly[];
  permit?: PromotionPermit;
}): void {
  const expected = createPromotionPermit(input);
  if (!sameRef(expected?.ref, input.permit?.ref)) {
    throw new Error("Promotion permit changed its reviewed Work authority");
  }
}

function sameRef(left?: ContentRef, right?: ContentRef): boolean {
  return left?.id === right?.id && left?.sha256 === right?.sha256;
}
