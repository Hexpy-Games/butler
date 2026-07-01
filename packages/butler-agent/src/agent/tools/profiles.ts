import type { FunctionToolDefinition } from "../../integrations/providers/provider.ts";
import { BUTLER_TOOLS } from "./butler-tools.ts";

export type ButlerToolProfile =
  | "startup"
  | "project"
  | "workspace"
  | "public-web"
  | "memory-read"
  | "memory-write"
  | "monitoring"
  | "automation"
  | "mcp"
  | "delegation"
  | "planned-work"
  | "orchestration"
  | "artifact-data";

const STARTUP_TOOL_NAMES = [
  "list_tool_capabilities",
  "tool_search",
  "tool_describe",
  "tool_call",
  "get_context_monitor",
  "read_conversation_context",
  "update_todo_list",
  "list_todo_list",
] as const;

const PROJECT_TOOL_NAMES = [
  "project_ledger_status",
  "inspect_project_status",
  "query_project_work",
  "render_project_dashboard",
] as const;

const WORKSPACE_TOOL_NAMES = [
  "run_command",
  "read_file",
  "write_file",
  "grep_files",
  "read_tool_output_artifact",
] as const;

const PUBLIC_WEB_TOOL_NAMES = ["web_search", "web_read"] as const;

const MEMORY_READ_TOOL_NAMES = ["recall_memory", "query_memory", "read_conversation_context"] as const;

const MEMORY_WRITE_TOOL_NAMES = [
  "update_explicit_memory",
  "ingest_task_memory",
  "summarize_user_profile",
  "update_onboarding_profile",
] as const;

const MONITORING_TOOL_NAMES = [
  "get_work_dashboard",
  "get_context_monitor",
  "get_usage_monitor",
  "get_memory_health",
] as const;

const AUTOMATION_TOOL_NAMES = [
  "create_automation",
  "list_automations",
  "delete_automation",
  "run_due_automations",
] as const;

const MCP_TOOL_NAMES = [
  "list_mcp_capabilities",
  "call_mcp_tool",
  "read_mcp_resource",
] as const;

const DELEGATION_TOOL_NAMES = [
  "dispatch_worker",
  "resume_worker",
  "list_tasks",
  "get_task_result",
] as const;

const PLANNED_WORK_TOOL_NAMES = [
  "create_planned_task",
  "run_planned_task",
  "review_planned_task",
  "repair_planned_task",
  "request_principal_decision",
  "write_planned_public_report",
] as const;

const ORCHESTRATION_TOOL_NAMES = [
  "create_work_orchestration",
  "run_ready_work_streams",
  "sync_work_orchestration",
  "write_work_orchestration_report",
] as const;

const ARTIFACT_DATA_TOOL_NAMES = ["transform_public_data_table"] as const;

const PROFILE_TOOL_NAMES: Record<ButlerToolProfile, readonly string[]> = {
  startup: STARTUP_TOOL_NAMES,
  project: PROJECT_TOOL_NAMES,
  workspace: WORKSPACE_TOOL_NAMES,
  "public-web": PUBLIC_WEB_TOOL_NAMES,
  "memory-read": MEMORY_READ_TOOL_NAMES,
  "memory-write": MEMORY_WRITE_TOOL_NAMES,
  monitoring: MONITORING_TOOL_NAMES,
  automation: AUTOMATION_TOOL_NAMES,
  mcp: MCP_TOOL_NAMES,
  delegation: DELEGATION_TOOL_NAMES,
  "planned-work": PLANNED_WORK_TOOL_NAMES,
  orchestration: ORCHESTRATION_TOOL_NAMES,
  "artifact-data": ARTIFACT_DATA_TOOL_NAMES,
};

const WORKER_DEFAULT_TOOL_NAMES = [
  "tool_search",
  "tool_describe",
  "tool_call",
  "run_command",
  "read_file",
  "write_file",
  "grep_files",
  "read_tool_output_artifact",
  "project_ledger_status",
  "project_ledger_list",
  "project_ledger_show",
  "inspect_project_status",
  "query_project_work",
  "render_project_dashboard",
  "web_search",
  "web_read",
  "get_work_dashboard",
  "get_context_monitor",
  "get_usage_monitor",
  "read_conversation_context",
  "recall_memory",
  "query_memory",
  "update_todo_list",
  "list_todo_list",
  "list_work_streams",
  "update_work_stream_state",
  "transform_public_data_table",
] as const;

const WORKER_FORBIDDEN_TOOL_NAMES = new Set([
  "dispatch_worker",
  "resume_worker",
  "create_planned_task",
  "run_planned_task",
  "repair_planned_task",
  "request_principal_decision",
  "write_planned_public_report",
  "create_work_orchestration",
  "run_ready_work_streams",
  "sync_work_orchestration",
  "write_work_orchestration_report",
  "complete_project_work",
]);

const ALL_TOOL_NAMES = new Set(BUTLER_TOOLS.map((tool) => tool.name));
const ALL_PROFILE_NAMES = new Set(Object.keys(PROFILE_TOOL_NAMES) as ButlerToolProfile[]);

export interface ButlerToolPolicyDiagnostics {
  unknownRequiredNativeToolProfiles: string[];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function hasProjectContext(input: { sessionMetadata?: Record<string, unknown>; turnMetadata?: Record<string, unknown> }): boolean {
  const session = input.sessionMetadata ?? {};
  const turn = input.turnMetadata ?? {};
  const runtimePolicy = recordValue(turn.runtimePolicy);
  return Boolean(
    session.projectId ||
      session.project_id ||
      session.projectPath ||
      session.project_path ||
      turn.projectId ||
      turn.project_id ||
      turn.projectPath ||
      turn.project_path ||
      runtimePolicy.projectId ||
      runtimePolicy.project_id ||
      runtimePolicy.projectPath ||
      runtimePolicy.project_path,
  );
}

function mentionsProjectLedger(text: string | undefined): boolean {
  if (!text) return false;
  return /\bproject[-\s]?ledger\b|\bledger\b|프로젝트\s*원장|원장/u.test(text.toLowerCase());
}

function policyArray(metadata: unknown, camelKey: string, snakeKey: string): unknown[] {
  const record = recordValue(metadata);
  const runtimePolicy = recordValue(record.runtimePolicy);
  const raw = record[camelKey] ?? record[snakeKey] ?? runtimePolicy[camelKey] ?? runtimePolicy[snakeKey];
  return Array.isArray(raw) ? raw : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function requiredToolNames(metadata: unknown): string[] {
  return uniqueStrings(policyArray(metadata, "requiredNativeTools", "required_tools")
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && ALL_TOOL_NAMES.has(value)));
}

function requiredToolProfiles(metadata: unknown): ButlerToolProfile[] {
  return uniqueStrings(policyArray(metadata, "requiredNativeToolProfiles", "required_tool_profiles")
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value): value is ButlerToolProfile =>
      value.length > 0 && ALL_PROFILE_NAMES.has(value as ButlerToolProfile),
    )) as ButlerToolProfile[];
}

export function diagnoseButlerToolPolicy(input: {
  sessionMetadata?: Record<string, unknown>;
  turnMetadata?: Record<string, unknown>;
}): ButlerToolPolicyDiagnostics {
  const invalidProfiles = [
    ...policyArray(input.sessionMetadata, "requiredNativeToolProfiles", "required_tool_profiles"),
    ...policyArray(input.turnMetadata, "requiredNativeToolProfiles", "required_tool_profiles"),
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && !ALL_PROFILE_NAMES.has(value as ButlerToolProfile));

  return {
    unknownRequiredNativeToolProfiles: uniqueStrings(invalidProfiles),
  };
}

function requiredToolNamesForTurn(input: {
  sessionMetadata?: Record<string, unknown>;
  turnMetadata?: Record<string, unknown>;
}): string[] {
  return uniqueStrings([
    ...requiredToolNames(input.sessionMetadata),
    ...requiredToolNames(input.turnMetadata),
  ]);
}

function addProfile(profiles: Set<ButlerToolProfile>, profile: ButlerToolProfile): void {
  profiles.add(profile);
}

export function selectButlerToolProfiles(input: {
  role: string;
  text?: string;
  sessionMetadata?: Record<string, unknown>;
  turnMetadata?: Record<string, unknown>;
}): ButlerToolProfile[] {
  if (input.role === "worker") {
    return ["startup", "project", "workspace", "public-web", "memory-read", "monitoring", "artifact-data"];
  }
  const profiles = new Set<ButlerToolProfile>(["startup"]);
  if (hasProjectContext(input) || mentionsProjectLedger(input.text)) {
    addProfile(profiles, "project");
  }
  for (const profile of requiredToolProfiles(input.sessionMetadata)) addProfile(profiles, profile);
  for (const profile of requiredToolProfiles(input.turnMetadata)) addProfile(profiles, profile);
  return [...profiles];
}

export function selectButlerToolsForTurn(input: {
  role: string;
  text?: string;
  sessionMetadata?: Record<string, unknown>;
  turnMetadata?: Record<string, unknown>;
  tools?: readonly FunctionToolDefinition[];
}): FunctionToolDefinition[] {
  const tools = input.tools ?? BUTLER_TOOLS;
  const allowedNames = new Set<string>();
  if (input.role === "worker") {
    for (const name of WORKER_DEFAULT_TOOL_NAMES) allowedNames.add(name);
  } else {
    for (const profile of selectButlerToolProfiles(input)) {
      for (const name of PROFILE_TOOL_NAMES[profile]) allowedNames.add(name);
    }
  }
  for (const name of requiredToolNamesForTurn(input)) {
    if (input.role === "worker" && WORKER_FORBIDDEN_TOOL_NAMES.has(name)) continue;
    allowedNames.add(name);
  }
  return tools.filter((tool) =>
    allowedNames.has(tool.name) &&
    !(input.role === "worker" && WORKER_FORBIDDEN_TOOL_NAMES.has(tool.name)),
  );
}

export function toolContractJsonChars(tools: readonly FunctionToolDefinition[]): number {
  return tools.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0);
}
