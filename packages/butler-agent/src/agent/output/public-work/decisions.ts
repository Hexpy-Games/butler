import type { RuntimeMessageLanguage } from "../messages.ts";
import type {
  PublicWorkDecision,
  ToolProgressSummary,
} from "../../turn/native/output/tool-types.ts";
import {
  isUsablePublicDecisionText,
  publicDecisionId,
  publicDecisionStructuredFields,
  renderPublicDecisionContext,
} from "./protocol.ts";

const PUBLIC_DECISION_EVIDENCE_REF_LIMIT = 2;
const PUBLIC_DECISION_FALLBACK_MIN_CHARS = 8;

export function publicWorkDecisionPayload(decision: PublicWorkDecision): Record<string, unknown> {
  return {
    decisionId: decision.decisionId,
    decisionSummary: decision.summary,
    decisionRationale: decision.rationale,
    decisionNextStep: decision.nextStep,
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
}): PublicWorkDecision[] {
  const structured = publicDecisionStructuredFields(input.text);
  if (structured.length === 0) {
    return [];
  }
  return input.toolCalls.flatMap((call, index) => {
    const indexedDecision = structured[index];
    const sharedDecision = structured[0];
    const decisionWasRepaired = indexedDecision?.repaired === true || sharedDecision?.repaired === true;
    const summary = indexedDecision?.summary ?? sharedDecision?.summary;
    const rationale = indexedDecision?.rationale ?? sharedDecision?.rationale;
    const nextStep = indexedDecision?.nextStep ?? sharedDecision?.nextStep;
    if (
      decisionWasRepaired ||
      typeof summary !== "string" ||
      typeof rationale !== "string" ||
      typeof nextStep !== "string" ||
      !isUsablePublicDecisionText(summary ?? "") ||
      !isUsablePublicDecisionText(rationale ?? "", { minChars: PUBLIC_DECISION_FALLBACK_MIN_CHARS }) ||
      !isUsablePublicDecisionText(nextStep ?? "", { minChars: PUBLIC_DECISION_FALLBACK_MIN_CHARS })
    ) {
      return [];
    }
    return {
      decisionId: publicDecisionId(),
      summary,
      rationale,
      evidenceRefs: input.existingDecisions
        .slice(-PUBLIC_DECISION_EVIDENCE_REF_LIMIT)
        .map((decision) => decision.summary),
      nextStep,
      completionObligations: indexedDecision?.completionObligations ??
        sharedDecision?.completionObligations ??
        [],
      source: "assistant-authored",
      toolName: call.name,
    };
  });
}

export function takePublicWorkDecisionForTool(input: {
  pending: PublicWorkDecision[];
  toolName: string;
  progress: ToolProgressSummary;
  language: RuntimeMessageLanguage;
  previousDecisions: PublicWorkDecision[];
}): PublicWorkDecision {
  const pending = takePendingDecision(input.pending, input.toolName);
  if (pending) {
    const fallback = fallbackDecisionForProgress(input.progress, input.previousDecisions);
    const summaryOk = isUsablePublicDecisionText(pending.summary);
    const rationaleOk = isUsablePublicDecisionText(
      pending.rationale ?? "",
      { minChars: PUBLIC_DECISION_FALLBACK_MIN_CHARS },
    );
    const nextStepOk = isUsablePublicDecisionText(
      pending.nextStep ?? "",
      { minChars: PUBLIC_DECISION_FALLBACK_MIN_CHARS },
    );
    const hasEvidenceRefs = pending.evidenceRefs.length > 0;
    const evidenceRefs = hasEvidenceRefs
      ? pending.evidenceRefs
      : input.previousDecisions
        .slice(-PUBLIC_DECISION_EVIDENCE_REF_LIMIT)
        .map((decision) => decision.summary);
    return {
      ...pending,
      summary: decisionTextOrFallback(summaryOk, pending.summary, fallback.summary),
      rationale: decisionTextOrFallback(rationaleOk, pending.rationale, fallback.rationale),
      nextStep: decisionTextOrFallback(nextStepOk, pending.nextStep, fallback.nextStep),
      evidenceRefs,
      source: summaryOk ? pending.source : "review-repaired",
    };
  }
  const fallback = fallbackDecisionForProgress(input.progress, input.previousDecisions);
  return {
    decisionId: publicDecisionId(),
    ...fallback,
    source: "runtime-derived",
    toolName: input.toolName,
  };
}

export function hasCompleteAuthoredPublicDecisionForTool(input: {
  pending: PublicWorkDecision[];
  toolName: string;
}): boolean {
  const decision = input.pending.find((candidate) => candidate.toolName === input.toolName) ??
    input.pending[0];
  if (!decision || decision.source !== "assistant-authored") {
    return false;
  }
  return isUsablePublicDecisionText(decision.summary) &&
    isUsablePublicDecisionText(decision.rationale ?? "", {
      minChars: PUBLIC_DECISION_FALLBACK_MIN_CHARS,
    }) &&
    isUsablePublicDecisionText(decision.nextStep ?? "", {
      minChars: PUBLIC_DECISION_FALLBACK_MIN_CHARS,
    });
}

function takePendingDecision(
  pending: PublicWorkDecision[],
  toolName: string,
): PublicWorkDecision | undefined {
  const matchingIndex = pending.findIndex((decision) => decision.toolName === toolName);
  const hasMatchingDecision = matchingIndex >= 0;
  if (hasMatchingDecision) {
    return pending.splice(matchingIndex, 1)[0];
  }
  return pending.shift();
}

function decisionTextOrFallback(
  useCandidate: boolean,
  candidate: string | undefined,
  fallback: string | undefined,
): string {
  if (useCandidate && candidate) {
    return candidate;
  }
  return fallback ?? "";
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

function fallbackDecisionForProgress(
  progress: ToolProgressSummary,
  previousDecisions: PublicWorkDecision[],
): Pick<PublicWorkDecision, "summary" | "rationale" | "nextStep" | "evidenceRefs"> {
  const evidenceRefs = previousDecisions
    .slice(-PUBLIC_DECISION_EVIDENCE_REF_LIMIT)
    .map((decision) => decision.summary);
  return {
    summary: progress.workBlockLabel,
    evidenceRefs,
  };
}
