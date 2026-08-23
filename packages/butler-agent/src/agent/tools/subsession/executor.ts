import type { SubsessionDelegationService } from "../../btcc/subsessions/index.ts";
import type { ButlerToolHandler } from "../tool-execution-contracts.ts";
import type { ButlerToolCall } from "../types.ts";
import { cancelStewardToolDefinition, delegateToStewardToolDefinition, steerStewardToolDefinition } from "./definition.ts";

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
  return {
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
      const args = decodeDelegationArgs(call.args);
      const created = await input.service!.delegate({
        parent_session_id: input.parentSessionId,
        parent_turn_id: input.parentTurnId,
        anchor_message_id: input.anchorMessageId,
        parent_access_mode: input.parentAccessMode,
        execution_mode: args.execution_mode,
        safe_title: args.safe_title,
        objective: args.objective,
        acceptance_criteria: args.acceptance_criteria,
        task_or_plan_refs: args.task_or_plan_refs,
        constraints_and_non_goals: args.constraints_and_non_goals,
        allowed_tools_and_effects: args.allowed_tools_and_effects,
        mutation_scope: args.mutation_scope,
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
    [steerStewardToolDefinition.name]: async (call: ButlerToolCall) => {
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
  };
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

function decodeDelegationArgs(args: Record<string, unknown>): {
  execution_mode: "read_only" | "mutation";
  safe_title: string;
  objective: string;
  acceptance_criteria: string[];
  task_or_plan_refs: string[];
  constraints_and_non_goals: string[];
  allowed_tools_and_effects: string[];
  mutation_scope: string[];
} {
  return {
    execution_mode: executionMode(args.execution_mode),
    safe_title: requiredString(args.safe_title, "safe_title"),
    objective: requiredString(args.objective, "objective"),
    acceptance_criteria: stringArray(args.acceptance_criteria, "acceptance_criteria", true),
    task_or_plan_refs: stringArray(args.task_or_plan_refs, "task_or_plan_refs", false),
    constraints_and_non_goals: stringArray(args.constraints_and_non_goals, "constraints_and_non_goals", true),
    allowed_tools_and_effects: stringArray(args.allowed_tools_and_effects, "allowed_tools_and_effects", true),
    mutation_scope: stringArray(args.mutation_scope, "mutation_scope", false),
  };
}

function executionMode(value: unknown): "read_only" | "mutation" {
  if (value === "read_only" || value === "mutation") return value;
  throw new Error("delegation_execution_mode_invalid");
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`delegation_${name}_required`);
  return value.trim();
}

function stringArray(value: unknown, name: string, required: boolean): string[] {
  if (!Array.isArray(value)) throw new Error(`delegation_${name}_array_required`);
  const result = value.map((item) => requiredString(item, name));
  if (required && result.length === 0) throw new Error(`delegation_${name}_required`);
  return result;
}
