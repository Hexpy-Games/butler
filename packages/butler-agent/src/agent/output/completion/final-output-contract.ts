import { sanitizePublicText } from "../../events/turn-events.ts";
import type {
  PublicWorkDecision,
  ToolAuditEntry,
} from "../../tools/tool-support.ts";
import {
  finalResultEvidenceRepairInstructions,
  goalCompletionEvidenceReviewInstructions,
  renderCompletionEvidenceForReview,
} from "./obligation-review.ts";

const FINAL_DECISION_LEAK_SAMPLE_CHARS = 1_200;
const FINAL_TOOL_LEAK_SAMPLE_CHARS = 2_500;
export {
  completionObligationIncompleteReason,
  requiredCompletionObligations,
  reviewCompletionObligations,
  unsatisfiedCompletionObligations,
} from "./obligation-review.ts";

export function finalResultContractRepairPrompt(input: {
  prompt: string;
  previousAnswer: string;
  audit: ToolAuditEntry[];
  decisions: PublicWorkDecision[];
}): string {
  return [
    "## Final Result Contract Repair",
    "The previous final answer exposed public work decision fields as the result.",
    "Then rewrite the final answer as the user-facing outcome report only.",
    "Do not include public work decision protocol keys (`title:`, `summary:`, `rationale:`, `next_step:`), legacy `작업/이유/다음` or `Work/Why/Next`, raw tool ids, tool-call order, public_work_decision_context, or raw tool logs.",
    "Preserve the active persona, user language, and any current-turn Active Persona Reminder while rewriting.",
    ...finalResultEvidenceRepairInstructions(),
    "",
    "Original request:",
    input.prompt,
    "",
    renderCompletionEvidenceForReview(input.audit, input.decisions),
    "",
    "Previous invalid final answer:",
    input.previousAnswer.trim(),
  ].join("\n");
}

export function goalCompletionReviewPrompt(input: {
  prompt: string;
  previousAnswer: string;
  audit: ToolAuditEntry[];
  decisions: PublicWorkDecision[];
}): string {
  return [
    "## Goal Completion Review",
    "Review the previous answer against the user's original request and the observed native tool evidence.",
    "This is a generic completion review for every native tool. Do not apply hardcoded rules for any specific tool.",
    "This review is an action gate, not an explanation gate: if the task can still be advanced with an available tool, call the tool instead of returning an incomplete final answer.",
    "If the previous answer is only a work decision, process note, or public work decision protocol block, it is not a final answer. Continue by calling an appropriate available tool when the tool catalog can advance the request.",
    "If the previous answer fully satisfies the user's requested outcome, return the final user-facing answer only.",
    "Preserve the active persona, user language, and any current-turn Active Persona Reminder in that final user-facing answer.",
    "Attached native tool schemas are the source of truth for available capabilities and required inputs. Do not claim that a tool or input format is unavailable before comparing the missing outcome with those schemas.",
    ...goalCompletionEvidenceReviewInstructions(),
    "Do not ask the user to rerun or send the same request again. Continue autonomously unless the task is impossible to continue without a principal decision.",
    "Do not include raw tool ids, tool-call order, public_work_decision_context, or raw tool logs in the final answer.",
    "",
    "Original request:",
    input.prompt,
    "",
    renderCompletionEvidenceForReview(input.audit, input.decisions),
    "",
    "Previous answer to review:",
    input.previousAnswer.trim(),
  ].join("\n");
}

export function goalCompletionIncompleteContinuationPrompt(input: {
  prompt: string;
  previousAnswer: string;
  incompleteReason: string;
  audit: ToolAuditEntry[];
  decisions: PublicWorkDecision[];
}): string {
  return [
    "## Goal Completion Incomplete Continuation",
    "The previous completion review returned `INCOMPLETE`, so the turn is not deliverable yet.",
    "Do not treat that as a final answer. Continue the original user request now.",
    "If an available native tool can advance the missing requested outcome, call that tool.",
    "If the missing outcome can be completed by inspecting local files, running checks, editing files, committing, or reading durable state, use the relevant native tool instead of stopping.",
    "Return `INCOMPLETE: <safe user-facing reason>` only when no available tool can advance the missing outcome or a principal decision is required.",
    "Preserve the active persona, user language, and any current-turn Active Persona Reminder.",
    "",
    "Incomplete reason:",
    input.incompleteReason,
    "",
    "Original request:",
    input.prompt,
    "",
    renderCompletionEvidenceForReview(input.audit, input.decisions),
    "",
    "Previous incomplete answer:",
    input.previousAnswer.trim(),
  ].join("\n");
}

export function containsFinalPublicWorkDecisionLeak(value: string): boolean {
  const sample = value.trimStart().slice(0, FINAL_DECISION_LEAK_SAMPLE_CHARS);
  const hasTitle = /(?:^|\n)\s*(?:[-*]|\d+[.)])?\s*(?:title|제목)\s*[:：-]\s*\S/iu.test(sample);
  const hasWork = /(?:^|\n)\s*(?:[-*]|\d+[.)])?\s*(?:작업|work|summary)\s*[:：-]\s*\S/iu.test(sample);
  const hasWhy = /(?:^|\n)\s*(?:[-*]|\d+[.)])?\s*(?:이유|근거|why|rationale)\s*[:：-]\s*\S/iu.test(sample);
  const hasNext = /(?:^|\n)\s*(?:[-*]|\d+[.)])?\s*(?:다음|다음 단계|next|next_step)\s*[:：-]\s*\S/iu.test(sample);
  const startsWithDecision = /^\s*(?:[-*]|\d+[.)])?\s*(?:title|제목|작업|work|summary)\s*[:：-]\s*\S/iu.test(sample);
  return hasWork && hasWhy && (hasNext || startsWithDecision || hasTitle);
}

export function containsFinalToolImplementationLeak(value: string, toolNames: string[]): boolean {
  const sample = value.slice(0, FINAL_TOOL_LEAK_SAMPLE_CHARS);
  if (
    /FileNotFoundException|stack trace|tool_call|raw tool|raw payload|public_work_decision|completion_obligations|previous turn|the system|\b(?:task|worker|planned)-[A-Za-z0-9][A-Za-z0-9._-]{1,}\b/iu.test(sample) ||
    containsFinalReviewProtocolLeak(sample)
  ) {
    return true;
  }
  return sample.split(/\r?\n/u).some((line) => containsToolExecutionLeakLine(line, toolNames));
}

export function completionReviewIncompleteReason(value: string): string | null {
  const match = value.trim().match(/^(?:INCOMPLETE|미완료)\s*[:：]\s*(.+)$/isu);
  const reason = match?.[1]?.trim();
  if (!reason) {
    return null;
  }
  const sanitized = sanitizePublicText(reason, "Butler could not complete this turn.");
  return sanitized || "Butler could not complete this turn.";
}

export function stripLeadingPublicWorkDecisionBlock(value: string): string {
  const lines = value.split(/\r?\n/u);
  let index = 0;
  let sawField = false;
  while (index < lines.length) {
    const line = lines[index]?.trim() ?? "";
    if (!line) {
      index += 1;
      if (sawField) continue;
      continue;
    }
    if (
      /^(?:[-*]|\d+[.)])?\s*(?:title|제목|작업|work|summary|이유|근거|why|rationale|다음|다음 단계|next|next_step|expected_effect|repeat_reason)\s*[:：-]/iu
        .test(line)
    ) {
      sawField = true;
      index += 1;
      continue;
    }
    break;
  }
  const stripped = lines.slice(index).join("\n").trim();
  return stripped;
}

export function stripToolImplementationLeakLines(value: string, toolNames: string[]): string {
  const explicitFinal = finalAnswerSegmentFromProtocolLeak(value);
  if (explicitFinal) {
    return explicitFinal;
  }
  const leaked = [
    "FileNotFoundException",
    "stack trace",
    "tool_call",
    "raw tool",
    "raw payload",
    "public_work_decision",
    "completion_obligations",
    "previous turn",
    "the system",
    "Goal Completion Review",
    "Final Result Contract Repair",
    "previous answer",
    "Previous answer",
    "review concludes",
    "I will return",
    "Preserve persona",
  ].filter(Boolean);
  const lines = value.split(/\r?\n/u)
    .filter((line) =>
      !leaked.some((marker) => line.includes(marker)) &&
      !containsToolExecutionLeakLine(line, toolNames) &&
      !/\b(?:task|worker|planned)-[A-Za-z0-9][A-Za-z0-9._-]{1,}\b/iu.test(line),
    );
  const stripped = lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
  return stripped;
}

function containsToolExecutionLeakLine(line: string, toolNames: string[]): boolean {
  if (!toolNames.some((name) => name && line.includes(name))) return false;
  return /\b(?:called|calling|call|used|using|ran|run|executed|executing|invoke|invoked|created artifact|tool output|tool result)\b|(?:도구\s*(?:호출|실행|사용|결과|출력|로그)|호출한\s*도구|실행한\s*도구|사용한\s*도구)/iu.test(line);
}

function containsFinalReviewProtocolLeak(value: string): boolean {
  return /Goal Completion Review|Final Result Contract Repair|previous answer|Previous answer|review concludes|I will return only the final user-facing answer|Preserve persona|as instructed by|One detail check/iu
    .test(value);
}

function finalAnswerSegmentFromProtocolLeak(value: string): string {
  if (!containsFinalReviewProtocolLeak(value)) return "";
  const masked = value.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, (block) =>
    " ".repeat(block.length),
  );
  const marker = /(?:^|\n)\s*(?:\*\*)?Final Answer(?:\*\*)?\s*[:：]\s*/giu;
  let latestEnd: number | null = null;
  for (const match of masked.matchAll(marker)) {
    if (match.index === undefined) continue;
    latestEnd = match.index + match[0].length;
  }
  if (latestEnd === null) return "";
  const segment = value.slice(latestEnd).replace(/\n{3,}/gu, "\n\n").trim();
  return sanitizePublicText(segment, "").trim();
}
