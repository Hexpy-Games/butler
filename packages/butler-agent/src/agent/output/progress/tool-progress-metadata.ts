import { TOOL_CAPABILITY_METADATA } from "../../tools/registry.ts";
import type { ToolCapabilityCategory } from "../../tools/types.ts";
import type { ToolProgressSummary } from "../../turn/native/output/tool-types.ts";

const TOOL_PROGRESS_KIND_BY_CATEGORY: Record<ToolCapabilityCategory, ToolProgressSummary["kind"]> = {
  search: "searched",
  data: "edited",
  command: "ran_command",
  file: "read",
  work: "context",
  monitoring: "read",
  automation: "used_tool",
  todo: "edited",
  memory: "context",
  project: "read",
  skill: "read",
  mcp: "used_tool",
  dispatch: "dispatch",
  control: "used_tool",
};

const TOOL_PROGRESS_KIND_BY_TOOL_NAME: Record<string, ToolProgressSummary["kind"]> = {
  bash: "ran_command",
  call_mcp_tool: "dispatch",
  complete_project_work: "edited",
  control_work: "edited",
  create_automation: "edited",
  create_planned_task: "dispatch",
  create_work_orchestration: "dispatch",
  delete_automation: "edited",
  dispatch_worker: "dispatch",
  get_task_result: "read",
  get_work_dashboard: "read",
  grep_files: "searched",
  ingest_task_memory: "edited",
  query_memory: "searched",
  query_project_work: "searched",
  read_conversation_context: "read",
  read_file: "read",
  read_mcp_resource: "read",
  read_tool_evidence_artifact: "read",
  read_tool_output_artifact: "read",
  recall_memory: "searched",
  repair_planned_task: "dispatch",
  resume_worker: "dispatch",
  run_command: "ran_command",
  run_shell: "ran_command",
  shell: "ran_command",
  run_due_automations: "dispatch",
  run_planned_task: "dispatch",
  run_ready_work_streams: "dispatch",
  sync_work_orchestration: "dispatch",
  tool_call: "used_tool",
  tool_describe: "read",
  tool_search: "searched",
  transform_public_data_table: "edited",
  update_explicit_memory: "edited",
  update_onboarding_profile: "edited",
  update_todo_list: "edited",
  update_work_stream_state: "edited",
  web_read: "read",
  web_search: "searched",
  write_file: "edited",
  write_planned_public_report: "edited",
  write_work_orchestration_report: "edited",
};

export function activityKindForTool(name: string): ToolProgressSummary["kind"] {
  const normalizedName = name.toLocaleLowerCase("en-US");
  const explicitKind = TOOL_PROGRESS_KIND_BY_TOOL_NAME[normalizedName];
  if (explicitKind) {
    return explicitKind;
  }
  const metadata = TOOL_CAPABILITY_METADATA[name] ?? TOOL_CAPABILITY_METADATA[normalizedName];
  if (!metadata) {
    return "used_tool";
  }
  return TOOL_PROGRESS_KIND_BY_CATEGORY[metadata.category];
}
