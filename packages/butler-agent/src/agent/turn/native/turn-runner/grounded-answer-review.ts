import { createHash } from "crypto";
import { join } from "path";
import type { RuntimeTurnInput } from "../../../../test-support/harness/contracts.ts";
import type { PromptUsageAttribution } from "../../../../integrations/providers/provider.ts";
import {
  addDirectTurnUsage,
  beforeDirectTurnModelRequest,
  directTurnPartitionBudgetState,
  directTurnRequestedOutputTokens,
  type createDirectTurnBudget,
} from "../../direct-turn-budget.ts";
import { writeJsonFileAtomic } from "../../../persistence/atomic-json-store.ts";
import {
  isPublicWebEvidenceItem,
  type PublicWebEvidenceItem,
} from "../../../output/evidence/public-web-evidence.ts";
import {
  TURN_EVIDENCE_RECEIPT_SCHEMA,
  TurnContractStore,
  type CompiledTurnContract,
  type TurnEvidenceReceipt,
} from "../../turn-contract.ts";
import type { ToolAuditEntry } from "../output/tool-types.ts";
import type { NativeTurnRunnerDeps } from "./turn-runner-types.ts";
import {
  readPublicWebEvidenceContextForContract,
  type PublicWebEvidenceAttempt,
} from "../../../output/evidence/public-web-evidence-store.ts";
import { evidenceRevisionFor } from "./final-candidate-review-store.ts";
import { compileGroundingReviewCapsule } from "./review-capsule-compiler.ts";

const GROUNDED_ANSWER_REVIEW_SCHEMA = "butler.grounded-answer-review.v1" as const;
const GROUNDING_REVIEW_REPAIR_LIMIT = 1;

class GroundingReviewStructuredOutputError extends Error {
  readonly code = "grounding_review_structured_output_invalid";
  readonly retryable = true;

  constructor(readonly causeCode: string) {
    super("The grounding reviewer repeatedly returned a structurally invalid evidence binding.");
    this.name = "GroundingReviewStructuredOutputError";
  }
}

class GroundingReviewStructuredTransportError extends Error {
  readonly code = "grounding_review_structured_transport_missing";
  readonly retryable = true;

  constructor() {
    super("The selected provider cannot return the required structured grounding review.");
    this.name = "GroundingReviewStructuredTransportError";
  }
}

type GroundedAnswerReview = {
  schema_version: typeof GROUNDED_ANSWER_REVIEW_SCHEMA;
  outcome: "supported" | "insufficient" | "no_result";
  candidate_safe_to_deliver: boolean;
  next_action: "accept" | "gather_more_evidence" | "rewrite_with_limitations";
  summary: string;
  claims: Array<{
    claim_id: string;
    claim_text: string;
    support: "direct" | "corroborated" | "unsupported";
    evidence_item_ids: string[];
    limitations: string[];
  }>;
  citation_item_ids: string[];
  limitations: string[];
};

export type GroundedAnswerReviewOutcome =
  | { kind: "not_applicable" }
  | { kind: "accepted"; evidenceRefs: string[] }
  | {
      kind: "gap";
      evidenceRefs: string[];
      nextMode: "tool_decision" | "final_synthesis";
      summary: string;
      modelVisibleContent: string;
    };

export async function reviewGroundedAnswerCandidate(input: {
  turnInput: RuntimeTurnInput;
  deps: NativeTurnRunnerDeps;
  turnId?: string | null;
  turnBudget: ReturnType<typeof createDirectTurnBudget>;
  userText: string;
  candidateText: string;
  audit: ToolAuditEntry[];
  contract?: CompiledTurnContract;
}): Promise<GroundedAnswerReviewOutcome> {
  if (input.contract?.action !== "tool_answer") return { kind: "not_applicable" };
  const transport = input.turnInput.provider.capabilities.structuredDecisionTransport;
  if (!transport) throw new GroundingReviewStructuredTransportError();
  const persistedEvidence = readPublicWebEvidenceContextForContract({
      butlerData: input.deps.butlerData,
      contractId: input.contract.contract_id,
    });
  const evidence = evidenceContext(input.audit, persistedEvidence.items, persistedEvidence.attempts);
  const evidenceContextRevision = evidenceRevisionFor({
    items: evidence.items,
    attempts: persistedEvidence.attempts,
  });
  const basePrompt = compileGroundingReviewCapsule({
    userText: input.userText,
    candidateText: input.candidateText,
    evidenceRevision: evidenceContextRevision,
    evidenceItems: evidence.items,
    successfulSearches: evidence.successfulSearches,
    searchResultCount: evidence.searchResultCount,
    successfulReads: evidence.successfulReads,
  }).prompt;
  const usageAttribution = groundingUsageAttribution(input.turnId, input.turnBudget);
  let review: GroundedAnswerReview | null = null;
  let currentPrompt = basePrompt;
  let lastValidationCode = "grounding_review_unknown_invalid";
  for (let attempt = 0; attempt <= GROUNDING_REVIEW_REPAIR_LIMIT; attempt += 1) {
    const raw = transport === "function_tool"
      ? await runFunctionToolGroundingReview({ ...input, prompt: currentPrompt, usageAttribution })
      : await input.deps.promptRunner({
        prompt: currentPrompt,
        model: input.turnInput.model,
        reasoningEffort: "low",
        instructions: "Return only the required structured grounding review.",
        responseFormat: groundedAnswerResponseFormat(),
        cacheScope: "session-turn",
        signal: input.turnInput.signal,
        butlerData: input.deps.butlerData,
        usageAttribution,
      });
    try {
      const parsed = parseGroundedAnswerReview(raw);
      validateGroundedAnswerReview({ review: parsed, evidence });
      review = parsed;
      break;
    } catch (error) {
      if (!isGroundingReviewValidationError(error)) throw error;
      lastValidationCode = error.message;
      if (attempt >= GROUNDING_REVIEW_REPAIR_LIMIT) break;
      currentPrompt = groundingReviewRepairPrompt({
        basePrompt,
        errorCode: lastValidationCode,
        evidenceItemIds: evidence.items.map((item) => item.evidence_item_id),
      });
    }
  }
  if (!review) throw new GroundingReviewStructuredOutputError(lastValidationCode);
  const reviewReceiptId = persistGroundingReview({
    butlerData: input.deps.butlerData,
    contract: input.contract,
    evidence,
    review,
  });
  const missingCandidateCitations = review.outcome === "supported"
    ? citedSourcesMissingFromCandidate({
      candidateText: input.candidateText,
      citationItemIds: review.citation_item_ids,
      items: evidence.items,
    })
    : [];
  if (missingCandidateCitations.length > 0) {
    return {
      kind: "gap",
      evidenceRefs: [reviewReceiptId],
      nextMode: "final_synthesis",
      summary: "The grounding review cited evidence that the candidate did not cite structurally.",
      modelVisibleContent: [
        "Rewrite the candidate with explicit Markdown links to every source used for material claims.",
        "Missing source URLs:",
        ...missingCandidateCitations.map((url) => `- ${url}`),
      ].join("\n"),
    };
  }
  if (!review.candidate_safe_to_deliver || review.next_action !== "accept") {
    return {
      kind: "gap",
      evidenceRefs: [reviewReceiptId],
      nextMode: review.next_action === "gather_more_evidence" ? "tool_decision" : "final_synthesis",
      summary: review.summary,
      modelVisibleContent: [
        "A separate grounding review rejected the current final candidate.",
        `Review outcome: ${review.outcome}.`,
        `Review summary: ${review.summary}`,
        ...review.limitations.map((limitation) => `- ${limitation}`),
        review.next_action === "gather_more_evidence"
          ? "Gather materially different public evidence, then submit a new candidate."
          : "Rewrite the answer as a bounded limitation without unsupported factual claims, then submit it again.",
      ].join("\n"),
    };
  }
  const evidenceReceipt = recordGroundedAnswerEvidence({
    butlerData: input.deps.butlerData,
    contract: input.contract,
    reviewReceiptId,
    itemIds: review.citation_item_ids,
  });
  return { kind: "accepted", evidenceRefs: [reviewReceiptId, evidenceReceipt.receipt_id] };
}

function groundingReviewRepairPrompt(input: {
  basePrompt: string;
  errorCode: string;
  evidenceItemIds: string[];
}): string {
  return [
    input.basePrompt,
    "",
    "## Structural repair required",
    `The prior grounding review was rejected with: ${input.errorCode}`,
    `Allowed evidence_item_ids: ${input.evidenceItemIds.join(", ") || "none"}`,
    "Submit a fresh complete review. Do not reuse nonexistent IDs, duplicate IDs, or claim corroboration from one source identity.",
  ].join("\n");
}

function isGroundingReviewValidationError(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith("grounding_review_");
}

function evidenceContext(
  audit: ToolAuditEntry[],
  persistedItems: PublicWebEvidenceItem[] = [],
  persistedAttempts: PublicWebEvidenceAttempt[] = [],
): {
  items: PublicWebEvidenceItem[];
  successfulSearches: number;
  searchResultCount: number;
  successfulReads: number;
} {
  const auditItems = audit.flatMap((entry) => {
    if (!entry.ok || (entry.name !== "web_search" && entry.name !== "web_read")) return [];
    const result = recordValue(entry.result);
    return Array.isArray(result?.public_web_evidence_items)
      ? result.public_web_evidence_items.filter(isPublicWebEvidenceItem)
      : [];
  });
  const searches = audit.filter((entry) => entry.ok && entry.name === "web_search");
  const persistedSearches = persistedAttempts.filter((attempt) => attempt.producer === "web_search");
  const persistedReads = persistedAttempts.filter((attempt) => attempt.producer === "web_read");
  return {
    items: [...new Map(
      [...persistedItems, ...auditItems].map((item) => [item.evidence_item_id, item]),
    ).values()],
    successfulSearches: Math.max(searches.length, persistedSearches.length),
    searchResultCount: Math.max(
      persistedItems.filter((item) => item.producer === "web_search").length,
      searches.reduce((sum, entry) => {
      const result = recordValue(entry.result);
      return sum + (Array.isArray(result?.results) ? result.results.length : 0);
      }, 0),
    ),
    successfulReads: Math.max(
      audit.filter((entry) => entry.ok && entry.name === "web_read").length,
      persistedReads.length,
    ),
  };
}

function groundedAnswerResponseFormat() {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: [
      "schema_version", "outcome", "candidate_safe_to_deliver", "next_action", "summary",
      "claims", "citation_item_ids", "limitations",
    ],
    properties: {
      schema_version: { type: "string", const: GROUNDED_ANSWER_REVIEW_SCHEMA },
      outcome: { type: "string", enum: ["supported", "insufficient", "no_result"] },
      candidate_safe_to_deliver: { type: "boolean" },
      next_action: { type: "string", enum: ["accept", "gather_more_evidence", "rewrite_with_limitations"] },
      summary: { type: "string", minLength: 1, maxLength: 800 },
      claims: {
        type: "array",
        maxItems: 32,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["claim_id", "claim_text", "support", "evidence_item_ids", "limitations"],
          properties: {
            claim_id: { type: "string", minLength: 1, maxLength: 80 },
            claim_text: { type: "string", minLength: 1, maxLength: 1_200 },
            support: { type: "string", enum: ["direct", "corroborated", "unsupported"] },
            evidence_item_ids: { type: "array", items: { type: "string" }, maxItems: 16 },
            limitations: { type: "array", items: { type: "string" }, maxItems: 8 },
          },
        },
      },
      citation_item_ids: { type: "array", items: { type: "string" }, maxItems: 16 },
      limitations: { type: "array", items: { type: "string" }, maxItems: 16 },
    },
  };
  return { type: "json_schema" as const, name: "grounded_answer_review", schema, strict: true };
}

async function runFunctionToolGroundingReview(input: {
  turnInput: RuntimeTurnInput;
  deps: NativeTurnRunnerDeps;
  prompt: string;
  usageAttribution: PromptUsageAttribution;
}): Promise<string> {
  return await input.deps.toolPromptRunner({
    prompt: input.prompt,
    model: input.turnInput.model,
    reasoningEffort: "low",
    instructions: "Submit exactly one structured grounding review through the required function.",
    cacheScope: "session-turn",
    signal: input.turnInput.signal,
    butlerData: input.deps.butlerData,
    usageAttribution: input.usageAttribution,
    tools: [{
      type: "function",
      name: "submit_grounding_review",
      description: "Submit the independent structured grounding review.",
      parameters: groundedAnswerResponseFormat().schema,
    }],
    toolChoice: "required",
    maxToolRounds: 1,
    executeTool: async ({ name, args }) => {
      if (name !== "submit_grounding_review") throw new Error("grounding_review_tool_invalid");
      return args;
    },
    finalTextFromToolResult: ({ name, output }) =>
      name === "submit_grounding_review" ? JSON.stringify(output) : null,
  });
}

function parseGroundedAnswerReview(raw: string): GroundedAnswerReview {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("grounding_review_json_invalid");
  }
  const record = recordValue(value);
  if (!record || record.schema_version !== GROUNDED_ANSWER_REVIEW_SCHEMA) {
    throw new Error("grounding_review_schema_invalid");
  }
  return value as GroundedAnswerReview;
}

function validateGroundedAnswerReview(input: {
  review: GroundedAnswerReview;
  evidence: ReturnType<typeof evidenceContext>;
}): void {
  const review = input.review;
  if (!new Set(["supported", "insufficient", "no_result"]).has(review.outcome) ||
    typeof review.candidate_safe_to_deliver !== "boolean" ||
    !new Set(["accept", "gather_more_evidence", "rewrite_with_limitations"]).has(review.next_action) ||
    typeof review.summary !== "string" || !review.summary.trim() ||
    !Array.isArray(review.claims) || !Array.isArray(review.citation_item_ids) ||
    !Array.isArray(review.limitations)) {
    throw new Error("grounding_review_shape_invalid");
  }
  const items = new Map(input.evidence.items.map((item) => [item.evidence_item_id, item]));
  const citationIds = uniqueStrings(review.citation_item_ids);
  if (citationIds.length !== review.citation_item_ids.length || citationIds.some((id) => !items.has(id))) {
    throw new Error("grounding_review_citation_invalid");
  }
  for (const claim of review.claims) {
    if (!claim || typeof claim.claim_id !== "string" || typeof claim.claim_text !== "string" ||
      !new Set(["direct", "corroborated", "unsupported"]).has(claim.support) ||
      !Array.isArray(claim.evidence_item_ids) || !Array.isArray(claim.limitations)) {
      throw new Error("grounding_review_claim_invalid");
    }
    const claimIds = uniqueStrings(claim.evidence_item_ids);
    if (claimIds.length !== claim.evidence_item_ids.length ||
      claimIds.some((id) => !items.has(id) || !citationIds.includes(id))) {
      throw new Error("grounding_review_claim_reference_invalid");
    }
    if (claim.support !== "unsupported" && claimIds.length === 0) {
      throw new Error("grounding_review_supported_claim_unreferenced");
    }
    if (claim.support === "corroborated") {
      const identities = new Set(claimIds.map((id) => items.get(id)!.source_identity));
      if (identities.size < 2) throw new Error("grounding_review_corroboration_not_independent");
    }
  }
  if (review.outcome === "supported" && (
    !review.candidate_safe_to_deliver || review.next_action !== "accept" || review.claims.length === 0 ||
    review.claims.some((claim) => claim.support === "unsupported") || citationIds.length === 0
  )) throw new Error("grounding_review_supported_outcome_invalid");
  if (review.outcome === "no_result" && (
    input.evidence.successfulSearches === 0 || input.evidence.searchResultCount !== 0
  )) throw new Error("grounding_review_no_result_unobserved");
  if (review.candidate_safe_to_deliver !== (review.next_action === "accept")) {
    throw new Error("grounding_review_delivery_action_conflict");
  }
  if (review.outcome !== "supported" && review.candidate_safe_to_deliver && review.limitations.length === 0) {
    throw new Error("grounding_review_limitation_missing");
  }
  if (review.outcome === "insufficient" && review.candidate_safe_to_deliver &&
    input.evidence.successfulSearches + input.evidence.successfulReads === 0) {
    throw new Error("grounding_review_insufficient_unobserved");
  }
}

function citedSourcesMissingFromCandidate(input: {
  candidateText: string;
  citationItemIds: string[];
  items: PublicWebEvidenceItem[];
}): string[] {
  const citedUrls = new Set(
    input.citationItemIds.flatMap((id) => {
      const item = input.items.find((candidate) => candidate.evidence_item_id === id);
      return item ? [item.source_url] : [];
    }),
  );
  const candidateUrls = new Set(
    [...input.candidateText.matchAll(/https?:\/\/[^\s)\]>]+/gu)]
      .map((match) => normalizedCitationUrl(match[0]))
      .filter((url): url is string => Boolean(url)),
  );
  return [...citedUrls].filter((url) => !candidateUrls.has(normalizedCitationUrl(url) ?? url));
}

function normalizedCitationUrl(value: string): string | null {
  try {
    const parsed = new URL(value.replace(/[.,;:!?]+$/u, ""));
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

function persistGroundingReview(input: {
  butlerData: string;
  contract: CompiledTurnContract;
  evidence: ReturnType<typeof evidenceContext>;
  review: GroundedAnswerReview;
}): string {
  const receiptId = `grounding-review-${hash(JSON.stringify({
    contract_id: input.contract.contract_id,
    evidence_item_ids: input.evidence.items.map((item) => item.evidence_item_id),
    review: input.review,
  })).slice(0, 24)}`;
  writeJsonFileAtomic(join(input.butlerData, "grounding-reviews", `${receiptId}.json`), {
    schema_version: GROUNDED_ANSWER_REVIEW_SCHEMA,
    receipt_id: receiptId,
    contract_id: input.contract.contract_id,
    evidence_item_ids: input.evidence.items.map((item) => item.evidence_item_id),
    review: input.review,
    created_at: new Date().toISOString(),
  });
  return receiptId;
}

function recordGroundedAnswerEvidence(input: {
  butlerData: string;
  contract: CompiledTurnContract;
  reviewReceiptId: string;
  itemIds: string[];
}): TurnEvidenceReceipt {
  const obligation = input.contract.required_evidence.find((item) => item.deliverable === "grounded_answer");
  if (!obligation || !obligation.allowed_producers.includes("public_web")) {
    throw new Error("grounding_review_obligation_missing");
  }
  const receipt: TurnEvidenceReceipt = {
    schema_version: TURN_EVIDENCE_RECEIPT_SCHEMA,
    receipt_id: `turn-evidence-${hash(`${input.contract.contract_id}\n${obligation.obligation_id}\n${input.reviewReceiptId}`).slice(0, 24)}`,
    contract_id: input.contract.contract_id,
    obligation_id: obligation.obligation_id,
    deliverable: obligation.deliverable,
    target_kind: obligation.target_kind,
    target_id: obligation.target_id,
    obligation_generation: obligation.generation,
    verified: true,
    item_ids: uniqueStrings(input.itemIds).sort(),
    producer: "public_web",
    evidence_class: "grounded_answer",
    created_at: new Date().toISOString(),
  };
  new TurnContractStore(input.butlerData).recordEvidence(receipt);
  return receipt;
}

function groundingUsageAttribution(
  turnId: string | null | undefined,
  budget: ReturnType<typeof createDirectTurnBudget>,
): PromptUsageAttribution {
  return {
    ...(turnId ? { turnId } : {}),
    phase: "grounding_review",
    requestedOutputTokens: directTurnRequestedOutputTokens("review"),
    budgetState: directTurnPartitionBudgetState(budget, "review"),
    getBudgetState: () => directTurnPartitionBudgetState(budget, "review"),
    beforeAdmittedModelRequest: (request) => beforeDirectTurnModelRequest(budget, {
      partition: "review",
      admittedPromptTokens: request.admittedPromptTokens,
      requestedOutputTokens: request.requestedOutputTokens,
    }),
    afterModelResponseUsage: (usage) => addDirectTurnUsage({
      budget,
      promptTokens: usage.promptTokens,
      cachedTokens: usage.cachedTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      partition: "review",
    }),
  };
}

function uniqueStrings(value: unknown[]): string[] {
  if (!value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new Error("grounding_review_reference_shape_invalid");
  }
  return [...new Set(value as string[])];
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
