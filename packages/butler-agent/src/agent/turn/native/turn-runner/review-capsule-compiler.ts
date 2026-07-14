import { createHash } from "crypto";
import type { PublicWebEvidenceItem } from "../../../output/evidence/public-web-evidence.ts";

export const REVIEW_CAPSULE_SCHEMA = "butler.review-capsule.v1" as const;

export interface ReviewArtifactSpan {
  span_id: string;
  utf8_start: number;
  utf8_end: number;
  text: string;
}

export interface GroundingReviewCapsule {
  schema_version: typeof REVIEW_CAPSULE_SCHEMA;
  capsule_id: string;
  gate_kind: "grounding";
  user_request_spans: ReviewArtifactSpan[];
  candidate_spans: ReviewArtifactSpan[];
  evidence_revision: string;
  evidence_items: PublicWebEvidenceItem[];
  successful_searches: number;
  search_result_count: number;
  successful_reads: number;
  coverage: {
    required_span_ids: string[];
    evidence_item_ids: string[];
  };
}

export function compileGroundingReviewCapsule(input: {
  userText: string;
  candidateText: string;
  evidenceRevision: string;
  evidenceItems: PublicWebEvidenceItem[];
  successfulSearches: number;
  searchResultCount: number;
  successfulReads: number;
}): { capsule: GroundingReviewCapsule; prompt: string; utf8Bytes: number } {
  const requestSpan = wholeSpan("request:0", input.userText);
  const candidateSpan = wholeSpan("candidate:0", input.candidateText);
  const evidenceItems = orderedEvidence(input.candidateText, input.evidenceItems);
  const capsuleWithoutId = {
    schema_version: REVIEW_CAPSULE_SCHEMA,
    gate_kind: "grounding" as const,
    user_request_spans: [requestSpan],
    candidate_spans: [candidateSpan],
    evidence_revision: input.evidenceRevision,
    evidence_items: evidenceItems,
    successful_searches: input.successfulSearches,
    search_result_count: input.searchResultCount,
    successful_reads: input.successfulReads,
    coverage: {
      required_span_ids: [requestSpan.span_id, candidateSpan.span_id],
      evidence_item_ids: evidenceItems.map((item) => item.evidence_item_id),
    },
  };
  const capsule: GroundingReviewCapsule = {
    ...capsuleWithoutId,
    capsule_id: `review-capsule-${sha256(JSON.stringify(capsuleWithoutId)).slice(0, 24)}`,
  };
  const prompt = groundingReviewPrompt(capsule);
  return { capsule, prompt, utf8Bytes: Buffer.byteLength(prompt, "utf8") };
}

function groundingReviewPrompt(capsule: GroundingReviewCapsule): string {
  return [
    "Independently review whether the candidate answer is grounded in the bounded public evidence.",
    "Do not call tools. Judge only the exact request, candidate, and immutable evidence revision in this capsule.",
    "Extract each material factual claim. Mark it direct, corroborated, or unsupported and cite only supplied evidence_item_ids.",
    "Use corroborated only when at least two independent source identities support the claim.",
    "A limited answer may be safe when it clearly reports no result or insufficient evidence and makes no unsupported factual claim.",
    "candidate_safe_to_deliver must be false when any material claim is unsupported.",
    "Choose gather_more_evidence only when another public read/search can materially improve support; otherwise choose rewrite_with_limitations.",
    "The runtime validates structure and provenance but does not re-decide semantic support.",
    "Execution prompt, persona, memory, conversation, tools, audit, and round journal are intentionally excluded.",
    "",
    `review_capsule:\n${JSON.stringify(capsule)}`,
  ].join("\n");
}

function wholeSpan(spanId: string, text: string): ReviewArtifactSpan {
  return {
    span_id: spanId,
    utf8_start: 0,
    utf8_end: Buffer.byteLength(text, "utf8"),
    text,
  };
}

function orderedEvidence(
  candidateText: string,
  items: PublicWebEvidenceItem[],
): PublicWebEvidenceItem[] {
  const unique = [...new Map(items.map((item) => [item.evidence_item_id, item])).values()];
  return unique.sort((left, right) => {
    const leftCited = candidateText.includes(left.source_url) ? 0 : 1;
    const rightCited = candidateText.includes(right.source_url) ? 0 : 1;
    return leftCited - rightCited || left.evidence_item_id.localeCompare(right.evidence_item_id);
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
