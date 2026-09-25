import type { SubsessionDelegationService } from "../../btcc/subsessions/index.ts";
import { ActionableRejectionError, rejection, rejectionFromError } from "../../btcc/subsessions/index.ts";
import type { ButlerToolHandler } from "../tool-execution-contracts.ts";
import type { ButlerToolCall } from "../types.ts";
import {
  cancelStewardToolDefinition,
  delegateToStewardToolDefinition,
  delegateToWorkerToolDefinition,
  steerStewardToolDefinition,
  steerWorkerToolDefinition,
  waitForWorkerToolDefinition,
} from "./definition.ts";

export function createSubsessionToolHandlers(input: {
  service?: SubsessionDelegationService;
  parentSessionId?: string;
  parentTurnId?: string;
  anchorMessageId?: string;
  modelRef?: string;
  reasoningEffort?: string;
  parentAccessMode?: "full_access" | "ask_first" | "read_only";
}): Record<string, ButlerToolHandler> {
  if (!input.service) return {};
  return withActionableRejections({
    [waitForWorkerToolDefinition.name]: async () => {
      const { parentSessionId, sourceParentTurnId } = requireParentIdentity(input);
      const waiting = await input.service!.shouldWaitForWorker({
        parentSessionId, parentTurnId: sourceParentTurnId,
      });
      return { ok: true, status: waiting ? "waiting" : "no_active_worker" };
    },
    [delegateToStewardToolDefinition.name]: async (call: ButlerToolCall) => {
      if (!input.parentSessionId || !input.parentTurnId || !input.anchorMessageId) {
        throw new Error("subsession_parent_turn_identity_missing");
      }
      if (!input.modelRef || !input.reasoningEffort) {
        throw new Error("subsession_parent_model_snapshot_missing");
      }
      if (!input.parentAccessMode) {
        throw new Error("subsession_parent_access_snapshot_missing");
      }
      const request = requiredString(call.args.request, "request");
      const safeTitle = optionalSafeTitle(call.args.safe_title);
      const created = await input.service!.delegateReviewed({
        parent_session_id: input.parentSessionId,
        parent_turn_id: input.parentTurnId,
        anchor_message_id: input.anchorMessageId,
        parent_access_mode: input.parentAccessMode,
        request,
        ...(safeTitle ? { safe_title: safeTitle } : {}),
        model_ref: input.modelRef,
        reasoning_effort: input.reasoningEffort,
      });
      return {
        ok: true,
        relation_id: created.relation.relation_id,
        task_id: created.packet.task_id,
        child_session_id: created.relation.child_session_id,
        status: "queued",
      };
    },
    [delegateToWorkerToolDefinition.name]: async (call: ButlerToolCall, context) => {
      const identity = requireDelegationIdentity(input);
      const actionKey = requiredString(call.args.action_key, "action_key");
      const objective = requiredString(call.args.objective, "objective");
      const acceptanceCriteria = stringArray(call.args.acceptance_criteria, "acceptance_criteria");
      const implementationBrief = requiredString(call.args.implementation_brief, "implementation_brief");
      const safeTitle = optionalSafeTitle(call.args.safe_title);
      const profileId = optionalString(call.args.profile_id);
      const created = await input.service!.delegateWorkerReviewed({
        ...identity,
        ...(context?.effectOccurrenceId ? { source_tool_call_id: context.effectOccurrenceId } : {}),
        action_key: actionKey,
        objective,
        acceptance_criteria: acceptanceCriteria,
        implementation_brief: implementationBrief,
        ...(safeTitle ? { safe_title: safeTitle } : {}),
        ...(profileId ? { profile_id: profileId } : {}),
      });
      return repeatedAssignmentResult(created, actionKey) ?? { ok: true, status: "queued",
        ...(created?.prior_attempts?.length ? { prior_attempts: created.prior_attempts } : {}) };
    },
    [steerStewardToolDefinition.name]: async (call: ButlerToolCall) => {
      const identity = requireParentIdentity(input);
      const instruction = requiredString(call.args.instruction, "instruction");
      const direction = await input.service!.steerSteward({
        ...identity,
        instruction,
        ...(optionalString(call.args.work_id) ? { workId: optionalString(call.args.work_id) } : {}),
        ...optionalRelationSelector(call.args),
      });
      return {
        ok: true,
        relation_id: direction.relation_id,
        instruction_id: direction.instruction_id,
        revision: direction.revision,
        status: direction.status,
      };
    },
    [steerWorkerToolDefinition.name]: async (call: ButlerToolCall) => {
      const identity = requireParentIdentity(input);
      const instruction = requiredString(call.args.instruction, "instruction");
      const direction = await input.service!.steerSteward({
        ...identity,
        instruction,
        ...optionalRelationSelector(call.args),
      });
      return {
        ok: true,
        relation_id: direction.relation_id,
        instruction_id: direction.instruction_id,
        revision: direction.revision,
        status: direction.status,
        message: "The direction is recorded for the running Worker and applies at its next safe boundary. Call wait_for_worker to receive its result.",
      };
    },
    [cancelStewardToolDefinition.name]: async (call: ButlerToolCall) => {
      const result = await input.service!.cancelSteward({
        ...requireParentIdentity(input),
        ...optionalRelationSelector(call.args),
      });
      return {
        ok: true,
        relation_id: result.relation.relation_id,
        child_turn_id: result.child_turn_id,
        status: result.status,
      };
    },
  });
}

/** Repeating an assignment never starts a second child; it says what to do instead. */
function repeatedAssignmentResult(
  created: { relation?: { relation_id: string }; reused?: "active" | "settled" } | undefined,
  actionKey: string,
) {
  if (!created?.reused || !created.relation) return undefined;
  if (created.reused === "active") {
    return {
      ok: true, status: "already_delegated", relation_id: created.relation.relation_id,
      message: `Plan action "${actionKey}" is already assigned to a running Worker (${created.relation.relation_id}). No new Worker was started. Call wait_for_worker to receive its result, or steer_worker to change its direction.`,
    };
  }
  return rejection({
    code: "identical_assignment_already_settled",
    reason: `An identical assignment for Plan action "${actionKey}" already finished and its result was delivered. No new Worker was started.`,
    alternatives: [
      "integrate or review the delivered result",
      "delegate_to_worker with a changed objective or implementation_brief that addresses the prior result",
      "replace_work_plan if the action must be restructured",
    ],
    state: { action_key: actionKey, relation_id: created.relation.relation_id },
  });
}

/** Model-caused argument and Plan-state errors return as actionable results. */
function withActionableRejections(
  handlers: Record<string, ButlerToolHandler>,
): Record<string, ButlerToolHandler> {
  return Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name,
    (async (call, context) => {
      try {
        return await handler(call, context);
      } catch (error) {
        const rejected = rejectionFromError(error);
        if (rejected) return rejected;
        throw error;
      }
    }) as ButlerToolHandler]));
}

function requireDelegationIdentity(input: {
  parentSessionId?: string;
  parentTurnId?: string;
  anchorMessageId?: string;
  modelRef?: string;
  reasoningEffort?: string;
  parentAccessMode?: "full_access" | "ask_first" | "read_only";
}) {
  if (!input.parentSessionId || !input.parentTurnId || !input.anchorMessageId) {
    throw new Error("subsession_parent_turn_identity_missing");
  }
  if (!input.modelRef || !input.reasoningEffort || !input.parentAccessMode) {
    throw new Error("subsession_parent_model_snapshot_missing");
  }
  return {
    parent_session_id: input.parentSessionId,
    parent_turn_id: input.parentTurnId,
    anchor_message_id: input.anchorMessageId,
    parent_access_mode: input.parentAccessMode,
    model_ref: input.modelRef,
    reasoning_effort: input.reasoningEffort,
  };
}

function stringArray(value: unknown, name: string): string[] {
  const shape = `"${name}": an array of 1-8 non-empty strings`;
  if (!Array.isArray(value)) throw argumentRejection(`delegation_${name}_required`, name, shape, value);
  const values = value.map((item) => requiredString(item, name));
  if (values.length > 8) throw argumentRejection(`delegation_${name}_too_large`, name, shape, value);
  return values;
}

function argumentRejection(code: string, field: string, shape: string, value: unknown): ActionableRejectionError {
  return new ActionableRejectionError({
    code,
    reason: `The call was not run: "${field}" is missing or invalid. Provide it and call again.`,
    alternatives: [shape],
    state: { field, received: value === undefined ? "missing" : typeof value },
  });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireParentIdentity(input: {
  parentSessionId?: string;
  parentTurnId?: string;
  anchorMessageId?: string;
}): { parentSessionId: string; sourceParentTurnId: string; sourceMessageId: string } {
  if (!input.parentSessionId || !input.parentTurnId || !input.anchorMessageId) {
    throw new Error("subsession_parent_turn_identity_missing");
  }
  return {
    parentSessionId: input.parentSessionId,
    sourceParentTurnId: input.parentTurnId,
    sourceMessageId: input.anchorMessageId,
  };
}

function optionalRelationSelector(args: Record<string, unknown>): {
  relationId?: string;
  safeTitle?: string;
} {
  return {
    ...(typeof args.relation_id === "string" && args.relation_id.trim()
      ? { relationId: args.relation_id.trim() }
      : {}),
    ...(typeof args.safe_title === "string" && args.safe_title.trim()
      ? { safeTitle: args.safe_title.trim() }
      : {}),
  };
}

function optionalSafeTitle(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, "safe_title").slice(0, 120);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw argumentRejection(`delegation_${name}_required`, name, `"${name}": a non-empty string`, value);
  }
  return value.trim();
}
