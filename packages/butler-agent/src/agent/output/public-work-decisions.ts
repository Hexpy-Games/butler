import { randomUUID } from "crypto";
import { sanitizePublicText } from "../events/turn-events.ts";
import type { RuntimeMessageLanguage } from "./messages.ts";
import type {
  PublicWorkObligationKind,
  PublicWorkDecision,
  ToolProgressSummary,
} from "../turn/native/output/tool-types.ts";
import {
  activityKindForTool,
  displayToolName,
} from "./tool-progress.ts";

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
  const safeText = publicDecisionText(input.text);
  if (!safeText && structured.length === 0) return [];
  const sentences = safeText ? publicDecisionSentences(safeText) : [];
  return input.toolCalls.map((call, index) => ({
    decisionId: `decision-${randomUUID().slice(0, 8)}`,
    summary: structured[index]?.summary ??
      structured[0]?.summary ??
      sentences[index] ??
      sentences[0] ??
      fallbackDecisionForToolName(call.name, input.language).summary,
    rationale: structured[index]?.rationale ??
      structured[0]?.rationale ??
      sentences[index + 1] ??
      fallbackDecisionForToolName(call.name, input.language).rationale,
    evidenceRefs: input.existingDecisions.slice(-2).map((decision) => decision.summary),
    nextStep: structured[index]?.nextStep ??
      structured[0]?.nextStep ??
      fallbackDecisionForToolName(call.name, input.language).nextStep,
    completionObligations: structured[index]?.completionObligations ??
      structured[0]?.completionObligations ??
      [],
    source: structured[index]?.repaired || structured[0]?.repaired ? "review-repaired" : "assistant-authored",
    toolName: call.name,
  }));
}

export function takePublicWorkDecisionForTool(input: {
  pending: PublicWorkDecision[];
  toolName: string;
  progress: ToolProgressSummary;
  language: RuntimeMessageLanguage;
  previousDecisions: PublicWorkDecision[];
}): PublicWorkDecision {
  const matchingIndex = input.pending.findIndex((decision) => decision.toolName === input.toolName);
  const pending = matchingIndex >= 0
    ? input.pending.splice(matchingIndex, 1)[0]
    : input.pending.shift();
  if (pending) {
    const fallback = fallbackDecisionForProgress(input.progress, input.language, input.previousDecisions);
    const summaryOk = isUsablePublicDecisionText(pending.summary);
    return {
      ...pending,
      summary: summaryOk ? pending.summary : fallback.summary,
      rationale: isUsablePublicDecisionText(pending.rationale ?? "", { minChars: 8 })
        ? pending.rationale
        : fallback.rationale,
      nextStep: isUsablePublicDecisionText(pending.nextStep ?? "", { minChars: 8 })
        ? pending.nextStep
        : fallback.nextStep,
      evidenceRefs: pending.evidenceRefs.length > 0
        ? pending.evidenceRefs
        : input.previousDecisions.slice(-2).map((decision) => decision.summary),
      source: summaryOk ? pending.source : "review-repaired",
    };
  }
  const fallback = fallbackDecisionForProgress(input.progress, input.language, input.previousDecisions);
  return {
    decisionId: `decision-${randomUUID().slice(0, 8)}`,
    ...fallback,
    source: "runtime-derived",
    toolName: input.toolName,
  };
}

function isUsablePublicDecisionText(
  value: string,
  options: { minChars?: number } = {},
): boolean {
  const text = sanitizePublicText(value, "").trim();
  const minChars = options.minChars ?? 8;
  if (text.length < minChars) return false;
  const compact = text.replace(/\s+/gu, "");
  if (new Set(Array.from(compact)).size < 3) return false;
  return true;
}

export function annotateToolResultWithDecisionContext(input: {
  result: unknown;
  decision: PublicWorkDecision;
  decisions: PublicWorkDecision[];
}): unknown {
  const context = renderPublicDecisionContext(input.decisions);
  if (!context) return input.result;
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

function fallbackDecisionForToolName(
  toolName: string,
  language: RuntimeMessageLanguage,
): Pick<PublicWorkDecision, "summary" | "rationale" | "nextStep" | "evidenceRefs"> {
  const kind = activityKindForTool(toolName);
  const toolLabel = displayToolName(toolName, kind);
  if (language === "ko") {
    return {
      summary: `${toolLabel} 작업으로 필요한 근거를 확인합니다.`,
      rationale: "다음 단계가 추측이 아니라 확인된 작업 결과를 기준으로 이어지도록 하기 위해서입니다.",
      nextStep: "이 결과를 다음 도구 선택이나 최종 보고의 기준으로 사용합니다.",
      evidenceRefs: [],
    };
  }
  return {
    summary: `Checking the needed evidence with ${toolLabel}.`,
    rationale: "This keeps the next step grounded in observed tool results instead of hidden reasoning.",
    nextStep: "Use this result to choose the next tool or synthesize the final report.",
    evidenceRefs: [],
  };
}

function fallbackDecisionForProgress(
  progress: ToolProgressSummary,
  language: RuntimeMessageLanguage,
  previousDecisions: PublicWorkDecision[],
): Pick<PublicWorkDecision, "summary" | "rationale" | "nextStep" | "evidenceRefs"> {
  if (language === "ko") {
    return {
      summary: progress.workBlockLabel,
      rationale: previousDecisions.length > 0
        ? "앞선 작업에서 확인한 내용을 이어받아 다음 근거를 보강합니다."
        : "요청을 추측으로 처리하지 않도록 먼저 확인 가능한 근거를 확보합니다.",
      nextStep: "확인된 결과를 다음 작업 선택과 최종 보고에 반영합니다.",
      evidenceRefs: previousDecisions.slice(-2).map((decision) => decision.summary),
    };
  }
  return {
    summary: progress.workBlockLabel,
    rationale: previousDecisions.length > 0
      ? "This continues from earlier work decisions and strengthens the next piece of evidence."
      : "This gathers observable evidence before making a claim.",
    nextStep: "Use the result to guide the next tool choice and final report.",
    evidenceRefs: previousDecisions.slice(-2).map((decision) => decision.summary),
  };
}

function publicDecisionText(value: string): string {
  // Public work notes are replayed and injected into later tool turns, so sanitize at the module boundary.
  const sanitized = sanitizePublicText(value, "");
  if (!sanitized) return "";
  if (sanitized.length > 420) return sanitized.slice(0, 420);
  return sanitized;
}

function publicDecisionSentences(value: string): string[] {
  return value
    .split(/(?:\n+|(?<=[.!?。！？])\s+)/u)
    .map((line) => line
      .replace(/^\s*(?:작업|계획|decision|rationale|next)\s*[:：-]\s*/iu, "")
      .trim())
    .filter(Boolean)
    .slice(0, 4);
}

function publicDecisionStructuredFields(value: string): Array<{
  summary?: string;
  rationale?: string;
  nextStep?: string;
  completionObligations?: PublicWorkObligationKind[];
  repaired?: boolean;
}> {
  const decisions: Array<{
    summary?: string;
    rationale?: string;
    nextStep?: string;
    completionObligations?: PublicWorkObligationKind[];
    repaired?: boolean;
  }> = [];
  let current: {
    summary?: string;
    rationale?: string;
    nextStep?: string;
    completionObligations?: PublicWorkObligationKind[];
    repaired?: boolean;
  } = {};
  for (const rawLine of value.split(/\n+/u)) {
    const line = rawLine
      .replace(/^\s*(?:[-*]|\d+[.)])\s*/u, "")
      .trim();
    if (!line) continue;
    const obligationMatch = line.match(/^completion_obligations\s*[:：-]\s*(.+)$/iu);
    if (obligationMatch) {
      const obligations = publicDecisionCompletionObligations(obligationMatch[1] ?? "");
      if (obligations.length > 0) current.completionObligations = obligations;
      else current.repaired = true;
      continue;
    }
    const match = line.match(/^(작업|결정|요약|summary|decision|work|why|이유|근거|rationale|next|다음|다음 단계)\s*[:：-]\s*(.+)$/iu);
    if (!match) continue;
    const key = match[1]?.toLocaleLowerCase("en-US") ?? "";
    const text = publicDecisionText(match[2] ?? "");
    if (/^(작업|결정|요약|summary|decision|work)$/iu.test(key)) {
      if (current.summary || current.rationale || current.nextStep) {
        decisions.push(current);
        current = {};
      }
      if (text) current.summary = text;
      else current.repaired = true;
    } else if (/^(why|이유|근거|rationale)$/iu.test(key)) {
      if (text) current.rationale = text;
      else current.repaired = true;
    } else if (/^(next|다음|다음 단계)$/iu.test(key)) {
      if (text) current.nextStep = text;
      else current.repaired = true;
    }
  }
  if (current.summary || current.rationale || current.nextStep) decisions.push(current);
  return decisions.slice(0, 6);
}

function publicDecisionCompletionObligations(value: string): PublicWorkObligationKind[] {
  const allowed = new Set<PublicWorkObligationKind>([
    "source_verified",
    "command_executed",
    "durable_artifact",
    "data_table_created",
    "chart_rendered",
  ]);
  const seen = new Set<PublicWorkObligationKind>();
  for (const raw of value.split(/[, ]+/u)) {
    const normalized = raw.trim().toLowerCase().replace(/[^a-z_]/gu, "");
    if (!allowed.has(normalized as PublicWorkObligationKind)) continue;
    seen.add(normalized as PublicWorkObligationKind);
  }
  return Array.from(seen).slice(0, 6);
}

function renderPublicDecisionContext(decisions: PublicWorkDecision[]): string {
  const recent = decisions.slice(-6);
  if (recent.length === 0) return "";
  return [
    "## Public Work Decisions",
    ...recent.map((decision, index) => {
      const parts = [
        `${index + 1}. ${decision.summary}`,
        decision.rationale ? `why: ${decision.rationale}` : "",
        decision.nextStep ? `next: ${decision.nextStep}` : "",
        decision.completionObligations && decision.completionObligations.length > 0
          ? `completion_obligations: ${decision.completionObligations.join(", ")}`
          : "",
        decision.evidenceRefs.length > 0 ? `refs: ${decision.evidenceRefs.slice(0, 3).join("; ")}` : "",
      ].filter(Boolean);
      return parts.join(" | ");
    }),
  ].join("\n");
}
