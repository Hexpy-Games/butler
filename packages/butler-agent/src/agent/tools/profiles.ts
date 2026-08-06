import type { FunctionToolDefinition } from "../../integrations/providers/provider.ts";
import { BUTLER_TOOLS } from "./butler-tools.ts";
import {
  PROJECT_LEDGER_LIFECYCLE_TOOL_NAMES,
  PROJECT_LEDGER_MUTATION_TOOL_NAME_SET,
} from "./project-ledger/mutation-tools.ts";

export type ButlerToolProfile =
  | "startup"
  | "project"
  | "project-lifecycle"
  | "workspace"
  | "public-web"
  | "memory-read"
  | "memory-write"
  | "monitoring"
  | "automation"
  | "mcp"
  | "artifact-data";

const STARTUP_TOOL_NAMES = [
  "list_tool_capabilities",
  "tool_search",
  "tool_describe",
  "tool_call",
  "get_context_monitor",
  "read_tool_evidence_artifact",
  "read_conversation_context",
  "list_conversation_sessions",
  "read_conversation_session",
  "recall_memory",
  "update_todo_list",
  "list_todo_list",
] as const;

const PROJECT_TOOL_NAMES = [
  "project_ledger_status",
  "project_ledger_list",
  "project_ledger_show",
  "project_ledger_check",
  "inspect_project_status",
  "query_project_work",
  "render_project_dashboard",
] as const;

const PROJECT_LEDGER_INSPECTION_TOOL_NAMES = new Set<string>([
  "project_ledger_index",
  "project_ledger_status",
  "project_ledger_list",
  "project_ledger_show",
  "project_ledger_create",
  "project_ledger_update",
  "project_ledger_render",
  "project_ledger_check",
  "inspect_project_status",
  "query_project_work",
  "render_project_dashboard",
]);

const WORKSPACE_TOOL_NAMES = [
  "run_command",
  "read_file",
  "write_file",
  "edit_file",
  "grep_files",
  "read_tool_evidence_artifact",
  "read_tool_output_artifact",
] as const;

const PUBLIC_WEB_TOOL_NAMES = ["web_search", "web_read"] as const;

const MEMORY_READ_TOOL_NAMES = [
  "recall_memory",
  "query_memory",
  "read_conversation_context",
  "list_conversation_sessions",
  "read_conversation_session",
] as const;

const MEMORY_WRITE_TOOL_NAMES = [
  "update_explicit_memory",
  "ingest_task_memory",
  "summarize_user_profile",
  "update_onboarding_profile",
] as const;

const MONITORING_TOOL_NAMES = [
  "get_work_dashboard",
  "get_context_monitor",
  "read_tool_evidence_artifact",
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

const ARTIFACT_DATA_TOOL_NAMES = ["transform_public_data_table"] as const;

const PROFILE_TOOL_NAMES: Record<ButlerToolProfile, readonly string[]> = {
  startup: STARTUP_TOOL_NAMES,
  project: PROJECT_TOOL_NAMES,
  "project-lifecycle": PROJECT_LEDGER_LIFECYCLE_TOOL_NAMES,
  workspace: WORKSPACE_TOOL_NAMES,
  "public-web": PUBLIC_WEB_TOOL_NAMES,
  "memory-read": MEMORY_READ_TOOL_NAMES,
  "memory-write": MEMORY_WRITE_TOOL_NAMES,
  monitoring: MONITORING_TOOL_NAMES,
  automation: AUTOMATION_TOOL_NAMES,
  mcp: MCP_TOOL_NAMES,
  "artifact-data": ARTIFACT_DATA_TOOL_NAMES,
};

const WORKER_DEFAULT_TOOL_NAMES = [
  "tool_search",
  "tool_describe",
  "tool_call",
  "run_command",
  "read_file",
  "write_file",
  "edit_file",
  "grep_files",
  "read_tool_evidence_artifact",
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
  "list_conversation_sessions",
  "read_conversation_session",
  "recall_memory",
  "query_memory",
  "update_todo_list",
  "list_todo_list",
  "list_work_streams",
  "update_work_stream_state",
  "transform_public_data_table",
] as const;

const WORKER_FORBIDDEN_TOOL_NAMES = new Set([
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

function policyString(metadata: unknown, camelKey: string, snakeKey: string): string | null {
  const record = recordValue(metadata);
  const runtimePolicy = recordValue(record.runtimePolicy);
  const raw = record[snakeKey] ?? runtimePolicy[snakeKey] ?? record[camelKey] ?? runtimePolicy[camelKey];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function trackingPolicyString(input: {
  sessionMetadata?: Record<string, unknown>;
  turnMetadata?: Record<string, unknown>;
}, camelKey: string, snakeKey: string): string | null {
  return policyString(input.turnMetadata, camelKey, snakeKey) ??
    policyString(input.sessionMetadata, camelKey, snakeKey);
}

function projectLedgerLifecycleAllowed(input: {
  sessionMetadata?: Record<string, unknown>;
  turnMetadata?: Record<string, unknown>;
}): boolean {
  const trackingMode = trackingPolicyString(input, "trackingMode", "tracking_mode");
  const accessMode = trackingPolicyString(input, "accessMode", "access_mode");
  return trackingMode === "ledger" && accessMode !== "read_only";
}

function projectLedgerTrackingEnabled(input: {
  sessionMetadata?: Record<string, unknown>;
  turnMetadata?: Record<string, unknown>;
}): boolean {
  return trackingPolicyString(input, "trackingMode", "tracking_mode") === "ledger";
}

function fixedToolSurfaceEnabled(input: {
  sessionMetadata?: Record<string, unknown>;
  turnMetadata?: Record<string, unknown>;
}): boolean {
  return trackingPolicyString(input, "toolSurfaceMode", "tool_surface_mode") === "fixed";
}

function projectLedgerInspectionSuppressed(input: {
  sessionMetadata?: Record<string, unknown>;
  turnMetadata?: Record<string, unknown>;
}): boolean {
  const trackingMode = trackingPolicyString(input, "trackingMode", "tracking_mode");
  return trackingMode === "local" || trackingMode === "none";
}

function addProfile(profiles: Set<ButlerToolProfile>, profile: ButlerToolProfile): void {
  profiles.add(profile);
}

function addProfiles(profiles: Set<ButlerToolProfile>, values: ButlerToolProfile[]): void {
  for (const profile of values) addProfile(profiles, profile);
}

function inferredProjectLedgerProfiles(input: {
  sessionMetadata?: Record<string, unknown>;
  turnMetadata?: Record<string, unknown>;
}, projectContext: boolean): ButlerToolProfile[] {
  const profiles: ButlerToolProfile[] = [];
  if (!projectLedgerInspectionSuppressed(input) && (projectContext || projectLedgerTrackingEnabled(input))) {
    profiles.push("project");
  }
  if (projectContext && projectLedgerLifecycleAllowed(input)) {
    profiles.push("project-lifecycle");
  }
  return profiles;
}

function normalizeProjectLedgerProfiles(
  profiles: Set<ButlerToolProfile>,
  input: {
    text?: string;
    sessionMetadata?: Record<string, unknown>;
    turnMetadata?: Record<string, unknown>;
  },
): void {
  if (projectLedgerInspectionSuppressed(input)) {
    profiles.delete("project");
    profiles.delete("project-lifecycle");
    return;
  }
  if (projectLedgerTrackingEnabled(input) || profiles.has("project-lifecycle")) {
    profiles.add("project");
  }
  if (!projectLedgerLifecycleAllowed(input)) {
    profiles.delete("project-lifecycle");
  }
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
  const projectContext = hasProjectContext(input);
  addProfiles(profiles, inferredProjectLedgerProfiles(input, projectContext));
  addProfiles(profiles, requiredToolProfiles(input.sessionMetadata));
  addProfiles(profiles, requiredToolProfiles(input.turnMetadata));
  normalizeProjectLedgerProfiles(profiles, input);
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
  if (fixedToolSurfaceEnabled(input)) {
    const turnProfiles = requiredToolProfiles(input.turnMetadata);
    const fixedProfiles = turnProfiles.length > 0
      ? turnProfiles
      : requiredToolProfiles(input.sessionMetadata);
    const fixedNames = new Set(requiredToolNamesForTurn(input));
    for (const profile of fixedProfiles) {
      for (const name of PROFILE_TOOL_NAMES[profile]) fixedNames.add(name);
    }
    if (!projectLedgerLifecycleAllowed(input)) {
      for (const name of PROJECT_LEDGER_MUTATION_TOOL_NAME_SET) fixedNames.delete(name);
    }
    if (projectLedgerInspectionSuppressed(input)) {
      for (const name of PROJECT_LEDGER_INSPECTION_TOOL_NAMES) fixedNames.delete(name);
    }
    return tools.filter((tool) =>
      fixedNames.has(tool.name) &&
      !(input.role === "worker" && WORKER_FORBIDDEN_TOOL_NAMES.has(tool.name)),
    ).map(fixedWorkspaceToolDefinition);
  }
  if (!projectLedgerLifecycleAllowed(input)) {
    for (const name of PROJECT_LEDGER_MUTATION_TOOL_NAME_SET) allowedNames.delete(name);
  }
  if (projectLedgerInspectionSuppressed(input)) {
    for (const name of PROJECT_LEDGER_INSPECTION_TOOL_NAMES) allowedNames.delete(name);
    for (const name of PROJECT_LEDGER_MUTATION_TOOL_NAME_SET) allowedNames.delete(name);
  }
  return tools.filter((tool) =>
    allowedNames.has(tool.name) &&
    !(input.role === "worker" && WORKER_FORBIDDEN_TOOL_NAMES.has(tool.name)),
  );
}

function fixedWorkspaceToolDefinition(tool: FunctionToolDefinition): FunctionToolDefinition {
  if (
    tool.name !== "grep_files" &&
    tool.name !== "read_file" &&
    tool.name !== "write_file" &&
    tool.name !== "edit_file"
  ) return tool;
  const parameters = recordValue(tool.parameters);
  const properties = recordValue(parameters.properties);
  const modelProperties = { ...properties };
  delete modelProperties.workspace_root;
  if (tool.name === "write_file" || tool.name === "edit_file") {
    delete modelProperties.expected_sha256;
  }
  if (Object.keys(modelProperties).length === Object.keys(properties).length) {
    return tool;
  }
  return {
    ...tool,
    parameters: {
      ...parameters,
      properties: modelProperties,
    },
  };
}

export function toolContractJsonChars(tools: readonly FunctionToolDefinition[]): number {
  return tools.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0);
}
