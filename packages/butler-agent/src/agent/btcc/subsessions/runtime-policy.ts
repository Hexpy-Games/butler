import type { StoredSessionBinding } from
  "../../../test-support/harness/contracts.ts";
import type { TurnRecord } from "../turn/index.ts";
import type {
  DelegationRequest,
  ReviewedDelegationPlan,
  ReviewedDelegationRequest,
} from "./contracts.ts";
import {
  SUBSESSION_ALLOWED_TOOLS_AND_EFFECTS,
  SUBSESSION_READ_ONLY_TOOLS_AND_EFFECTS,
} from "./scope.ts";

export const DEFAULT_STEWARD_SAFE_TITLE = "Delegated Steward work";

export function reviewedStewardDelegationRequest(
  input: ReviewedDelegationRequest,
  reviewed: ReviewedDelegationPlan,
): DelegationRequest {
  const execution = derivedStewardExecutionIntent(input.parent_access_mode);
  return {
    ...input,
    safe_title: input.safe_title ?? DEFAULT_STEWARD_SAFE_TITLE,
    execution_mode: execution.executionMode,
    objective: reviewed.objective,
    acceptance_criteria: reviewed.acceptance_criteria,
    task_or_plan_refs: reviewed.task_or_plan_refs,
    constraints_and_non_goals: [],
    allowed_tools_and_effects: execution.allowedToolsAndEffects,
    mutation_scope: execution.mutationScope,
    parent_work_ref: reviewed.parent_work_ref,
  };
}

/** Derive legacy packet execution hints from the admitted Composer authority. */
export function derivedStewardExecutionIntent(
  accessMode: "full_access" | "ask_first" | "read_only",
): {
  executionMode: "read_only" | "mutation";
  allowedToolsAndEffects: string[];
  mutationScope: string[];
} {
  if (accessMode === "read_only") {
    return {
      executionMode: "read_only",
      allowedToolsAndEffects: [...SUBSESSION_READ_ONLY_TOOLS_AND_EFFECTS],
      mutationScope: [],
    };
  }
  return {
    executionMode: "mutation",
    allowedToolsAndEffects: [...SUBSESSION_ALLOWED_TOOLS_AND_EFFECTS],
    mutationScope: ["."],
  };
}
/** Inherit the exact user-admitted Composer authority without model-authored narrowing. */
export function inheritedStewardRuntimePolicy(
  parent: StoredSessionBinding,
  parentAccessMode: "full_access" | "ask_first" | "read_only",
): Record<string, unknown> {
  const source = objectRecord(parent.metadata?.runtimePolicy);
  const trackingMode = trackingModeValue(
    source.trackingMode ?? source.tracking_mode,
  ) ?? (parent.projectId ? "ledger" : "local");
  const parentProfiles = stringValues(source.requiredNativeToolProfiles);
  const parentTools = stringValues(
    source.requiredNativeTools ?? source.required_tools,
  );
  return {
    ...source,
    accessMode: parentAccessMode,
    trackingMode,
    tracking_mode: trackingMode,
    requiredNativeToolProfiles: parentProfiles,
    requiredNativeTools: parentTools,
    required_tools: [...parentTools],
    authoritySource: "parent_session",
    authority_source: "parent_session",
  };
}

export function normalizeStewardAccessMode(
  value: unknown,
): "full_access" | "ask_first" | "read_only" {
  if (value === "full_access" || value === "ask_first" || value === "read_only") return value;
  throw new Error("delegation_parent_access_mode_invalid");
}

/** Resolve the immutable effective Composer authority admitted with the parent Turn. */
export function admittedParentTurnAccessMode(
  turn: TurnRecord,
): "full_access" | "ask_first" | "read_only" {
  const admitted = normalizeStewardAccessMode(turn.modelSelection.controls.accessMode);
  const contextual = turn.context.executionPolicy?.accessMode;
  if (!contextual) return admitted;
  const rank = { read_only: 0, ask_first: 1, full_access: 2 } as const;
  return rank[contextual] <= rank[admitted] ? contextual : admitted;
}

/** Keep the Steward root Work scope identical to its ordinary Turn scope. */
export function stewardRootWorkScope(
  binding: StoredSessionBinding,
): { projectRef?: string } {
  const source = objectRecord(binding.metadata?.runtimePolicy);
  const trackingMode = trackingModeValue(
    source.trackingMode ?? source.tracking_mode,
  ) ?? (binding.projectId ? "ledger" : "local");
  if (trackingMode !== "ledger") return {};
  const projectRef = binding.projectId?.trim();
  if (!projectRef) throw new Error("steward_project_binding_missing");
  return { projectRef };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string =>
      typeof item === "string" && Boolean(item.trim()),
    ).map((item) => item.trim()))]
    : [];
}

function trackingModeValue(value: unknown): "ledger" | "local" | "none" | null {
  return value === "ledger" || value === "local" || value === "none"
    ? value
    : null;
}
