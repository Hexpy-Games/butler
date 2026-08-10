import type { ButlerExecutionPolicy } from "../contracts.ts";
import { BUTLER_TOOLS } from "../../tools/butler-tools.ts";
import { TOOL_CAPABILITY_METADATA } from "../../tools/registry.ts";

const NON_FULL_ACCESS_TOOL_NAMES = new Set([
  "list_tool_capabilities",
  "tool_search",
  "tool_describe",
  "tool_call",
  "web_search",
  "web_read",
  "read_file",
  "grep_files",
  "list_files",
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
  "list_conversation_sessions",
  "read_conversation_session",
  "recall_memory",
  "query_memory",
  "list_automations",
  "read_mcp_resource",
  "list_skills",
  "transform_public_data_table",
]);

type WorkspacePolicy = Pick<ButlerExecutionPolicy, "accessMode" | "projectId">;

export function applyGuidedWorkspaceAuthorization(input: {
  names: Set<string>;
  policy: WorkspacePolicy;
  projectRef?: string;
  fixedSurface?: boolean;
}): void {
  const hasProject = Boolean(input.policy.projectId || input.projectRef);
  if (input.fixedSurface) {
    if (input.policy.accessMode !== "full_access") {
      for (const name of input.names) {
        if (!NON_FULL_ACCESS_TOOL_NAMES.has(name)) input.names.delete(name);
      }
    }
    return;
  }
  if (input.policy.accessMode === "full_access") {
    for (const tool of BUTLER_TOOLS) {
      if (
        tool.effectBoundary === "none" &&
        TOOL_CAPABILITY_METADATA[tool.name]?.category !== "project"
      ) {
        input.names.add(tool.name);
      }
    }
    input.names.add("run_command");
    input.names.add("write_file");
    input.names.add("edit_file");
    if (hasProject) input.names.add("bind_session_git_worktree");
    return;
  }
  for (const name of input.names) {
    if (!NON_FULL_ACCESS_TOOL_NAMES.has(name)) input.names.delete(name);
  }
}

export function guidedWorkspaceVisibleToolNames(
  policy: WorkspacePolicy,
): string[] {
  if (policy.accessMode !== "full_access") return [];
  return [
    "run_command",
    "write_file",
    "edit_file",
    "inspect_workspace_page",
    ...(policy.projectId ? ["bind_session_git_worktree"] : []),
  ];
}
