import type { ButlerExecutionPolicy } from "../contracts.ts";
import type { BtccAgentLoopResult } from "./contracts.ts";
import type { TurnRecord } from "../turn/index.ts";
import { parseToolCatalogId } from "../../tools/progressive-catalog.ts";
import { BUTLER_TOOLS } from "../../tools/butler-tools.ts";
import { PROJECT_LEDGER_MUTATION_TOOL_NAME_SET } from
  "../../tools/project-ledger/mutation-tools.ts";
import { selectButlerToolsForTurn } from "../../tools/profiles.ts";
import { WORK_TRACKING_TOOL_NAMES } from "../../tools/work-tracking/shared.ts";
import type { FunctionToolDefinition } from
  "../../../integrations/providers/runtime-contracts.ts";
import type {
  ButlerToolDefinition,
  NativeToolAvailabilityOverrides,
} from "../../tools/types.ts";
import {
  DURABLE_WORK_TOOL_DEFINITIONS,
} from "./durable-work-tools.ts";
import { isDurableWorkTool } from "../work/index.ts";
import { GUIDED_PROJECT_LEDGER_EFFECT_TOOL_NAMES } from
  "./guided-project-ledger-effect.ts";
import { guidedToolDefinition } from "./guided-tool-definition.ts";
import { safeCommandActionLabel } from "../../output/progress/arguments.ts";
import { currentModelRouteCandidate } from "../model-route/index.ts";
import {
  applyGuidedWorkspaceAuthorization,
  guidedWorkspaceVisibleToolNames,
} from "./guided-session-workspace-policy.ts";
import { readOperationResultsToolDefinition } from
  "../../tools/monitoring/read_operation_results/index.ts";
const STEWARD_PARENT_TOOL_NAMES = ["delegate_to_steward", "steer_steward", "cancel_steward"];
const WORKER_DELEGATION_TOOL_NAME = "delegate_to_worker";
const WORKER_DIRECTION_TOOL_NAME = "steer_worker";
const GUIDED_MANAGED_LEDGER_EFFECT_TOOL_NAMES =
  GUIDED_PROJECT_LEDGER_EFFECT_TOOL_NAMES.filter((name) =>
    name !== "project_ledger_work_complete",
  );

const GUIDED_AUTOMATION_EFFECT_UNAVAILABLE = {
  disabledReason:
    "This guided runtime does not yet have a typed automation effect adapter. Automation changes are unavailable; read-only automation listing remains available.",
  recoveryHint:
    "Use list_automations for read-only inspection, or report that creating, deleting, and running automations is unavailable in this runtime.",
} as const;

export const GUIDED_NATIVE_TOOL_AVAILABILITY_OVERRIDES = {
  create_automation: GUIDED_AUTOMATION_EFFECT_UNAVAILABLE,
  delete_automation: GUIDED_AUTOMATION_EFFECT_UNAVAILABLE,
  run_due_automations: GUIDED_AUTOMATION_EFFECT_UNAVAILABLE,
} as const satisfies NativeToolAvailabilityOverrides;

const GUIDED_UNAVAILABLE_NATIVE_TOOL_NAMES = new Set(
  Object.keys(GUIDED_NATIVE_TOOL_AVAILABILITY_OVERRIDES),
);

export function guidedPolicy(turn: TurnRecord): ButlerExecutionPolicy {
  if (turn.context.executionPolicy) {
    return {
      ...turn.context.executionPolicy,
      ...(turn.context.projectRef && !turn.context.executionPolicy.projectId
        ? { projectId: turn.context.projectRef }
        : {}),
      accessMode: narrowerAccessMode(
        turn.context.executionPolicy.accessMode,
        admittedAccessMode(turn),
      ),
    };
  }
  return {
    role: "butler",
    accessMode: admittedAccessMode(turn),
    trackingMode: turn.context.projectRef ? "ledger" : "local",
    requiredNativeToolProfiles: [],
    requiredNativeTools: [],
    workspacePath: workspaceFromScopes(turn) ?? process.cwd(),
    ...(turn.context.projectRef ? { projectId: turn.context.projectRef } : {}),
  };
}

export function authorizedToolDefinitions(
  turn: TurnRecord,
  _env: NodeJS.ProcessEnv = process.env,
  exactResultReplayEnabled = false,
): FunctionToolDefinition[] {
  const policy = guidedPolicy(turn);
  const requiredProfiles = new Set([
    ...policy.requiredNativeToolProfiles,
    "public-web",
    "memory-read",
    ...(policy.accessMode === "full_access" ? ["workspace"] : []),
    ...(policy.projectId || turn.context.projectRef ? ["project"] : []),
  ]);
  const runtimePolicy = {
    accessMode: policy.accessMode,
    trackingMode: policy.trackingMode,
    requiredNativeToolProfiles: [...requiredProfiles],
    requiredNativeTools: policy.requiredNativeTools,
    ...(policy.projectId ? { projectId: policy.projectId } : {}),
  };
  const selected = selectButlerToolsForTurn({
    role: policy.role,
    text: turn.originalMessage,
    sessionMetadata: {
      ...(policy.projectId ? { projectId: policy.projectId } : {}),
      runtimePolicy,
    },
    tools: guidedNativeToolDefinitions(exactResultReplayEnabled),
  });
  const names = new Set(selected.map((tool) => tool.name));
  for (const name of [
    "tool_search",
    "tool_describe",
    "tool_call",
    "web_search",
    "web_read",
    "read_file",
    "grep_files",
    "list_files",
  ]) names.add(name);
  for (const name of GUIDED_UNAVAILABLE_NATIVE_TOOL_NAMES) names.delete(name);
  applyGuidedWorkspaceAuthorization({
    names,
    policy,
    projectRef: turn.context.projectRef,
  });
  if (policy.accessMode === "full_access") names.add("call_mcp_tool");
  else names.delete("call_mcp_tool");
  if (policy.role === "butler") {
    for (const name of STEWARD_PARENT_TOOL_NAMES) names.add(name);
  } else {
    for (const name of STEWARD_PARENT_TOOL_NAMES) names.delete(name);
  }
  if (policy.role === "steward") {
    names.add(WORKER_DELEGATION_TOOL_NAME);
    names.add(WORKER_DIRECTION_TOOL_NAME);
  } else {
    names.delete(WORKER_DELEGATION_TOOL_NAME);
    names.delete(WORKER_DIRECTION_TOOL_NAME);
  }
  for (const name of WORK_TRACKING_TOOL_NAMES) names.delete(name);
  const guidedLedgerEffects = new Set<string>(
    policy.accessMode === "full_access" &&
      policy.trackingMode === "ledger" &&
      (policy.projectId || turn.context.projectRef)
      ? GUIDED_MANAGED_LEDGER_EFFECT_TOOL_NAMES
      : [],
  );
  for (const name of PROJECT_LEDGER_MUTATION_TOOL_NAME_SET) names.delete(name);
  for (const name of guidedLedgerEffects) names.add(name);
  return [
    ...guidedNativeToolDefinitions(exactResultReplayEnabled)
      .filter((tool) => names.has(tool.name)),
    ...(policy.trackingMode === "none" ? [] : DURABLE_WORK_TOOL_DEFINITIONS),
  ];
}

export function hiddenNativeToolNamesForGuidedTurn(
  enableProjectLedgerEffects: boolean,
): string[] {
  const supported = new Set<string>(
    enableProjectLedgerEffects ? GUIDED_MANAGED_LEDGER_EFFECT_TOOL_NAMES : [],
  );
  return [
    ...WORK_TRACKING_TOOL_NAMES,
    ...[...PROJECT_LEDGER_MUTATION_TOOL_NAME_SET]
      .filter((name) => !supported.has(name)),
  ];
}

export function directSynthesisToolDefinitions<T extends { name: string }>(
  _tools: readonly T[],
): T[] {
  return [];
}

export function visibleToolDefinitions(authorized: readonly FunctionToolDefinition[], policy: Pick<ButlerExecutionPolicy, "role" | "accessMode" | "trackingMode" | "projectId" | "subsession">, includeAttachedImageTool = false): FunctionToolDefinition[] {
  const projectLedgerWork =
    policy.trackingMode === "ledger" && Boolean(policy.projectId);
  const visible = new Set([
    "tool_search",
    "tool_describe",
    "tool_call",
    "web_search",
    "web_read",
    "read_file",
    "grep_files",
    "list_files",
    "recall_memory",
    "query_memory",
    "list_conversation_sessions",
    "read_conversation_session",
    ...DURABLE_WORK_TOOL_DEFINITIONS.map((tool) => tool.name),
    "project_ledger_status",
    ...(includeAttachedImageTool ? ["analyze_attached_image"] : []),
    ...(projectLedgerWork
      ? ["project_ledger_list"]
      : []),
    ...(projectLedgerWork && policy.accessMode === "full_access"
      ? [
          "project_ledger_create",
        ]
      : []),
    ...(policy.role === "butler"
      ? ["delegate_to_steward", "steer_steward", "cancel_steward"]
      : []),
    ...(policy.role === "steward"
      ? [WORKER_DELEGATION_TOOL_NAME, WORKER_DIRECTION_TOOL_NAME]
      : []),
    ...guidedWorkspaceVisibleToolNames(policy),
  ]);
  return authorized.filter((tool) => visible.has(tool.name))
    .map(guidedToolDefinition);
}

export function guidedNativeToolDefinitions(
  exactResultReplayEnabled = false,
): ButlerToolDefinition[] {
  return BUTLER_TOOLS
    .filter((tool) => exactResultReplayEnabled ||
      tool.name !== readOperationResultsToolDefinition.name)
    .map(guidedToolDefinition);
}

export function selectedModelRef(turn: TurnRecord): string {
  const routed = turn.modelRoute && currentModelRouteCandidate(turn.modelRoute)?.modelRef;
  if (routed) return routed;
  return turn.modelSelection.model.includes("/")
    ? turn.modelSelection.model
    : `${turn.modelSelection.provider}/${turn.modelSelection.model}`;
}

export function effectiveToolNameForCall(
  name: string,
  args: Record<string, unknown>,
): string {
  if (name !== "tool_call") return name;
  const id = typeof args.id === "string" ? args.id : "";
  return parseToolCatalogId(id)?.name || name;
}

export function invalidRunCommandSummary(input: {
  callName: string;
  callArgs: Record<string, unknown>;
  effectiveToolName: string;
  presentationArgs: Record<string, unknown>;
}): Record<string, unknown> | null {
  const directRunCommand = input.callName === "run_command" &&
    input.effectiveToolName === "run_command";
  const catalogId = typeof input.callArgs.id === "string"
    ? parseToolCatalogId(input.callArgs.id)
    : null;
  const progressiveRunCommand = input.callName === "tool_call" &&
    input.effectiveToolName === "run_command" &&
    catalogId?.provider === "native" &&
    catalogId.namespace === null &&
    catalogId.name === "run_command";
  if (!directRunCommand && !progressiveRunCommand) return null;
  if (safeCommandActionLabel(input.presentationArgs)) return null;
  return {
    ok: false,
    error: {
      code: "invalid_tool_arguments",
      message: "Tool run_command requires a one-line action label in summary (max 32 characters)",
      path: "$.summary",
    },
  };
}

export function routeForUsedTools(
  tools: readonly string[],
  hasBoundWork = false,
): BtccAgentLoopResult["route"] {
  if (hasBoundWork) return "managed";
  if (tools.length === 0) return "direct";
  return "assisted";
}

export function isReplaySafeTool(name: string): boolean {
  if (isDurableWorkTool(name)) return true;
  const nativeTool = BUTLER_TOOLS.find((tool) => tool.name === name);
  if (nativeTool?.effectBoundary === "none") return true;
  if (name === "bind_session_git_worktree" || name === "write_file" || name === "edit_file" || name === "run_command" ||
      GUIDED_PROJECT_LEDGER_EFFECT_TOOL_NAMES.includes(
        name as typeof GUIDED_PROJECT_LEDGER_EFFECT_TOOL_NAMES[number],
      )) return true;
  return false;
}

export function priorToolFailure(
  status: "failed" | "cancelled",
  toolName: string,
): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code: status === "cancelled" ? "prior_tool_call_cancelled" : "prior_tool_call_failed",
      message: `The previous ${toolName} call did not complete successfully. Adjust the call or continue with other evidence.`,
    },
  };
}

export function uncertainPriorMutation(toolName: string): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code: "prior_mutation_completion_unknown",
      message: `A previous ${toolName} call may have changed external state, but its result was not durably recorded. Inspect the target before deciding whether another mutation is safe.`,
    },
  };
}

function admittedAccessMode(turn: TurnRecord): ButlerExecutionPolicy["accessMode"] {
  const value = turn.modelSelection.controls.accessMode;
  if (value === "full_access" || value === "ask_first" || value === "read_only") return value;
  return "read_only";
}

function narrowerAccessMode(
  context: ButlerExecutionPolicy["accessMode"],
  admitted: ButlerExecutionPolicy["accessMode"],
): ButlerExecutionPolicy["accessMode"] {
  const rank = { read_only: 0, ask_first: 1, full_access: 2 } as const;
  return rank[context] <= rank[admitted] ? context : admitted;
}

function workspaceFromScopes(turn: TurnRecord): string | null {
  const scope = turn.context.baselineObservationScopeRefs.find((ref) => ref.startsWith("workspace:"));
  return scope ? scope.slice("workspace:".length) : null;
}
