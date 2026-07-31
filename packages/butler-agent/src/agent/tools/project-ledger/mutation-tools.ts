export const PROJECT_LEDGER_LIFECYCLE_TOOL_NAMES = [
  "project_ledger_work_update",
  "project_ledger_work_complete",
  "project_ledger_task_update",
  "project_ledger_task_complete",
  "project_ledger_attempt_start",
  "project_ledger_attempt_succeed",
  "project_ledger_attempt_fail",
] as const;

export const PROJECT_LEDGER_MUTATION_TOOL_NAMES = [
  "project_ledger_index",
  "project_ledger_create",
  "project_ledger_update",
  "project_ledger_render",
  // Legacy aliases execute the same persistent Ledger operations and must
  // share one capability boundary with the native mutation surface.
  "render_project_dashboard",
  "complete_project_work",
  ...PROJECT_LEDGER_LIFECYCLE_TOOL_NAMES,
] as const;

export const PROJECT_LEDGER_MUTATION_TOOL_NAME_SET = new Set<string>(PROJECT_LEDGER_MUTATION_TOOL_NAMES);
