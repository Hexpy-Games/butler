import { expect, test } from "bun:test";
import { BUTLER_TOOLS } from "../../packages/butler-agent/src/agent/tools/registry.ts";
import { projectLedgerNativeToolDefinitions } from "../../packages/butler-agent/src/agent/tools/project-ledger/native.ts";
import type { ButlerToolEffectBoundary } from "../../packages/butler-agent/src/agent/tools/types.ts";

const expectedNamesByBoundary = {
  none: [
    "web_search",
    "web_read",
    "read_file",
    "grep_files",
    "list_files",
    "project_ledger_status",
    "project_ledger_list",
    "project_ledger_show",
    "project_ledger_check",
    "get_work_dashboard",
    "inspect_project_status",
    "query_project_work",
    "get_context_monitor",
    "read_operation_results",
    "read_tool_evidence_artifact",
    "read_tool_output_artifact",
    "get_usage_monitor",
    "list_tool_capabilities",
    "tool_search",
    "tool_describe",
    "list_mcp_capabilities",
    "read_mcp_resource",
    "analyze_attached_image",
    "list_automations",
    "list_todo_list",
    "list_work_streams",
    "get_memory_health",
    "recall_memory",
    "query_memory",
    "summarize_user_profile",
    "read_conversation_context",
    "list_conversation_sessions",
    "read_conversation_session",
    "list_skills",
  ],
  turn_local: [
    "update_todo_list",
    "update_work_stream_state",
    "control_work",
    "ingest_task_memory",
    "update_onboarding_profile",
    "update_explicit_memory",
  ],
  reviewed_persistent: [
    "transform_public_data_table",
    "write_file",
    "edit_file",
    "bind_session_git_worktree",
    "project_ledger_index",
    "project_ledger_create",
    "project_ledger_update",
    "project_ledger_work_update",
    "project_ledger_work_complete",
    "project_ledger_task_update",
    "project_ledger_task_complete",
    "project_ledger_attempt_start",
    "project_ledger_attempt_succeed",
    "project_ledger_attempt_fail",
    "project_ledger_render",
    "render_project_dashboard",
    "complete_project_work",
    "create_automation",
    "delete_automation",
    "run_due_automations",
  ],
  dynamic: [
    "run_command",
    "tool_call",
    "call_mcp_tool",
  ],
} satisfies Record<ButlerToolEffectBoundary, string[]>;

test("every registered Butler tool declares its execution effect boundary", () => {
  const declaredNames = Object.values(expectedNamesByBoundary).flat().sort();
  const registeredNames = BUTLER_TOOLS.map((tool) => tool.name).sort();

  expect(declaredNames).toEqual(registeredNames);
  for (const [boundary, expectedNames] of Object.entries(expectedNamesByBoundary)) {
    expect(BUTLER_TOOLS
      .filter((tool) => tool.effectBoundary === boundary)
      .map((tool) => tool.name)).toEqual(expectedNames);
  }
});

test("generated Project Ledger definitions derive the boundary from mutation behavior", () => {
  for (const tool of projectLedgerNativeToolDefinitions) {
    expect(tool.effectBoundary).toBe(tool.concurrencySafe ? "none" : "reviewed_persistent");
  }
});
