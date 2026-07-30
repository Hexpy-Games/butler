import type {
  ButlerExecutionPolicy,
  GuidedTurnResult,
} from "../../btcc/index.ts";
import type { TurnRecord } from "../../btcc/turn/index.ts";
import { BUTLER_TOOLS } from "../../tools/butler-tools.ts";
import { PROJECT_LEDGER_MUTATION_TOOL_NAME_SET } from
  "../../tools/project-ledger/mutation-tools.ts";
import { selectInitialToolsFromSurfaceController } from
  "../../tools/tool-surface-selection.ts";
import { WORK_TRACKING_TOOL_NAMES } from "../../tools/work-tracking/shared.ts";
import type { FunctionToolDefinition } from
  "../../../integrations/providers/runtime-contracts.ts";

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
  "update_todo_list",
  "list_todo_list",
  "list_work_streams",
  "update_work_stream_state",
  "list_automations",
  "read_mcp_resource",
  "list_skills",
  "transform_public_data_table",
]);

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
    trackingMode: turn.context.projectRef ? "ledger" : "none",
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
    ...(policy.trackingMode === "ledger" && policy.accessMode === "full_access"
      ? ["project-lifecycle"]
      : []),
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
    ...WORK_TRACKING_TOOL_NAMES,
  ]) names.add(name);
  if (policy.accessMode === "full_access") {
    names.add("run_command");
    names.add("write_file");
  } else {
    for (const name of names) {
      if (!NON_FULL_ACCESS_TOOL_NAMES.has(name)) names.delete(name);
    }
  }
  if (policy.trackingMode !== "ledger" || policy.accessMode !== "full_access") {
    for (const name of PROJECT_LEDGER_MUTATION_TOOL_NAME_SET) names.delete(name);
  } else {
    for (const name of PROJECT_LEDGER_MUTATION_TOOL_NAME_SET) names.add(name);
  }
  return BUTLER_TOOLS.filter((tool) => names.has(tool.name));
}

export function visibleToolDefinitions(
  authorized: readonly FunctionToolDefinition[],
  accessMode: ButlerExecutionPolicy["accessMode"],
): FunctionToolDefinition[] {
  const visible = new Set([
    "tool_search",
    "tool_describe",
    "tool_call",
    "web_search",
    "web_read",
    "read_file",
    "grep_files",
    "update_todo_list",
    "list_todo_list",
    "project_ledger_status",
    ...(accessMode === "full_access" ? ["run_command", "write_file"] : []),
  ]);
  return authorized.filter((tool) => visible.has(tool.name));
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

export function routeForUsedTools(tools: readonly string[]): GuidedTurnResult["route"] {
  if (tools.length === 0) return "direct";
  if (tools.some(isDurableMutation)) return "managed";
  return "assisted";
}

export function isReplaySafeTool(name: string): boolean {
  return [
    "tool_search",
    "tool_describe",
    "web_search",
    "web_read",
    "read_file",
    "grep_files",
    "list_todo_list",
    "list_work_streams",
    "project_ledger_status",
    "project_ledger_list",
    "project_ledger_show",
    "project_ledger_check",
    "inspect_project_status",
    "query_project_work",
    "render_project_dashboard",
  ].includes(name);
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
  if ((WORK_TRACKING_TOOL_NAMES as readonly string[]).includes(name)) return "작업 진행 기록";
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

function isDurableMutation(name: string): boolean {
  return name === "write_file" ||
    PROJECT_LEDGER_MUTATION_TOOL_NAME_SET.has(name) ||
    (WORK_TRACKING_TOOL_NAMES as readonly string[]).includes(name);
}
