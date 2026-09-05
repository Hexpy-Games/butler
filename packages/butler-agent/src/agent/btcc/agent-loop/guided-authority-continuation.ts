import type { ButlerToolCall } from "../../tools/butler-tools.ts";
import type { PrincipalAuthority } from "../authority/index.ts";
import type { GuidedToolJournal } from "../ports/guided-tool-journal.ts";
import type { TurnRecord } from "../turn/index.ts";
import type { AuthorityLoopDecision } from "./loop-continuation.ts";
import { ordinaryGuidedEffectError } from "./guided-persistent-effect-resolution.ts";

export function guidedAuthorityLoopDecision(input: {
  authority?: PrincipalAuthority; turn: TurnRecord; ownerSessionId: string;
}): AuthorityLoopDecision | undefined {
  const cursor = input.turn.authorityContinuation;
  if (!cursor) return undefined;
  if (!input.authority) throw new Error("authority_context_missing");
  const execution = input.authority.execution({
    requestRef: cursor.requestRef, ownerSessionId: input.ownerSessionId,
    sourceSessionId: input.turn.sessionId, turnId: input.turn.turnId,
  });
  if (execution.sourceCallId !== cursor.callId) throw new Error("authority_source_call_mismatch");
  return execution.decision === "modified"
    ? { action: "modify", input: execution.alternativeInput! }
    : { action: execution.decision === "allowed" ? "allow" : "deny" };
}

/** Only the accepted, durable occurrence can consume this permission. */
export function resolveGuidedAuthorityContinuation(input: {
  authority?: PrincipalAuthority; toolJournal?: GuidedToolJournal;
  requestRef: string; ownerSessionId?: string; sourceSessionId?: string;
  sourceTurnId?: string; clientMessageId?: string; workspacePath?: string;
  sourceWorkId: string; call: ButlerToolCall; occurrenceId?: string;
}):
  | { ok: true; execution: ReturnType<PrincipalAuthority["execution"]>; effectiveCall: ButlerToolCall }
  | { ok: false; consumesRequest: boolean; result: Record<string, unknown> } {
  try {
    if (!input.authority || !input.ownerSessionId || !input.sourceSessionId || !input.sourceTurnId)
      throw new Error("authority_context_missing");
    const execution = input.authority.execution({
      ownerSessionId: input.ownerSessionId, sourceSessionId: input.sourceSessionId,
      turnId: input.sourceTurnId, requestRef: input.requestRef,
    });
    if (execution.sourceWorkId !== input.sourceWorkId ||
        execution.workspacePath !== input.workspacePath ||
        !execution.sourceCallId || execution.sourceCallId !== input.occurrenceId ||
        execution.decision !== "allowed") throw new Error("authority_request_identity_mismatch");
    return { ok: true, execution, effectiveCall: input.call };
  } catch (error) {
    return { ok: false, consumesRequest: false, result: ordinaryGuidedEffectError(
      error instanceof Error ? error.message : "authority_request_not_found",
      "The permission does not belong to this operation.",
    ) };
  }
}

export function renderPrivateModifyContinuationInput(value: string | undefined): string {
  return value?.trim() ? value : "";
}
