import type {
  ButlerExecutionPolicy,
  GuidedTurnResult,
} from "../../btcc/index.ts";
import type { TurnRecord } from "../../btcc/turn/index.ts";
import { BUTLER_TOOLS } from "../../tools/butler-tools.ts";
import { TOOL_CAPABILITY_METADATA } from "../../tools/registry.ts";
import { PROJECT_LEDGER_MUTATION_TOOL_NAME_SET } from
  "../../tools/project-ledger/mutation-tools.ts";
import { selectInitialToolsFromSurfaceController } from
  "../../tools/tool-surface-selection.ts";
import { WORK_TRACKING_TOOL_NAMES } from "../../tools/work-tracking/shared.ts";
import type { FunctionToolDefinition } from
  "../../../integrations/providers/runtime-contracts.ts";
import type { NativeToolAvailabilityOverrides } from
  "../../tools/types.ts";
import {
  DURABLE_WORK_TOOL_DEFINITIONS,
  isDurableWorkTool,
} from "./durable-work-tools.ts";
import { GUIDED_PROJECT_LEDGER_EFFECT_TOOL_NAMES } from
  "./guided-project-ledger-effect.ts";

const NON_FULL_ACCESS_TOOL_NAMES = new Set([
  "list_tool_capabilities",
  "tool_search",
  "tool_describe",
  "tool_call",
  "web_search",
  "web_read",
  "read_file",
  "grep_files",
  "read_tool_evidence_artifact",
  "read_tool_output_artifact",
  "project_ledger_status",
  "project_ledger_list",
  "project_ledger_show",
  "project_ledger_check",
  "inspect_project_status",
  "query_project_work",
  "render_project_dashboard",
  "get_work_dashboard",
  "get_context_monitor",
  "get_usage_monitor",
  "get_memory_health",
  "read_conversation_context",
  "recall_memory",
  "query_memory",
  "list_automations",
  "read_mcp_resource",
  "list_skills",
  "transform_public_data_table",
]);

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
  call_mcp_tool: {
    disabledReason:
      "This guided runtime does not yet have a guarded MCP effect adapter. MCP tool dispatch is unavailable; MCP capability discovery and resource reads remain available.",
    recoveryHint:
      "Use list_mcp_capabilities or read_mcp_resource for read-only evidence, choose an enabled native tool, or report the limitation.",
  },
} as const satisfies NativeToolAvailabilityOverrides;

const GUIDED_UNAVAILABLE_NATIVE_TOOL_NAMES = new Set(
  Object.keys(GUIDED_NATIVE_TOOL_AVAILABILITY_OVERRIDES),
);

export function guidedPolicy(turn: TurnRecord): ButlerExecutionPolicy {
  if (turn.context.executionPolicy) {
    return {
      ...turn.context.executionPolicy,
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

export function authorizedToolDefinitions(turn: TurnRecord): FunctionToolDefinition[] {
  const policy = guidedPolicy(turn);
  const requiredProfiles = new Set([
    ...policy.requiredNativeToolProfiles,
    "public-web",
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
  const selected = selectInitialToolsFromSurfaceController({
    role: policy.role,
    message: turn.originalMessage,
    sessionMetadata: {
      ...(policy.projectId ? { projectId: policy.projectId } : {}),
      runtimePolicy,
    },
    tools: BUTLER_TOOLS,
  }).tools;
  const names = new Set(selected.map((tool) => tool.name));
  for (const name of [
    "tool_search",
    "tool_describe",
    "tool_call",
    "web_search",
    "web_read",
    "read_file",
    "grep_files",
  ]) names.add(name);
  for (const name of GUIDED_UNAVAILABLE_NATIVE_TOOL_NAMES) names.delete(name);
  if (policy.accessMode === "full_access") {
    for (const tool of BUTLER_TOOLS) {
      if (
        tool.effectBoundary === "none" &&
        TOOL_CAPABILITY_METADATA[tool.name]?.category !== "project"
      ) {
        names.add(tool.name);
      }
    }
    names.add("run_command");
    names.add("write_file");
  } else {
    for (const name of names) {
      if (!NON_FULL_ACCESS_TOOL_NAMES.has(name)) names.delete(name);
    }
  }
  for (const name of WORK_TRACKING_TOOL_NAMES) names.delete(name);
  const guidedLedgerEffects = new Set<string>(
    policy.accessMode === "full_access" &&
      policy.trackingMode === "ledger" &&
      (policy.projectId || turn.context.projectRef)
      ? GUIDED_PROJECT_LEDGER_EFFECT_TOOL_NAMES
      : [],
  );
  for (const name of PROJECT_LEDGER_MUTATION_TOOL_NAME_SET) names.delete(name);
  for (const name of guidedLedgerEffects) names.add(name);
  return [
    ...BUTLER_TOOLS.filter((tool) => names.has(tool.name)),
    ...(policy.trackingMode === "none" ? [] : DURABLE_WORK_TOOL_DEFINITIONS),
  ];
}

export function hiddenNativeToolNamesForGuidedTurn(
  enableProjectLedgerEffects: boolean,
): string[] {
  const supported = new Set<string>(
    enableProjectLedgerEffects ? GUIDED_PROJECT_LEDGER_EFFECT_TOOL_NAMES : [],
  );
  return [
    ...WORK_TRACKING_TOOL_NAMES,
    ...[...PROJECT_LEDGER_MUTATION_TOOL_NAME_SET]
      .filter((name) => !supported.has(name)),
  ];
}

export function visibleToolDefinitions(
  authorized: readonly FunctionToolDefinition[],
  policy: Pick<
    ButlerExecutionPolicy,
    "accessMode" | "trackingMode" | "projectId"
  >,
): FunctionToolDefinition[] {
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
    ...DURABLE_WORK_TOOL_DEFINITIONS.map((tool) => tool.name),
    "project_ledger_status",
    ...(projectLedgerWork
      ? ["project_ledger_list"]
      : []),
    ...(projectLedgerWork && policy.accessMode === "full_access"
      ? [
          "project_ledger_create",
          "project_ledger_work_complete",
        ]
      : []),
    ...(policy.accessMode === "full_access" ? ["run_command", "write_file"] : []),
  ]);
  return authorized.filter((tool) => visible.has(tool.name)).map(guidedToolDefinition);
}

function guidedToolDefinition(tool: FunctionToolDefinition): FunctionToolDefinition {
  if (tool.name !== "write_file") return tool;
  const properties = tool.parameters.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return tool;
  const { expected_sha256: _runtimeOwnedHash, ...modelProperties } =
    properties as Record<string, unknown>;
  return {
    ...tool,
    parameters: { ...tool.parameters, properties: modelProperties },
  };
}

export function selectedModelRef(turn: TurnRecord): string {
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
  const parts = id.split(":");
  return parts.length >= 2 && parts[parts.length - 1] ? parts[parts.length - 1] : name;
}

export function routeForUsedTools(
  tools: readonly string[],
  hasBoundWork = false,
): GuidedTurnResult["route"] {
  if (hasBoundWork) return "managed";
  if (tools.length === 0) return "direct";
  return "assisted";
}

export function isReplaySafeTool(name: string): boolean {
  if (isDurableWorkTool(name)) return true;
  const nativeTool = BUTLER_TOOLS.find((tool) => tool.name === name);
  if (nativeTool?.effectBoundary === "none") return true;
  if (name === "write_file" || name === "run_command" ||
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

export function publicToolTitle(name: string): string {
  if (name === "web_search") return "웹 검색";
  if (name === "web_read") return "웹 문서 읽기";
  if (name === "read_file" || name === "grep_files") return "작업공간 확인";
  if (name === "run_command") return "작업 실행";
  if (name.startsWith("project_ledger")) return "프로젝트 기록 확인";
  if (isDurableWorkTool(name)) return "작업 진행 기록";
  return "도구 사용";
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
