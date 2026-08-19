import type { ButlerToolCall } from "../../tools/butler-tools.ts";
import {
  AUTHORITY_DENIAL_TEXT,
  type PrincipalAuthority,
} from "../authority/index.ts";
import type { DurableWorkView } from "../work/index.ts";
import type { GuidedToolJournal } from "../ports/guided-tool-journal.ts";
import { ordinaryGuidedEffectError } from "./guided-persistent-effect-resolution.ts";

type AuthorityExecution = Awaited<ReturnType<PrincipalAuthority["execution"]>>;

export function resolveGuidedAuthorityContinuation(input: {
  authority?: PrincipalAuthority;
  requestRef: string;
  ownerSessionId?: string;
  sourceTurnId?: string;
  clientMessageId?: string;
  workspacePath?: string;
  sourceWorkId: string;
  call: ButlerToolCall;
}):
  | { ok: true; execution: AuthorityExecution; effectiveCall: ButlerToolCall }
  | { ok: false; result: Record<string, unknown> } {
  if (!input.authority) {
    return failedContinuation("authority_context_missing", "The approved command authority is unavailable.");
  }
  if (!input.ownerSessionId) {
    return failedContinuation("authority_context_missing", "The approved command owner session is unavailable.");
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
      sourceSessionId: input.ownerSessionId,
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
      execution.sourceSessionId !== input.ownerSessionId ||
      !input.workspacePath || execution.workspacePath !== input.workspacePath) {
    return failedContinuation(
      "authority_request_identity_mismatch",
      "The approved command is bound to a different Work or session.",
    );
  }
  if (execution.decision === "denied") {
    return {
      ok: false,
      result: ordinaryGuidedEffectError(
        "authority_request_denied",
        AUTHORITY_DENIAL_TEXT,
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
  return {
    ok: true,
    execution,
    effectiveCall: {
      ...input.call,
      args: execution.normalizedInput,
      rawArguments: JSON.stringify(execution.normalizedInput),
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
  requestRef: string | undefined,
  turnId: string,
  clientMessageId: string | undefined,
): { privateContinuationInput?: string } {
  const value = loadPrivateModifyContinuationInput({
    authority,
    ownerSessionId,
    requestRef,
    turnId,
    clientMessageId,
  });
  return value ? { privateContinuationInput: value } : {};
}

function loadPrivateModifyContinuationInput(input: {
  authority?: PrincipalAuthority;
  ownerSessionId: string;
  requestRef?: string;
  turnId: string;
  clientMessageId?: string;
}): string | undefined {
  if (!input.authority || !input.requestRef || !input.clientMessageId) return undefined;
  try {
    const execution = input.authority.execution({
      ownerSessionId: input.ownerSessionId,
      requestRef: input.requestRef,
      sourceSessionId: input.ownerSessionId,
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

function failedContinuation(code: string, message: string): { ok: false; result: Record<string, unknown> } {
  return { ok: false, result: ordinaryGuidedEffectError(code, message) };
}
