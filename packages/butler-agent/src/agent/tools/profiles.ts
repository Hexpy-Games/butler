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
  "get_context_monitor",
  "read_conversation_context",
  "update_todo_list",
  "list_todo_list",
] as const;

const PROJECT_TOOL_NAMES = [
  "inspect_project_status",
  "query_project_work",
  "render_project_dashboard",
] as const;

const WORKSPACE_TOOL_NAMES = [
  "run_command",
  "read_tool_output_artifact",
] as const;

const PUBLIC_WEB_TOOL_NAMES = [
  "web_search",
  "web_read",
] as const;

const MEMORY_READ_TOOL_NAMES = [
  "recall_memory",
  "query_memory",
  "read_conversation_context",
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

const ARTIFACT_DATA_TOOL_NAMES = [
  "transform_public_data_table",
] as const;

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

const DOMAIN_PACK_TOOL_NAMES = new Set([
  "get_weather_with_knowhow",
  "record_weather_source_feedback",
  "run_weather_knowhow_consolidation",
]);

const ALL_TOOL_NAMES = new Set(BUTLER_TOOLS.map((tool) => tool.name));

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

function requiredToolNames(metadata: unknown): string[] {
  const record = recordValue(metadata);
  const runtimePolicy = recordValue(record.runtimePolicy);
  const raw = record.requiredNativeTools ?? record.required_tools ?? runtimePolicy.requiredNativeTools ??
    runtimePolicy.required_tools;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && ALL_TOOL_NAMES.has(value));
}

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.toLocaleLowerCase("en-US") : "";
}

function addProfile(profiles: Set<ButlerToolProfile>, profile: ButlerToolProfile): void {
  profiles.add(profile);
}

function profilesFromText(text: string): ButlerToolProfile[] {
  const profiles = new Set<ButlerToolProfile>();
  const value = normalizedText(text);
  if (!value) return [];

  if (/\b(project ledger|ledger|project status|project work|next actions?)\b/u.test(value) ||
    /프로젝트\s*원장|프로젝트\s*상태|프로젝트\s*작업|다음\s*작업/u.test(value)) {
    addProfile(profiles, "project");
  }
  if (/\b(search|web|source|citation|cite|news|latest|current|url|http|public)\b/u.test(value) ||
    /검색|출처|최신|현재|뉴스|인용|공개|웹/u.test(value)) {
    addProfile(profiles, "public-web");
  }
  if (/\b(file|repo|repository|code|command|shell|terminal|run|verify|test|script|log|manifest|package)\b/u.test(value) ||
    /파일|레포|저장소|작업공간|워크스페이스|코드|명령|터미널|검증|테스트|스크립트|로그/u.test(value)) {
    addProfile(profiles, "workspace");
  }
  if (/\b(memory|remember|recall|previous|earlier|conversation|transcript)\b/u.test(value) ||
    /기억|이전|앞서|대화|위에서|방금|지난/u.test(value)) {
    addProfile(profiles, "memory-read");
  }
  if (/\b(save|remember this|preference|rule|profile|onboarding)\b/u.test(value) ||
    /저장|기억해|규칙|선호|프로필|온보딩/u.test(value)) {
    addProfile(profiles, "memory-write");
  }
  if (/\b(usage|tokens|context|dashboard|status|health|cost)\b/u.test(value) ||
    /사용량|토큰|컨텍스트|대시보드|헬스|비용/u.test(value)) {
    addProfile(profiles, "monitoring");
  }
  if (/\b(automation|schedule|reminder|recurring|cron)\b/u.test(value) ||
    /자동화|예약|알림|반복/u.test(value)) {
    addProfile(profiles, "automation");
  }
  if (/\b(mcp|connector|resource)\b/u.test(value) || /커넥터|리소스/u.test(value)) {
    addProfile(profiles, "mcp");
  }
  if (/\b(background|worker|async|delegate|resume)\b/u.test(value) ||
    /백그라운드|워커|비동기|위임|재개/u.test(value)) {
    addProfile(profiles, "delegation");
  }
  if (/\b(plan|planned|review|repair|migration|risky|acceptance)\b/u.test(value) ||
    /계획|검토|수리|마이그레이션|위험|인수조건/u.test(value)) {
    addProfile(profiles, "planned-work");
  }
  if (/\b(orchestration|multi-worker|parallel streams)\b/u.test(value) ||
    /오케스트레이션|병렬|스트림/u.test(value)) {
    addProfile(profiles, "orchestration");
  }
  if (/\b(csv|table|artifact|chart|data)\b/u.test(value) || /csv|표|아티팩트|차트|데이터/u.test(value)) {
    addProfile(profiles, "artifact-data");
  }
  return [...profiles];
}

export function selectButlerToolProfiles(input: {
  role: string;
  text?: string;
  sessionMetadata?: Record<string, unknown>;
  turnMetadata?: Record<string, unknown>;
}): ButlerToolProfile[] {
  const profiles = new Set<ButlerToolProfile>(["startup"]);
  if (hasProjectContext(input)) addProfile(profiles, "project");
  for (const profile of profilesFromText(input.text ?? "")) addProfile(profiles, profile);
  for (const name of requiredToolNames(input.turnMetadata)) {
    for (const [profile, names] of Object.entries(PROFILE_TOOL_NAMES) as Array<[ButlerToolProfile, readonly string[]]>) {
      if (names.includes(name)) addProfile(profiles, profile);
    }
  }
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
  for (const profile of selectButlerToolProfiles(input)) {
    for (const name of PROFILE_TOOL_NAMES[profile]) allowedNames.add(name);
  }
  for (const name of requiredToolNames(input.turnMetadata)) {
    if (!DOMAIN_PACK_TOOL_NAMES.has(name)) allowedNames.add(name);
  }
  return tools.filter((tool) => allowedNames.has(tool.name) && !DOMAIN_PACK_TOOL_NAMES.has(tool.name));
}

export function toolContractJsonChars(tools: readonly FunctionToolDefinition[]): number {
  return tools.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0);
}
