import type { RuntimeMessageLanguage } from "../messages.ts";
import type {
  PublicWorkDecision,
  ToolProgressSummary,
} from "../../turn/native/output/tool-types.ts";
import { isAuthoredDecisionSource } from "../../events/turn-state-contract.ts";
import {
  isUsablePublicDecisionText,
  publicDecisionId,
  publicDecisionStructuredFields,
  renderPublicDecisionContext,
} from "./protocol.ts";

const PUBLIC_DECISION_EVIDENCE_REF_LIMIT = 2;
const PUBLIC_DECISION_FALLBACK_MIN_CHARS = 8;
export const PUBLIC_WORK_DECISION_TOOL_USAGE_LIMIT = 6;

export function publicWorkDecisionPayload(decision: PublicWorkDecision): Record<string, unknown> {
  return {
    decisionId: decision.decisionId,
    contractId: decision.contractId,
    workstreamId: decision.workstreamId,
    semanticBlockId: decision.semanticBlockId,
    decisionTitle: decision.blockTitle,
    decisionSummary: decision.summary,
    decisionRationale: decision.rationale,
    decisionNextStep: decision.nextStep,
    decisionExpectedEffect: decision.expectedEffect,
    decisionRepeatReason: decision.repeatReason,
    decisionSource: decision.source,
    decisionEvidenceRefs: decision.evidenceRefs,
    decisionCompletionObligations: decision.completionObligations ?? [],
  };
}

export function publicWorkDecisionsFromAssistantText(input: {
  text: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  language: RuntimeMessageLanguage;
  existingDecisions: PublicWorkDecision[];
  contractContext?: {
    contractId: string;
    workstreamId?: string;
    semanticBlockId: string;
    usageGroupId: string;
  };
}): PublicWorkDecision[] {
  const structured = publicDecisionStructuredFields(input.text);
  if (structured.length === 0) {
    return [];
  }
  const usageGroupIds = structured.map(() => publicDecisionId());
  return input.toolCalls.flatMap((call, index) => {
    const indexedDecision = structured[index];
    const sharedDecision = structured[0];
    const usageGroupIndex = indexedDecision ? index : 0;
    const decisionWasRepaired = indexedDecision?.repaired === true || sharedDecision?.repaired === true;
    const blockTitle = indexedDecision?.blockTitle ?? sharedDecision?.blockTitle;
    const summary = indexedDecision?.summary ?? sharedDecision?.summary;
    const rationale = indexedDecision?.rationale ?? sharedDecision?.rationale;
    const nextStep = indexedDecision?.nextStep ?? sharedDecision?.nextStep;
    const expectedEffect = indexedDecision?.expectedEffect ?? sharedDecision?.expectedEffect;
    const repeatReason = indexedDecision?.repeatReason ?? sharedDecision?.repeatReason;
    if (
      decisionWasRepaired ||
      typeof blockTitle !== "string" ||
      typeof summary !== "string" ||
      typeof rationale !== "string" ||
      typeof nextStep !== "string" ||
      !isUsablePublicDecisionText(summary ?? "") ||
      !isUsablePublicDecisionText(blockTitle ?? "", { minChars: 2 }) ||
      !isUsablePublicDecisionText(rationale ?? "", { minChars: PUBLIC_DECISION_FALLBACK_MIN_CHARS }) ||
      !isUsablePublicDecisionText(nextStep ?? "", { minChars: PUBLIC_DECISION_FALLBACK_MIN_CHARS })
    ) {
      return [];
    }
    return {
      decisionId: publicDecisionId(),
      usageGroupId: input.contractContext?.usageGroupId ?? usageGroupIds[usageGroupIndex] ?? publicDecisionId(),
      ...(input.contractContext
        ? {
          contractId: input.contractContext.contractId,
          ...(input.contractContext.workstreamId ? { workstreamId: input.contractContext.workstreamId } : {}),
          semanticBlockId: input.contractContext.semanticBlockId,
        }
        : {}),
      blockTitle,
      summary,
      rationale,
      evidenceRefs: input.existingDecisions
        .slice(-PUBLIC_DECISION_EVIDENCE_REF_LIMIT)
        .map((decision) => decision.summary),
      nextStep,
      ...(expectedEffect ? { expectedEffect } : {}),
      ...(repeatReason ? { repeatReason } : {}),
      completionObligations: indexedDecision?.completionObligations ??
        sharedDecision?.completionObligations ??
        [],
      source: "assistant-authored",
      toolName: call.name,
      toolCallIndex: index,
      toolBatchSize: Math.min(input.toolCalls.length, PUBLIC_WORK_DECISION_TOOL_USAGE_LIMIT),
    };
  });
}

export function takePublicWorkDecisionForTool(input: {
  pending: PublicWorkDecision[];
  toolName: string;
  progress: ToolProgressSummary;
  language: RuntimeMessageLanguage;
  previousDecisions: PublicWorkDecision[];
  allowRuntimeDerived?: boolean;
}): PublicWorkDecision {
  const pending = takePendingDecision(input.pending, input.toolName);
  const decision = pending && isCompleteVisibleDecision(pending, input.allowRuntimeDerived === true)
    ? pending
    : undefined;
  if (!decision || !isCompleteVisibleDecision(decision, input.allowRuntimeDerived === true)) {
    throw new Error("Fresh public work decision continuation needed before visible tool execution.");
  }
  const evidenceRefs = decision.evidenceRefs.length > 0
    ? decision.evidenceRefs
    : input.previousDecisions
      .slice(-PUBLIC_DECISION_EVIDENCE_REF_LIMIT)
      .map((decision) => decision.summary);
  const publicDecision = { ...decision };
  delete publicDecision.claimed;
  return {
    ...publicDecision,
    evidenceRefs,
  };
}

export function hasCompleteAuthoredPublicDecisionForTool(input: {
  pending: PublicWorkDecision[];
  toolName: string;
  allowRuntimeDerived?: boolean;
}): boolean {
  const decision = input.pending.find((candidate) => candidate.toolName === input.toolName && candidate.claimed !== true) ??
    input.pending.find((candidate) => candidate.toolName === input.toolName) ??
    input.pending.find((candidate) => candidate.claimed !== true) ??
    input.pending[0];

  if (!decision) {
    return false;
  }
  if (!decisionGroupHasRemainingUse(input.pending, decision)) {
    return false;
  }

  return isCompleteVisibleDecision(decision, input.allowRuntimeDerived === true);
}

function takePendingDecision(
  pending: PublicWorkDecision[],
  toolName: string,
): PublicWorkDecision | undefined {
  const matchingOrderedDecision = pending.find((decision) =>
    decision.toolName === toolName && decision.claimed !== true,
  );
  if (matchingOrderedDecision && claimDecisionGroupUse(pending, matchingOrderedDecision)) {
    matchingOrderedDecision.claimed = true;
    return decisionWithClaimedIndex(pending, matchingOrderedDecision);
  }

  const reusableMatchingDecision = pending.find((decision) => decision.toolName === toolName);
  if (reusableMatchingDecision && claimDecisionGroupUse(pending, reusableMatchingDecision)) {
    return decisionWithClaimedIndex(pending, reusableMatchingDecision);
  }

  const sharedOrderedDecision = pending.find((decision) => decision.claimed !== true);
  if (sharedOrderedDecision && claimDecisionGroupUse(pending, sharedOrderedDecision)) {
    sharedOrderedDecision.claimed = true;
    return decisionWithClaimedIndex(pending, sharedOrderedDecision);
  }

  const sharedDecision = pending[0];
  if (sharedDecision && claimDecisionGroupUse(pending, sharedDecision)) {
    return decisionWithClaimedIndex(pending, sharedDecision);
  }

  return;
}

function decisionWithClaimedIndex(
  pending: PublicWorkDecision[],
  decision: PublicWorkDecision,
): PublicWorkDecision {
  const claimedIndex = Math.max(0, decisionGroupUsageCount(pending, decision) - 1);
  return {
    ...decision,
    toolCallIndex: decision.toolCallIndex ?? claimedIndex,
  };
}

function decisionUsageGroupKey(decision: PublicWorkDecision): string {
  return decision.usageGroupId ?? decision.decisionId;
}

function decisionGroupHasRemainingUse(
  pending: PublicWorkDecision[],
  decision: PublicWorkDecision,
): boolean {
  return decisionGroupUsageCount(pending, decision) < decisionGroupUsageLimit(pending, decision);
}

function claimDecisionGroupUse(
  pending: PublicWorkDecision[],
  decision: PublicWorkDecision,
): boolean {
  const usageCount = decisionGroupUsageCount(pending, decision);
  if (usageCount >= decisionGroupUsageLimit(pending, decision)) return false;
  setDecisionGroupUsageCount(pending, decision, usageCount + 1);
  return true;
}

function decisionGroupUsageLimit(
  pending: PublicWorkDecision[],
  decision: PublicWorkDecision,
): number {
  const key = decisionUsageGroupKey(decision);
  const declaredBatchSize = pending
    .filter((candidate) => decisionUsageGroupKey(candidate) === key)
    .reduce((max, candidate) => Math.max(max, candidate.toolBatchSize ?? 0), 0);
  return Math.max(
    1,
    Math.min(
      declaredBatchSize || PUBLIC_WORK_DECISION_TOOL_USAGE_LIMIT,
      PUBLIC_WORK_DECISION_TOOL_USAGE_LIMIT,
    ),
  );
}

function decisionGroupUsageCount(
  pending: PublicWorkDecision[],
  decision: PublicWorkDecision,
): number {
  const key = decisionUsageGroupKey(decision);
  return pending
    .filter((candidate) => decisionUsageGroupKey(candidate) === key)
    .reduce((max, candidate) => Math.max(max, candidate.usageCount ?? 0), 0);
}

function setDecisionGroupUsageCount(
  pending: PublicWorkDecision[],
  decision: PublicWorkDecision,
  usageCount: number,
): void {
  const key = decisionUsageGroupKey(decision);
  for (const candidate of pending) {
    if (decisionUsageGroupKey(candidate) === key) {
      candidate.usageCount = usageCount;
    }
  }
}

export function annotateToolResultWithDecisionContext(input: {
  result: unknown;
  decision: PublicWorkDecision;
  decisions: PublicWorkDecision[];
}): unknown {
  const context = renderPublicDecisionContext(input.decisions);
  if (!context) {
    return input.result;
  }
  const decision = publicWorkDecisionPayload(input.decision);
  if (input.result && typeof input.result === "object" && !Array.isArray(input.result)) {
    return {
      ...(input.result as Record<string, unknown>),
      public_work_decision: decision,
      public_work_decision_context: context,
    };
  }
  return {
    value: input.result,
    public_work_decision: decision,
    public_work_decision_context: context,
  };
}

function isCompleteVisibleDecision(decision: PublicWorkDecision, allowRuntimeDerived: boolean): boolean {
  if (allowRuntimeDerived && decision.source === "runtime-derived") {
    return isUsablePublicDecisionText(decision.summary) &&
      isUsablePublicDecisionText(decision.rationale ?? "", {
        minChars: PUBLIC_DECISION_FALLBACK_MIN_CHARS,
      }) &&
      isUsablePublicDecisionText(decision.nextStep ?? "", {
        minChars: PUBLIC_DECISION_FALLBACK_MIN_CHARS,
      });
  }
  if (!isAuthoredDecisionSource(decision.source)) return false;
  return isUsablePublicDecisionText(decision.summary) &&
    isUsablePublicDecisionText(decision.rationale ?? "", {
      minChars: PUBLIC_DECISION_FALLBACK_MIN_CHARS,
    }) &&
    isUsablePublicDecisionText(decision.nextStep ?? "", {
      minChars: PUBLIC_DECISION_FALLBACK_MIN_CHARS,
    });
}
