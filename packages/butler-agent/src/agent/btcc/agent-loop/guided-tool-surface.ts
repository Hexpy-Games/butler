import type { ButlerExecutionPolicy } from "../contracts.ts";
import type { TurnRecord } from "../turn/index.ts";
import { BUTLER_TOOLS } from "../../tools/butler-tools.ts";
import { PROJECT_LEDGER_MUTATION_TOOL_NAME_SET } from
  "../../tools/project-ledger/mutation-tools.ts";
import type { ToolSurfacePhasePolicy } from
  "../../tools/tool-surface-types.ts";
import { WORK_TRACKING_TOOL_NAMES } from
  "../../tools/work-tracking/shared.ts";
import { workspacePagePreviewAvailabilityOverride } from
  "../../tools/workspace-page-preview/index.ts";
import type { FunctionToolDefinition } from
  "../../../integrations/providers/runtime-contracts.ts";
import { DURABLE_WORK_TOOL_DEFINITIONS } from "./durable-work-tools.ts";
import { guidedToolDefinition } from "./guided-tool-definition.ts";
import { GUIDED_PROJECT_LEDGER_EFFECT_TOOL_NAMES } from
  "./guided-project-ledger-effect.ts";
import {
  applyGuidedWorkspaceAuthorization,
  guidedWorkspaceVisibleToolNames,
} from "./guided-session-workspace-policy.ts";

export interface GuidedToolSurface {
  authorizedTools: FunctionToolDefinition[];
  providerTools: FunctionToolDefinition[];
  minimalProviderCarrier: boolean;
}

export interface GuidedToolSurfaceBoundary {
  guidedLedgerEffects: ReadonlySet<string>;
  minimalPhasePolicy: ToolSurfacePhasePolicy;
  runtimePolicy: Record<string, unknown>;
}

export function prepareGuidedToolSurfaceBoundary(
  turn: TurnRecord,
  policy: ButlerExecutionPolicy,
): GuidedToolSurfaceBoundary {
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
  const hasProject = Boolean(policy.projectId || turn.context.projectRef);
  const guidedLedgerEffects = policy.accessMode === "full_access" &&
      policy.trackingMode === "ledger" && hasProject
    ? new Set<string>(GUIDED_PROJECT_LEDGER_EFFECT_TOOL_NAMES)
    : new Set<string>();
  const minimalPhasePolicy: ToolSurfacePhasePolicy = Object.freeze({
    phaseId: "guided",
    policyRevision: turn.modelSelection.controlsHash,
    role: policy.role,
    accessMode: policy.accessMode,
    trackingMode: policy.trackingMode,
    requiredNativeToolProfiles: Object.freeze([
      "startup",
      ...requiredProfiles,
      "workspace",
    ]),
    requiredNativeTools: Object.freeze([
      ...policy.requiredNativeTools,
      ...guidedLedgerEffects,
      ...(policy.accessMode === "full_access" && hasProject
        ? ["bind_session_git_worktree"]
        : []),
      ...(policy.accessMode === "full_access"
        ? ["inspect_workspace_page"]
        : []),
    ]),
    toolSurfaceMode: "fixed",
    ...(policy.projectId ? { projectId: policy.projectId } : {}),
  });
  return { guidedLedgerEffects, minimalPhasePolicy, runtimePolicy };
}

export function finalizeGuidedToolSurface(input: {
  env: NodeJS.ProcessEnv;
  guidedLedgerEffects: ReadonlySet<string>;
  minimal: boolean;
  policy: ButlerExecutionPolicy;
  selected: readonly FunctionToolDefinition[];
  turn: TurnRecord;
  unavailableToolNames: ReadonlySet<string>;
}): GuidedToolSurface {
  const {
    env,
    guidedLedgerEffects,
    minimal,
    policy,
    selected,
    turn,
    unavailableToolNames,
  } = input;
  const names = new Set(selected.map((tool) => tool.name));
  if (!minimal) addExpandedGuidedTools(names);
  for (const name of unavailableToolNames) names.delete(name);
  applyGuidedWorkspaceAuthorization({
    names,
    policy,
    projectRef: turn.context.projectRef,
    fixedSurface: minimal,
  });
  if (!minimal && workspacePagePreviewAvailabilityOverride(env)) {
    names.delete("inspect_workspace_page");
  }
  for (const name of WORK_TRACKING_TOOL_NAMES) names.delete(name);
  preserveGuidedLedgerEffects(names, guidedLedgerEffects, minimal);

  const sourceTools = minimal ? selected : BUTLER_TOOLS;
  const authorizedTools = [
    ...sourceTools.filter((tool) => names.has(tool.name)),
    ...(policy.trackingMode === "none" ? [] : DURABLE_WORK_TOOL_DEFINITIONS),
  ];
  return {
    authorizedTools,
    providerTools: visibleToolDefinitions(
      authorizedTools,
      policy,
      minimal ? "progressive" : "expanded",
    ),
    minimalProviderCarrier: minimal,
  };
}

export function visibleToolDefinitions(
  authorized: readonly FunctionToolDefinition[],
  policy: Pick<ButlerExecutionPolicy, "accessMode" | "trackingMode" | "projectId">,
  carrier: "expanded" | "progressive" = "expanded",
): FunctionToolDefinition[] {
  const visible = carrier === "progressive"
    ? progressiveCarrierNames(policy)
    : expandedCarrierNames(policy);
  return authorized.filter((tool) => visible.has(tool.name))
    .map(guidedToolDefinition);
}

function addExpandedGuidedTools(names: Set<string>): void {
  for (const name of [
    "tool_search", "tool_describe", "tool_call", "web_search", "web_read",
    "read_file", "grep_files", "list_files",
  ]) names.add(name);
}

function preserveGuidedLedgerEffects(
  names: Set<string>,
  guidedLedgerEffects: ReadonlySet<string>,
  minimal: boolean,
): void {
  const selectedNames = new Set(names);
  for (const name of PROJECT_LEDGER_MUTATION_TOOL_NAME_SET) {
    if (!guidedLedgerEffects.has(name)) names.delete(name);
  }
  for (const name of guidedLedgerEffects) {
    if (!minimal || selectedNames.has(name)) names.add(name);
  }
}

function progressiveCarrierNames(
  policy: Pick<ButlerExecutionPolicy, "accessMode" | "projectId">,
): Set<string> {
  return new Set([
    "tool_search",
    "tool_describe",
    "tool_call",
    "web_search",
    "web_read",
    ...(policy.projectId
      ? ["read_file", "grep_files", "list_files"]
      : []),
    ...(policy.projectId && policy.accessMode === "full_access"
      ? [
          "run_command",
          "write_file",
          "inspect_workspace_page",
        ]
      : []),
    ...DURABLE_WORK_TOOL_DEFINITIONS.map((tool) => tool.name),
  ]);
}

function expandedCarrierNames(
  policy: Pick<ButlerExecutionPolicy, "accessMode" | "trackingMode" | "projectId">,
): Set<string> {
  const projectLedgerWork =
    policy.trackingMode === "ledger" && Boolean(policy.projectId);
  return new Set([
    "tool_search", "tool_describe", "tool_call", "web_search", "web_read",
    "read_file", "grep_files", "list_files", "recall_memory",
    "list_conversation_sessions", "read_conversation_session",
    ...DURABLE_WORK_TOOL_DEFINITIONS.map((tool) => tool.name),
    "project_ledger_status",
    ...(projectLedgerWork ? ["project_ledger_list"] : []),
    ...(projectLedgerWork && policy.accessMode === "full_access"
      ? ["project_ledger_create", "project_ledger_work_complete"]
      : []),
    ...guidedWorkspaceVisibleToolNames(policy),
  ]);
}
