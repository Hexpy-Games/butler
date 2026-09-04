import type { ButlerToolCall } from "../../tools/butler-tools.ts";
import {
  AUTHORITY_DENIAL_TEXT,
  AUTHORITY_EFFECT_DENIAL_TEXT,
  type PrincipalAuthority,
} from "../authority/index.ts";
import type { DurableWorkView } from "../work/index.ts";
import type { GuidedToolJournal, GuidedToolJournalRecord } from "../ports/guided-tool-journal.ts";
import { ordinaryGuidedEffectError } from "./guided-persistent-effect-resolution.ts";
import { digest } from "../identity/index.ts";
import type { BtccAgentLoopToolCall } from "./contracts.ts";
import { normalizeGuidedToolCall } from "../../tools/tool-call-normalization.ts";

type AuthorityExecution = Awaited<ReturnType<PrincipalAuthority["execution"]>>;

export function restoredAuthorityToolCall(input: {
  authority?: PrincipalAuthority;
  toolJournal: GuidedToolJournal;
  ownerSessionId: string;
  sourceSessionId: string;
  requestRef?: string;
  turnId: string;
  clientMessageId?: string;
}): BtccAgentLoopToolCall | undefined {
  if (!input.requestRef) return undefined;
  if (!input.authority || !input.clientMessageId) {
    throw new Error("authority_context_missing");
  }
  const execution = input.authority.execution({
    ownerSessionId: input.ownerSessionId,
    sourceSessionId: input.sourceSessionId,
    requestRef: input.requestRef,
    turnId: input.turnId,
    clientMessageId: input.clientMessageId,
  });
  // Modify must first go through the existing replan path, not execute the
  // operation that the user asked to change.
  if (execution.decision === "modified") return undefined;
  const original = originalAuthorityToolCall(input.toolJournal, execution);
  if (!original) throw new Error("authority_source_call_missing");
  const rawArguments = JSON.parse(original.rawArguments) as Record<string, unknown>;
  const progressive = normalizeGuidedToolCall({ toolName: "tool_call", args: rawArguments }).name === original.toolName;
  const name = progressive ? "tool_call" : original.toolName;
  const arguments_ = progressive ? rawArguments : original.arguments;
  return {
    id: `authority-resume-${digest(`${input.turnId}\0${input.requestRef}`).slice(0, 24)}`,
    name,
    arguments: arguments_,
    rawArguments: JSON.stringify(arguments_),
  };
}

function originalAuthorityToolCall(
  journal: GuidedToolJournal | undefined,
  execution: AuthorityExecution,
): GuidedToolJournalRecord | undefined {
  const name = execution.capability === "run_command_remote_observation"
    ? "run_command" : execution.capability;
  // The loop suspends at the first pending operation. Its source Turn journal
  // retains the original public invocation, separately from normalized effect input.
  const calls = journal?.list(execution.sourceTurnId).filter((call) => {
    const result = call.result;
    return call.toolName === name && (call.status === "started" ||
      (call.status === "completed" && result !== null && typeof result === "object" &&
        "authority_pending" in result && result.authority_pending === true));
  }) ?? [];
  return calls.length === 1 ? calls[0] : undefined;
}

export function resolveGuidedAuthorityContinuation(input: {
  authority?: PrincipalAuthority;
  toolJournal?: GuidedToolJournal;
  requestRef: string;
  ownerSessionId?: string;
  sourceSessionId?: string;
  sourceTurnId?: string;
  clientMessageId?: string;
  workspacePath?: string;
  sourceWorkId: string;
  call: ButlerToolCall;
}):
  | { ok: true; execution: AuthorityExecution; effectiveCall: ButlerToolCall }
  | {
      ok: false;
      consumesRequest: boolean;
      result: Record<string, unknown>;
    } {
  if (!input.authority) {
    return failedContinuation("authority_context_missing", "The approved command authority is unavailable.");
  }
  if (!input.ownerSessionId) {
    return failedContinuation("authority_context_missing", "The approved command owner session is unavailable.");
  }
  if (!input.sourceSessionId) {
    return failedContinuation("authority_context_missing", "The approved command source session is unavailable.");
  }
  if (!input.sourceTurnId) {
    return failedContinuation("authority_context_missing", "The approved command source Turn is unavailable.");
  }
  if (!input.clientMessageId) {
    return failedContinuation("authority_context_missing", "The approved command queue identity is unavailable.");
  }

  let execution: AuthorityExecution;
  try {
    execution = input.authority.execution({
      ownerSessionId: input.ownerSessionId,
      requestRef: input.requestRef,
      sourceSessionId: input.sourceSessionId,
      clientMessageId: input.clientMessageId,
      turnId: input.sourceTurnId,
    });
  } catch (error) {
    return failedContinuation(
      error instanceof Error ? error.message : "authority_request_not_found",
      "The approved command identity is unavailable.",
    );
  }
  if (execution.sourceWorkId !== input.sourceWorkId ||
      execution.sourceTurnId === input.sourceTurnId ||
      execution.sourceSessionId !== input.sourceSessionId ||
      !input.workspacePath || execution.workspacePath !== input.workspacePath) {
    return failedContinuation(
      "authority_request_identity_mismatch",
      "The approved command is bound to a different Work or session.",
    );
  }
  if (execution.decision === "denied") {
    return {
      ok: false,
      consumesRequest: true,
      result: ordinaryGuidedEffectError(
        "authority_request_denied",
        execution.category === "reviewed_effect"
          ? AUTHORITY_EFFECT_DENIAL_TEXT
          : AUTHORITY_DENIAL_TEXT,
        { next_action: "Report the denial or choose a non-effectful alternative." },
      ),
    };
  }
  const modified = execution.decision === "modified";
  if (!modified && execution.capability !== input.call.name &&
      execution.capability !== "run_command_remote_observation") {
    return failedContinuation(
      "authority_request_identity_mismatch",
      "The approved command capability changed before execution.",
    );
  }
  if (modified) return { ok: true, execution, effectiveCall: input.call };
  if (execution.outcome !== "pending") {
    return failedContinuation(
      "authority_request_outcome_fenced",
      "The approved command already has a durable outcome.",
    );
  }
  const original = originalAuthorityToolCall(input.toolJournal, execution);
  if (!original) {
    return failedContinuation("authority_source_call_missing", "The original approved operation is unavailable.");
  }
  return {
    ok: true,
    execution,
    effectiveCall: {
      ...input.call,
      args: original.arguments,
      rawArguments: JSON.stringify(original.arguments),
    },
  };
}

export function hasModifyReplanProvenance(input: {
  toolJournal: GuidedToolJournal;
  work: DurableWorkView;
  priorPlanRevisionId: string;
  sourceTurnId: string;
}): boolean {
  const plan = input.work.currentPlan;
  const review = input.work.latestPlanReview;
  if (!plan || plan.planRevisionId === input.priorPlanRevisionId ||
      plan.originTurnId !== input.sourceTurnId ||
      !review || review.subject !== "plan" || review.verdict !== "accept" ||
      review.boundPlanRevisionId !== plan.planRevisionId ||
      review.originTurnId !== input.sourceTurnId) return false;
  const calls = input.toolJournal.list(input.sourceTurnId);
  return calls.some((call) =>
    call.toolName === "replace_work_plan" && call.status === "completed",
  ) && calls.some((call) =>
    call.toolName === "record_work_review" && call.status === "completed" &&
    call.arguments.subject === "plan" && call.arguments.verdict === "accept",
  ) && calls.some((call) =>
    call.toolName === "continue_work" && call.status === "completed" &&
    call.arguments.work_id === input.work.workId,
  );
}

export function privateModifyContinuationPromptInput(
  authority: PrincipalAuthority | undefined,
  ownerSessionId: string,
  sourceSessionId: string,
  requestRef: string | undefined,
  turnId: string,
  clientMessageId: string | undefined,
): { privateContinuationInput?: string } {
  const value = loadPrivateModifyContinuationInput({
    authority,
    ownerSessionId,
    sourceSessionId,
    requestRef,
    turnId,
    clientMessageId,
  });
  return value ? { privateContinuationInput: value } : {};
}

function loadPrivateModifyContinuationInput(input: {
  authority?: PrincipalAuthority;
  ownerSessionId: string;
  sourceSessionId: string;
  requestRef?: string;
  turnId: string;
  clientMessageId?: string;
}): string | undefined {
  if (!input.authority || !input.requestRef || !input.clientMessageId) return undefined;
  try {
    const execution = input.authority.execution({
      ownerSessionId: input.ownerSessionId,
      requestRef: input.requestRef,
      sourceSessionId: input.sourceSessionId,
      clientMessageId: input.clientMessageId,
      turnId: input.turnId,
    });
    return execution.decision === "modified" ? execution.alternativeInput : undefined;
  } catch {
    return undefined;
  }
}

export function renderPrivateModifyContinuationInput(value: string | undefined): string {
  if (!value?.trim()) return "";
  return [
    "## Private authority continuation input",
    "This instruction is private model input for the exact scheduled Turn. Do not quote, summarize, project, log, or expose it to the user.",
    value.slice(0, 16_384),
  ].join("\n\n");
}

function failedContinuation(
  code: string,
  message: string,
): { ok: false; consumesRequest: false; result: Record<string, unknown> } {
  return {
    ok: false,
    consumesRequest: false,
    result: ordinaryGuidedEffectError(code, message),
  };
}
