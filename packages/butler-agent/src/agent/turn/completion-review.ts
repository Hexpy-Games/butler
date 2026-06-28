import { sanitizePublicText } from "../events/turn-events.ts";
import { completionReviewIncompleteReason } from "../output/completion/final-output-contract.ts";
import type { PublicWorkObligationKind } from "./native/output/tool-types.ts";
import { buildEvidenceCapabilityLedger } from "../output/evidence/ledger-state.ts";
import type { EvidenceCapabilityReceipt } from "../output/evidence/types.ts";

export type CompletionReviewOutcomeKind = "complete" | "gap" | "waiting_user" | "failed";

export type CompletionObservationVisibility = "model" | "public" | "operator";

export type CompletionObservationKind =
  | "completion_gap"
  | "public_decision_required"
  | "tool_result"
  | "tool_invalid_arguments"
  | "tool_unavailable"
  | "command_failed"
  | "test_failed"
  | "validation_failed"
  | "context_compacted"
  | "user_input"
  | "user_cancelled";

export interface CompletionReviewObservationRef {
  kind: string;
  id: string;
  path?: string;
}

export interface CompletionReviewObservation {
  kind: CompletionObservationKind;
  visibility: CompletionObservationVisibility;
  summary: string;
  modelVisibleContent: string;
  publicSummary?: string;
  refs?: CompletionReviewObservationRef[];
  causedByToolCallId?: string;
  causedByDecisionId?: string;
}

export interface CompletionReviewInput {
  requestText: string;
  candidateText: string;
  evidenceReceipts?: unknown[];
  requiredObligations?: PublicWorkObligationKind[];
  observations?: Array<Pick<CompletionReviewObservation, "kind" | "summary" | "modelVisibleContent"> & {
    visibility?: CompletionObservationVisibility;
    publicSummary?: string;
  }>;
  workStreamTerminal?: boolean;
  todoTerminal?: boolean;
}

export interface CompletionReviewComplete {
  kind: "complete";
}

export interface CompletionReviewGap {
  kind: "gap";
  reason: string;
  observation: CompletionReviewObservation;
}

export interface CompletionReviewWaitingUser {
  kind: "waiting_user";
  reason: string;
  question: string;
  observation: CompletionReviewObservation;
}

export interface CompletionReviewFailed {
  kind: "failed";
  reason: string;
  publicSummary: string;
}

export type CompletionReviewOutcome =
  | CompletionReviewComplete
  | CompletionReviewGap
  | CompletionReviewWaitingUser
  | CompletionReviewFailed;

export function evaluateCompletionReviewOutcome(input: CompletionReviewInput): CompletionReviewOutcome {
  const {
    requestText,
    candidateText,
    evidenceReceipts = [],
    requiredObligations = [],
    observations = [],
    workStreamTerminal = false,
    todoTerminal = false,
  } = input;

  const request = sanitizePublicText(requestText, "");
  const candidate = sanitizePublicText(candidateText, "");

  if (!request) {
    return {
      kind: "failed",
      reason: "Missing request text for completion review.",
      publicSummary: "I could not continue because request text was not available.",
    };
  }

  const isTerminalState = Boolean(workStreamTerminal || todoTerminal);
  const candidateBlockedByText = candidateIncompleteIsUserBlock(candidate);

  const candidateIncompleteReason = completionReviewIncompleteReason(candidate);
  if (candidateIncompleteReason) {
    const reason = candidateIncompleteReason;
    if (candidateBlockedByText) {
      return buildWaitingUserOutcome({
        reason,
        requestText: request,
        candidateText: candidate,
        observations,
      });
    }
    if (isTerminalState) {
      return {
        kind: "failed",
        reason,
        publicSummary: reason,
      };
    }
    return buildGapOutcome({
      reason,
      modelText: `Missing completion state: ${reason}`,
      requestText: request,
      observations,
    });
  }

  const obligationGap = evaluateObligationGap({
    requiredObligations,
    evidenceReceipts,
    observations,
    requestText: request,
  });
  if (obligationGap) {
    if (obligationGap.kind === "waiting_user" && !isTerminalState) {
      return {
        kind: "waiting_user",
        reason: obligationGap.reason,
        question: obligationGap.reason,
        observation: obligationGap.observation,
      };
    }
    if (isTerminalState) {
      return {
        kind: "failed",
        reason: obligationGap.reason,
        publicSummary: obligationGap.reason,
      };
    }
    return {
      kind: "gap",
      reason: obligationGap.reason,
      observation: obligationGap.observation,
    };
  }

  if (hasBlockingObservation(observations)) {
    const reason = "The next step requires principal input before completion can proceed.";
    return buildWaitingUserOutcome({
      reason,
      requestText: request,
      candidateText: candidate,
      observations,
    });
  }

  if (!candidate) {
    if (isTerminalState) {
      return {
        kind: "failed",
        reason: "No final candidate text was available.",
        publicSummary: "No final answer was generated for this turn.",
      };
    }
    return buildGapOutcome({
      reason: "No final candidate text was available.",
      modelText: "No durable completion text was produced.",
      requestText: request,
      observations,
    });
  }

  return { kind: "complete" };
}

interface ObligationGapResult {
  reason: string;
  observation: CompletionReviewObservation;
  kind: CompletionReviewOutcomeKind;
  receipts: EvidenceCapabilityReceipt[];
}

function evaluateObligationGap(input: {
  requiredObligations: PublicWorkObligationKind[];
  evidenceReceipts: unknown[];
  observations: CompletionReviewInput["observations"];
  requestText: string;
}): ObligationGapResult | null {
  const required = dedupeObligations(input.requiredObligations);
  if (required.length === 0) return null;

  const ledger = buildEvidenceCapabilityLedger({
    required,
    receipts: input.evidenceReceipts,
  });
  if (ledger.missing.length === 0) return null;

  const missing = ledger.missing.join(", ");
  const reason = `Missing completion evidence for required outcome(s): ${missing}.`;
  const modelText = `Missing evidence for required completion obligations: ${missing}.`;

  return hasExplicitBlocker(ledger.receipts) || hasBlockingObservation(input.observations)
    ? {
      kind: "waiting_user",
      reason,
      receipts: ledger.receipts,
      observation: buildWaitingUserObservation({
        summary: reason,
        requestText: input.requestText,
        modelText,
        refs: refsFromObservations(input.observations),
      }),
    }
    : {
      kind: "gap",
      reason,
      receipts: ledger.receipts,
      observation: buildGapObservation({
        summary: reason,
        requestText: input.requestText,
        modelText,
        refs: refsFromObservations(input.observations),
      }),
    };
}

function hasExplicitBlocker(receipts: EvidenceCapabilityReceipt[]): boolean {
  return receipts.some((receipt) =>
    receipt.verified &&
    receipt.maturity === "verified" &&
    receipt.capability === "explicit_blocker" &&
    receipt.evidence_kind === "blocker",
  );
}

function hasBlockingObservation(observations: CompletionReviewInput["observations"] = []): boolean {
  return observations.some((observation) =>
    observation.kind === "public_decision_required" ||
    observation.kind === "user_cancelled" ||
    hasBlockingLanguage(observation),
  );
}

function hasBlockingLanguage(observation: {
  summary?: string;
  modelVisibleContent?: string;
}): boolean {
  const hay = sanitizePublicText(`${observation.summary ?? ""} ${observation.modelVisibleContent ?? ""}`, "");
  return /permission|login|credential|confirm|approval|승인|인증|로그인|주문|결제|cancel|취소|계정/.test(hay);
}

function candidateIncompleteIsUserBlock(text: string): boolean {
  const normalized = sanitizePublicText(text, "").toLowerCase();
  return /credential|login|authoriz|승인|인증|권한|로그인|주문|결제|요청|permission/i.test(normalized);
}

function buildGapOutcome(input: {
  reason: string;
  modelText: string;
  requestText: string;
  observations: CompletionReviewInput["observations"];
}): CompletionReviewGap {
  return {
    kind: "gap",
    reason: input.reason,
    observation: buildGapObservation({
      summary: input.reason,
      requestText: input.requestText,
      modelText: input.modelText,
      refs: refsFromObservations(input.observations),
    }),
  };
}

function buildWaitingUserOutcome(input: {
  reason: string;
  requestText: string;
  candidateText: string;
  observations: CompletionReviewInput["observations"];
}): CompletionReviewWaitingUser {
  const observation = buildWaitingUserObservation({
    summary: input.reason,
    requestText: input.requestText,
    modelText: input.candidateText,
    refs: refsFromObservations(input.observations),
  });
  return {
    kind: "waiting_user",
    reason: input.reason,
    question: input.reason,
    observation,
  };
}

function buildGapObservation(input: {
  summary: string;
  requestText: string;
  modelText: string;
  refs?: CompletionReviewObservationRef[];
}): CompletionReviewObservation {
  return {
    kind: "completion_gap",
    visibility: "model",
    summary: sanitizePublicText(input.summary, "Completion evidence is missing."),
    modelVisibleContent: [
      `request: ${input.requestText}`,
      `next-step: ${input.modelText}`,
    ].join("\n"),
    publicSummary: "More evidence is required before completion.",
    ...(input.refs ? { refs: input.refs } : {}),
  };
}

function buildWaitingUserObservation(input: {
  summary: string;
  requestText: string;
  modelText: string;
  refs?: CompletionReviewObservationRef[];
}): CompletionReviewObservation {
  return {
    kind: "public_decision_required",
    visibility: "operator",
    summary: sanitizePublicText(input.summary, "User action is required."),
    modelVisibleContent: [
      `request: ${input.requestText}`,
      `next-step: ${input.modelText}`,
    ].join("\n"),
    publicSummary: "User input is required to continue.",
    ...(input.refs ? { refs: input.refs } : {}),
  };
}

function refsFromObservations(
  observations: CompletionReviewInput["observations"] = [],
): CompletionReviewObservationRef[] {
  const refs: CompletionReviewObservationRef[] = [];
  for (const [index, observation] of observations.entries()) {
    const summary = sanitizePublicText(`${observation.summary ?? ""} ${observation.modelVisibleContent ?? ""}`, "");
    if (!summary) continue;
    refs.push({
      kind: "observation",
      id: `obs-${index + 1}`,
      path: summary,
    });
  }
  return refs;
}

function dedupeObligations(values: PublicWorkObligationKind[]): PublicWorkObligationKind[] {
  return [...new Set(values)];
}
