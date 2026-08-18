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
import {
  acceptedGuidedPlanActionKey,
  deferredGuidedAuthorityResult,
  guidedEffectReceipt,
  loadGuidedEffectWork,
  ordinaryGuidedEffectError,
  sameGuidedEffectJson,
  unavailableGuidedEffect,
} from "./guided-persistent-effect-resolution.ts";

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
      if (!authority) {
        return ordinaryGuidedEffectError(
          "authority_context_missing",
          "The approved command authority is unavailable.",
        );
      }
      if (!input.ownerSessionId) {
        return ordinaryGuidedEffectError(
          "authority_context_missing",
          "The approved command owner session is unavailable.",
        );
      }
      try {
        authorityExecution = authority.execution({
          ownerSessionId: input.ownerSessionId,
          requestRef: input.authorityRequestRef,
        });
      } catch (error) {
        return ordinaryGuidedEffectError(
          error instanceof Error ? error.message : "authority_request_not_found",
          "The approved command identity is unavailable.",
        );
      }
      if (authorityExecution.sourceWorkId !== work.workId ||
          authorityExecution.sourceTurnId === input.sourceTurnId ||
          authorityExecution.sourceSessionId !== input.ownerSessionId ||
          !input.workspacePath ||
          authorityExecution.workspacePath !== input.workspacePath ||
          authorityExecution.capability !== call.name &&
            authorityExecution.capability !== "run_command_remote_observation") {
        return ordinaryGuidedEffectError(
          "authority_request_identity_mismatch",
          "The approved command is bound to a different Work or session.",
        );
      }
      effectiveCall = {
        ...call,
        args: authorityExecution.normalizedInput,
        rawArguments: JSON.stringify(authorityExecution.normalizedInput),
      };
      if (authorityExecution.outcome !== "pending") {
        return ordinaryGuidedEffectError(
          "authority_request_outcome_fenced",
          "The approved command already has a durable outcome.",
        );
      }
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
    if (authorityExecution && (
      resolution.target !== authorityExecution.normalizedTarget ||
      !sameGuidedEffectJson(resolution.input, authorityExecution.normalizedInput)
    )) {
      return ordinaryGuidedEffectError(
        "authority_request_identity_mismatch",
        "The stored command identity changed before execution.",
      );
    }
    if (!authorityExecution && input.accessMode === "ask_first") {
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
      try {
        authority.admit({
          ownerSessionId: input.ownerSessionId,
          sourceSessionId: input.ownerSessionId,
          sourceTurnId: input.sourceTurnId,
          sourceWorkId: work.workId,
          workspacePath: input.workspacePath,
          planRevisionId,
          actionKey: actionKey.value,
          authorityGeneration: 1,
          capability: resolution.adapter.capability,
          target: resolution.target,
          normalizedInput,
          modelRef: input.modelRef,
          reasoningEffort: input.reasoningEffort,
        });
      } catch (error) {
        return ordinaryGuidedEffectError(
          error instanceof Error ? error.message : "authority_request_identity_mismatch",
          "The command authority identity could not be admitted.",
        );
      }
      return deferredGuidedAuthorityResult();
    } else if (authorityExecution) {
      const actionKey = acceptedGuidedPlanActionKey(
        work,
        resolution.adapter.capability,
        resolution.target,
      );
      if (!actionKey.ok) {
        return ordinaryGuidedEffectError(actionKey.code, actionKey.message);
      }
      if (work.currentPlan?.planRevisionId !== authorityExecution.planRevisionId ||
          actionKey.value !== authorityExecution.actionKey) {
        return ordinaryGuidedEffectError(
          "authority_request_identity_mismatch",
          "The approved command is no longer bound to the accepted Plan action.",
        );
      }
    }
    const outcome = await input.effectService.execute({
      work,
      accessMode: authorityExecution
        ? "full_access"
        : input.accessMode,
      occurrenceId: effectOccurrenceId,
      signal: call.signal ?? input.signal,
      target: resolution.target,
      input: resolution.input,
      adapter: resolution.adapter,
    });
    if (authorityExecution) {
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
