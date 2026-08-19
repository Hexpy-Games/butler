import type {
  EffectAdapter,
  EffectAdapterError,
  GuidedEffectAccessMode,
  GuidedEffectService,
} from "../effects/index.ts";
import type {
  DurableWorkView,
  DurableWorkService,
  WorkTurnScope,
} from "../work/index.ts";
import type {
  ButlerToolCall,
  ButlerToolExecutionBoundary,
} from "../../tools/butler-tools.ts";
import type {
  AuthorityCommandInput,
  PrincipalAuthority,
} from "../authority/index.ts";
import type { GuidedToolJournal } from "../ports/guided-tool-journal.ts";
import {
  acceptedGuidedPlanActionKey,
  deferredGuidedAuthorityResult,
  guidedEffectReceipt,
  loadGuidedEffectWork,
  ordinaryGuidedEffectError,
  sameGuidedEffectJson,
  unavailableGuidedEffect,
} from "./guided-persistent-effect-resolution.ts";
import {
  hasModifyReplanProvenance,
  resolveGuidedAuthorityContinuation,
} from "./guided-authority-continuation.ts";

export type GuidedPersistentEffectRequest = {
  target: string;
  input: unknown;
  adapter: EffectAdapter<unknown, unknown>;
};

export type GuidedPersistentEffectResolution =
  | GuidedPersistentEffectRequest
  | { error: EffectAdapterError };

export type GuidedPersistentEffectContext = {
  work: DurableWorkView;
  occurrenceId?: string;
};

type GuidedToolExecutionBoundaryInput = {
  durableWork: DurableWorkService;
  workScope: WorkTurnScope;
  effectService: GuidedEffectService;
  authority: PrincipalAuthority;
  ownerSessionId?: string;
  sourceTurnId?: string;
  modelRef?: string;
  reasoningEffort?: string;
  workspacePath?: string;
  authorityRequestRef?: string;
  authorityClientMessageId?: string;
  toolJournal?: GuidedToolJournal;
  accessMode: GuidedEffectAccessMode;
  signal: AbortSignal;
  executeCommand(
    call: ButlerToolCall,
    executeRegistered: () => Promise<unknown>,
  ): Promise<unknown>;
  resolvePersistentEffect(
    call: ButlerToolCall,
    execute: (prepared?: {
      args: ButlerToolCall["args"];
      rawArguments?: ButlerToolCall["rawArguments"];
    }) => Promise<unknown>,
    context: GuidedPersistentEffectContext,
  ):
    | GuidedPersistentEffectResolution
    | null
    | Promise<GuidedPersistentEffectResolution | null>;
};

type LegacyGuidedToolExecutionBoundaryInput = Omit<
  GuidedToolExecutionBoundaryInput,
  "authority"
> & {
  accessMode: Exclude<GuidedEffectAccessMode, "ask_first">;
  authorityRequestRef?: never;
};

export function createGuidedToolExecutionBoundary(
  input: GuidedToolExecutionBoundaryInput,
): ButlerToolExecutionBoundary;
export function createGuidedToolExecutionBoundary(
  input: LegacyGuidedToolExecutionBoundaryInput,
): ButlerToolExecutionBoundary;
export function createGuidedToolExecutionBoundary(
  input: GuidedToolExecutionBoundaryInput | LegacyGuidedToolExecutionBoundaryInput,
): ButlerToolExecutionBoundary {
  const authority = "authority" in input ? input.authority : undefined;
  const executePersistentEffect = async (
    call: ButlerToolCall,
    execute: (prepared?: {
      args: ButlerToolCall["args"];
      rawArguments?: ButlerToolCall["rawArguments"];
    }) => Promise<unknown>,
    occurrenceId?: string,
  ): Promise<unknown> => {
    const work = await loadGuidedEffectWork(input.durableWork, input.workScope);
    if (!work) {
      return ordinaryGuidedEffectError(
        "effect_work_required",
        "Create concise Work, record its Plan Review, then retry this persistent effect.",
      );
    }
    let authorityExecution: Awaited<ReturnType<PrincipalAuthority["execution"]>> | undefined;
    let effectiveCall = call;
    if (input.authorityRequestRef) {
      const continuation = resolveGuidedAuthorityContinuation({
        authority,
        requestRef: input.authorityRequestRef,
        ownerSessionId: input.ownerSessionId,
        sourceTurnId: input.sourceTurnId,
        clientMessageId: input.authorityClientMessageId,
        workspacePath: input.workspacePath,
        sourceWorkId: work.workId,
        call,
      });
      if (!continuation.ok) return continuation.result;
      authorityExecution = continuation.execution;
      effectiveCall = continuation.effectiveCall;
    }
    const effectOccurrenceId = authorityExecution
      ? `authority:${authorityExecution.requestRef}`
      : occurrenceId;
    const resolution = await input.resolvePersistentEffect(effectiveCall, execute, {
      work,
      ...(effectOccurrenceId ? { occurrenceId: effectOccurrenceId } : {}),
    });
    if (!resolution) return unavailableGuidedEffect(call.name);
    if ("error" in resolution) {
      return ordinaryGuidedEffectError(
        resolution.error.code,
        resolution.error.message,
      );
    }
    const approvedAuthorityExecution = authorityExecution?.decision === "allowed"
      ? authorityExecution
      : undefined;
    if (approvedAuthorityExecution && (
      resolution.target !== approvedAuthorityExecution.normalizedTarget ||
      !sameGuidedEffectJson(resolution.input, approvedAuthorityExecution.normalizedInput)
    )) {
      return ordinaryGuidedEffectError(
        "authority_request_identity_mismatch",
        "The stored command identity changed before execution.",
      );
    }
    if ((!authorityExecution || authorityExecution.decision === "modified") &&
        input.accessMode === "ask_first") {
      if (!authority) {
        return ordinaryGuidedEffectError(
          "authority_context_missing",
          "The command authority context is unavailable.",
        );
      }
      if (!input.ownerSessionId || !input.sourceTurnId || !input.modelRef ||
          !input.reasoningEffort || !input.workspacePath) {
        return ordinaryGuidedEffectError(
          "authority_context_missing",
          "The command authority context is unavailable.",
        );
      }
      const normalizedInput = resolution.adapter.normalizeInput(
        resolution.input,
      ) as AuthorityCommandInput;
      const planRevisionId = work.currentPlan?.planRevisionId;
      if (!planRevisionId) {
        return ordinaryGuidedEffectError(
          "effect_plan_review_required",
          "The current Plan revision is required before requesting Allow.",
        );
      }
      const actionKey = acceptedGuidedPlanActionKey(
        work,
        resolution.adapter.capability,
        resolution.target,
      );
      if (!actionKey.ok) {
        return ordinaryGuidedEffectError(actionKey.code, actionKey.message);
      }
      const authorityGeneration = authorityExecution?.decision === "modified"
        ? authorityExecution.authorityGeneration + 1
        : 1;
      if (authorityExecution?.decision === "modified" &&
          (!input.toolJournal ||
            !hasModifyReplanProvenance({
              toolJournal: input.toolJournal,
              work,
              priorPlanRevisionId: authorityExecution.planRevisionId,
              sourceTurnId: input.sourceTurnId!,
            }))) {
        return ordinaryGuidedEffectError(
          "authority_modify_replan_required",
          "The replacement command requires a new Plan and accepted Review in this scheduled Turn.",
        );
      }
      try {
        const admission = authority.admit({
          ownerSessionId: input.ownerSessionId,
          sourceSessionId: input.ownerSessionId,
          sourceTurnId: input.sourceTurnId,
          sourceWorkId: work.workId,
          workspacePath: input.workspacePath,
          planRevisionId,
          actionKey: actionKey.value,
          authorityGeneration,
          capability: resolution.adapter.capability,
          target: resolution.target,
          normalizedInput,
          modelRef: input.modelRef,
          reasoningEffort: input.reasoningEffort,
        });
        if (admission.status === "denied") {
          return ordinaryGuidedEffectError(
            "authority_request_denied",
            admission.denialText,
            { next_action: "Report the denial or choose a non-effectful alternative." },
          );
        }
        if (admission.status === "modified") {
          return ordinaryGuidedEffectError(
            "authority_request_modified",
            "The reviewed command was replaced before it could run.",
          );
        }
      } catch (error) {
        return ordinaryGuidedEffectError(
          error instanceof Error ? error.message : "authority_request_identity_mismatch",
          "The command authority identity could not be admitted.",
        );
      }
      return deferredGuidedAuthorityResult();
    } else if (approvedAuthorityExecution) {
      const actionKey = acceptedGuidedPlanActionKey(
        work,
        resolution.adapter.capability,
        resolution.target,
      );
      if (!actionKey.ok) {
        return ordinaryGuidedEffectError(actionKey.code, actionKey.message);
      }
      if (work.currentPlan?.planRevisionId !== approvedAuthorityExecution.planRevisionId ||
          actionKey.value !== approvedAuthorityExecution.actionKey) {
        return ordinaryGuidedEffectError(
          "authority_request_identity_mismatch",
          "The approved command is no longer bound to the accepted Plan action.",
        );
      }
    }
    const outcome = await input.effectService.execute({
      work,
      accessMode: approvedAuthorityExecution
        ? "full_access"
        : input.accessMode,
      occurrenceId: effectOccurrenceId,
      signal: call.signal ?? input.signal,
      target: resolution.target,
      input: resolution.input,
      adapter: resolution.adapter,
    });
    if (approvedAuthorityExecution) {
      authority!.recordOutcome({
        requestRef: input.authorityRequestRef!,
        ownerSessionId: input.ownerSessionId!,
        sourceWorkId: work.workId,
        status: outcome.ok ? "applied" : "failed",
        ...(outcome.ok ? { receipt: outcome.receipt } : {}),
      });
    }
    if (!outcome.ok) {
      return ordinaryGuidedEffectError(outcome.error.code, outcome.error.message, {
        effect_status: outcome.status,
      });
    }
    return guidedEffectReceipt(outcome.result, {
      receipt_id: outcome.receipt.receiptId,
      capability: outcome.receipt.capability,
      target: outcome.receipt.sanitizedTarget,
      applied_at: outcome.receipt.appliedAt,
      replayed: outcome.replayed,
    });
  };

  return async ({ call, context, definition, execute }) => {
    if (definition.effectBoundary === "none" ||
        definition.effectBoundary === "turn_local") {
      return execute();
    }
    if (definition.effectBoundary === "dynamic") {
      if (call.name === "tool_call") return execute();
      if (call.name === "run_command") {
        return call.args.state_effect === "mutation" ||
            call.args.state_effect === "remote_observation"
          ? executePersistentEffect(call, execute, context.effectOccurrenceId)
          : input.executeCommand(call, execute);
      }
      if (call.name === "call_mcp_tool") {
        return executePersistentEffect(
          call,
          execute,
          context.effectOccurrenceId,
        );
      }
      return unavailableGuidedEffect(call.name);
    }
    return executePersistentEffect(call, execute, context.effectOccurrenceId);
  };
}
