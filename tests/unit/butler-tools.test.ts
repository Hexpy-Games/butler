import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  BUTLER_TOOLS,
  butlerToolsForAgentLoop,
  createButlerToolExecutor,
  createButlerToolExecutorRegistry,
} from "../../packages/butler-agent/src/agent/tools/butler-tools.ts";
import {
  diagnoseButlerToolPolicy,
  selectButlerToolProfiles,
  selectButlerToolsForTurn,
  toolContractJsonChars,
} from "../../packages/butler-agent/src/agent/tools/profiles.ts";
import { TaskStore } from "../../packages/butler-agent/src/agent/work/task-store.ts";
import { PlannedTaskStore } from "../../packages/butler-agent/src/agent/work/planned-task.ts";
import { DisabledWebSearchProvider, MockWebSearchProvider, readWebSearchMetrics } from "../../packages/butler-agent/src/integrations/search/provider.ts";
import { appendRuntimeTurnContextMetric } from "../../packages/butler-agent/src/operations/metrics/context-monitor.ts";
import { appendPromptCacheMetric } from "../../packages/butler-agent/src/integrations/providers/prompt-cache-metrics.ts";
import { budgetToolOutput } from "../../packages/butler-agent/src/agent/context/tool-output-budgeter.ts";
import { indexTranscriptLinesForQuery } from "../../packages/butler-agent/src/agent/cognition/memory/exact-query.ts";

let tempDir = "";
const root = process.cwd();
const projectLedgerCli = join(root, "packages", "project-ledger", "bin", "project-ledger");
const startupOnlyToolNames: string[] = [
  "get_context_monitor",
  "list_tool_capabilities",
  "tool_search",
  "tool_describe",
  "tool_call",
  "update_todo_list",
  "list_todo_list",
  "read_conversation_context",
];
const projectMetadataToolNames: string[] = [
  "inspect_project_status",
  "query_project_work",
  "render_project_dashboard",
  "complete_project_work",
  ...startupOnlyToolNames,
];
const projectWorkspaceToolNames: string[] = [
  "run_command",
  "read_file",
  "write_file",
  "grep_files",
  "inspect_project_status",
  "query_project_work",
  "render_project_dashboard",
  "complete_project_work",
  "get_context_monitor",
  "read_tool_output_artifact",
  "list_tool_capabilities",
  "tool_search",
  "tool_describe",
  "tool_call",
  "update_todo_list",
  "list_todo_list",
  "read_conversation_context",
];
const removedWeatherToolNames = [
  "get_weather_with_knowhow",
  "record_weather_source_feedback",
  "run_weather_knowhow_consolidation",
] as const;
const promptOnlySurfaceFixtures = [
  {
    name: "Korean implicit current-information need about prices",
    text: "요즘 계란 가격이 왜 이렇게 불안한지 원인과 전망을 정리해줘.",
    expectedProfiles: ["startup"],
    expectedToolNames: startupOnlyToolNames,
  },
  {
    name: "Korean implicit current-information need about policy",
    text: "지금 전세 대출 분위기가 실수요자에게 어떤 의미인지 판단해줘.",
    expectedProfiles: ["startup"],
    expectedToolNames: startupOnlyToolNames,
  },
  {
    name: "English implicit external-evidence need about a claim",
    text: "Before I answer the customer, check whether this claim is actually supported and give me the confidence level.",
    expectedProfiles: ["startup"],
    expectedToolNames: startupOnlyToolNames,
  },
  {
    name: "English implicit external-evidence need about vendor numbers",
    text: "I need a source-backed answer on whether this vendor's adoption numbers are credible.",
    expectedProfiles: ["startup"],
    expectedToolNames: startupOnlyToolNames,
  },
  {
    name: "No-keyword planning prompt",
    text: "Turn this rough idea into three crisp action items for the next team sync.",
    expectedProfiles: ["startup"],
    expectedToolNames: startupOnlyToolNames,
  },
  {
    name: "No-keyword explanation prompt",
    text: "Explain the tradeoff between speed and reliability for a small release checklist.",
    expectedProfiles: ["startup"],
    expectedToolNames: startupOnlyToolNames,
  },
] as const;

beforeEach(() => {
  tempDir = join(tmpdir(), `butler-tools-${Date.now()}-${Math.random()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function runProjectLedger(args: string[], projectPath: string): void {
  const result = spawnSync(process.execPath, [projectLedgerCli, ...args, "--project", projectPath, "--json"], {
    encoding: "utf8",
    env: { ...process.env, BUTLER_DATA: tempDir },
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
}

test("Butler tool registry exposes stable native tool contracts", () => {
  expect(BUTLER_TOOLS.map((tool) => tool.name)).toEqual([
    "web_search",
    "web_read",
    "transform_public_data_table",
    "run_command",
    "read_file",
    "write_file",
    "grep_files",
    "get_work_dashboard",
    "inspect_project_status",
    "query_project_work",
    "render_project_dashboard",
    "complete_project_work",
    "get_context_monitor",
    "read_tool_output_artifact",
    "get_usage_monitor",
    "list_tool_capabilities",
    "tool_search",
    "tool_describe",
    "tool_call",
    "list_mcp_capabilities",
    "call_mcp_tool",
    "read_mcp_resource",
    "create_automation",
    "list_automations",
    "delete_automation",
    "run_due_automations",
    "update_todo_list",
    "list_todo_list",
    "list_work_streams",
    "update_work_stream_state",
    "control_work",
    "get_memory_health",
    "ingest_task_memory",
    "recall_memory",
    "query_memory",
    "summarize_user_profile",
    "update_onboarding_profile",
    "read_conversation_context",
    "update_explicit_memory",
    "list_skills",
    "dispatch_worker",
    "create_planned_task",
    "run_planned_task",
    "review_planned_task",
    "repair_planned_task",
    "request_principal_decision",
    "write_planned_public_report",
    "resume_worker",
    "create_work_orchestration",
    "run_ready_work_streams",
    "sync_work_orchestration",
    "write_work_orchestration_report",
    "list_tasks",
    "get_task_result",
  ]);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "web_search")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "web_read")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "transform_public_data_table")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "run_command")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "get_work_dashboard")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "inspect_project_status")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "query_project_work")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "render_project_dashboard")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "complete_project_work")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "get_context_monitor")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "read_tool_output_artifact")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "get_usage_monitor")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "list_tool_capabilities")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "tool_search")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "tool_describe")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "tool_call")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "list_mcp_capabilities")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "call_mcp_tool")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "read_mcp_resource")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "create_automation")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "list_automations")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "delete_automation")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "run_due_automations")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "update_todo_list")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "list_todo_list")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "control_work")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "get_memory_health")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "ingest_task_memory")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "recall_memory")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "query_memory")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "summarize_user_profile")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "update_onboarding_profile")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "read_conversation_context")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "update_explicit_memory")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "list_skills")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "dispatch_worker")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "create_planned_task")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "run_planned_task")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "review_planned_task")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "repair_planned_task")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "request_principal_decision")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "write_planned_public_report")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "resume_worker")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "create_work_orchestration")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "run_ready_work_streams")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "sync_work_orchestration")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "write_work_orchestration_report")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "list_tasks")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.every((tool) => tool.transcriptVisibility === "visible")).toBe(true);
  const onboardingTool = BUTLER_TOOLS.find((tool) => tool.name === "update_onboarding_profile");
  const onboardingProperties = onboardingTool?.parameters.properties as Record<string, unknown> | undefined;
  const personaPresetProperty = onboardingProperties?.persona_preset as { enum?: unknown; description?: unknown } | undefined;
  expect(personaPresetProperty?.enum).toBeUndefined();
  expect(String(personaPresetProperty?.description)).toContain("persona_preset id");
});

test("agent tools directory groups canonical tool-name entrypoints", () => {
  const toolsRoot = join(root, "packages", "butler-agent", "src", "agent", "tools");
  const groupNames = readdirSync(toolsRoot)
    .filter((name) => statSync(join(toolsRoot, name)).isDirectory())
    .sort();
  const expectedGroups = [
    "automation",
    "data-table",
    "file-tools",
    "mcp",
    "memory",
    "monitoring",
    "orchestration",
    "planned-task",
    "project-ledger",
    "run-command",
    "skills",
    "tool-bridge",
    "web-read",
    "web-search",
    "work-tracking",
    "worker",
  ];
  const groupedToolNames = groupNames.flatMap((groupName) => (
    readdirSync(join(toolsRoot, groupName))
      .filter((name) => statSync(join(toolsRoot, groupName, name)).isDirectory())
      .filter((name) => existsSync(join(toolsRoot, groupName, name, "index.ts")))
      .map((name) => `${groupName}/${name}`)
  )).sort();
  const toolNames = BUTLER_TOOLS.map((tool) => tool.name).sort();
  const nestedToolNames = groupedToolNames.map((name) => name.split("/").at(1)).sort();

  expect(groupNames).toEqual(expectedGroups);
  expect(nestedToolNames).toEqual(toolNames);

  for (const groupName of groupNames) {
    expect(existsSync(join(toolsRoot, groupName, "executor.ts"))).toBe(false);
  }

  for (const name of groupedToolNames) {
    const source = readFileSync(join(toolsRoot, name, "index.ts"), "utf8");
    expect(source).not.toContain("export * from");
    expect(source).toContain("./definition.ts");
    expect(existsSync(join(toolsRoot, name, "executor.ts"))).toBe(true);
  }
});

test("weather native tools are absent from the registry, profiles, and executor", async () => {
  const registryNames = BUTLER_TOOLS.map((tool) => tool.name);
  for (const name of removedWeatherToolNames) {
    expect(registryNames).not.toContain(name);
  }

  const tools = selectButlerToolsForTurn({
    role: "butler",
    text: "반드시 공개 데이터 표를 만들어줘.",
    sessionMetadata: { projectId: "butler" },
    turnMetadata: {
      requiredNativeTools: [
        "transform_public_data_table",
        ...removedWeatherToolNames,
      ],
    },
  });
  const names = tools.map((tool) => tool.name);

  expect(names).toContain("transform_public_data_table");
  for (const name of removedWeatherToolNames) {
    expect(names).not.toContain(name);
  }

  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
  });
  await expect(executor({
    name: "get_weather_with_knowhow",
    args: { latitude: 37.5665, longitude: 126.9780 },
    rawArguments: "{}",
  })).rejects.toThrow("Unknown Butler tool: get_weather_with_knowhow");
});

test("Butler tool executor dispatch is registry-based instead of a call-name if-chain", () => {
  const registry = createButlerToolExecutorRegistry({
    sample_tool: () => ({ ok: true }),
  });
  expect(Object.keys(registry)).toEqual(["sample_tool"]);

  const source = readFileSync(
    join(root, "packages", "butler-agent", "src", "agent", "tools", "butler-tools.ts"),
    "utf8",
  );
  const executorSource = source.slice(source.indexOf("export function createButlerToolExecutor("));
  expect(executorSource).toContain("createButlerToolExecutorRegistry");
  expect(executorSource).toContain("executeRegisteredButlerTool(toolExecutors, call)");
  expect(executorSource).not.toMatch(/if\s*\(\s*call\.name\s*===/u);
});

test("Butler tool compatibility entrypoint does not own capability executor bodies", () => {
  const source = readFileSync(
    join(root, "packages", "butler-agent", "src", "agent", "tools", "butler-tools.ts"),
    "utf8",
  );
  const lineCount = source.split("\n").length;
  expect(lineCount).toBeLessThanOrEqual(280);
  expect(source).not.toMatch(/"[^"]+":\s*async\s*\(/u);
  expect(source).not.toContain("loadRuntimeSkills");
  expect(source).not.toContain("runProjectLedgerTool");
  expect(source).not.toContain("spawn(\"/bin/bash\"");
});

test("project sessions expose bounded project tools without workspace escalation", () => {
  const tools = selectButlerToolsForTurn({
    role: "butler",
    text: "Project Ledger 기준으로 상태를 확인해줘.",
    sessionMetadata: { projectId: "butler" },
  });
  const names = tools.map((tool) => tool.name);

  expect(selectButlerToolProfiles({
    role: "butler",
    text: "Project Ledger 기준으로 상태를 확인해줘.",
    sessionMetadata: { projectId: "butler" },
  })).toEqual(["startup", "project"]);
  expect(names).toEqual(projectMetadataToolNames);
  expect(names).not.toContain("run_command");
  expect(names).not.toContain("read_tool_output_artifact");
  expect(names).not.toContain("web_search");
  expect(names).not.toContain("web_read");
  expect(names).not.toContain("get_weather_with_knowhow");
  expect(names).not.toContain("create_automation");
  expect(names).not.toContain("call_mcp_tool");
  expect(names).not.toContain("create_planned_task");
  expect(names).not.toContain("create_work_orchestration");
  expect(toolContractJsonChars(tools)).toBeLessThan(10_000);
});

test("Korean Project Ledger registration prompts require explicit workspace policy", () => {
  const text = "그럼 이 목록들을 정리해서 다음 Feature 작업들로 등록하자. Project ledger에 등록해두고, github issue도 열어서 연결해놔. 각 phase가 work가 되고, 각 세부 구현이 task되겠지? 각 단계별로 세부적으로 스펙 작성해.";
  const tools = selectButlerToolsForTurn({
    role: "butler",
    text,
    sessionMetadata: { projectId: "butler" },
    turnMetadata: { runtimePolicy: { requiredNativeToolProfiles: ["workspace"] } },
  });
  const names = tools.map((tool) => tool.name);

  expect(selectButlerToolProfiles({
    role: "butler",
    text,
    sessionMetadata: { projectId: "butler" },
    turnMetadata: { runtimePolicy: { requiredNativeToolProfiles: ["workspace"] } },
  })).toEqual(["startup", "project", "workspace"]);
  expect(names).toEqual(projectWorkspaceToolNames);
  expect(names).not.toContain("web_search");
  expect(names).not.toContain("web_read");
  expect(names).not.toContain("create_automation");
  expect(names).not.toContain("call_mcp_tool");
  expect(toolContractJsonChars(tools)).toBeLessThan(15_000);
});

test("Korean Project Ledger registration text alone does not escalate project sessions to workspace", () => {
  const text = "그럼 이 목록들을 정리해서 다음 Feature 작업들로 등록하자. Project ledger에 등록해두고, github issue도 열어서 연결해놔. 각 phase가 work가 되고, 각 세부 구현이 task되겠지? 각 단계별로 세부적으로 스펙 작성해.";
  const tools = selectButlerToolsForTurn({
    role: "butler",
    text,
    sessionMetadata: { projectId: "butler" },
  });
  const names = tools.map((tool) => tool.name);

  expect(selectButlerToolProfiles({
    role: "butler",
    text,
    sessionMetadata: { projectId: "butler" },
  })).not.toContain("workspace");
  expect(names).toContain("inspect_project_status");
  expect(names).not.toContain("run_command");
  expect(names).not.toContain("read_tool_output_artifact");
});

test("workspace wording alone does not expose command execution without structured policy", () => {
  const text = "코드를 수정하고 테스트를 실행해서 결과를 검증해줘.";
  const tools = selectButlerToolsForTurn({
    role: "butler",
    text,
  });
  const names = tools.map((tool) => tool.name);

  expect(selectButlerToolProfiles({
    role: "butler",
    text,
  })).toEqual(["startup"]);
  expect(names).toEqual(startupOnlyToolNames);
  expect(names).not.toContain("run_command");
  expect(names).not.toContain("read_tool_output_artifact");
});

test("explicit required native tool profiles expose workspace file tools without prompt regex matching", () => {
  const tools = selectButlerToolsForTurn({
    role: "butler",
    text: "이 작업을 처리해줘.",
    turnMetadata: { runtimePolicy: { requiredNativeToolProfiles: ["workspace"] } },
  });
  const names = tools.map((tool) => tool.name);

  expect(selectButlerToolProfiles({
    role: "butler",
    text: "이 작업을 처리해줘.",
    turnMetadata: { runtimePolicy: { requiredNativeToolProfiles: ["workspace"] } },
  })).toEqual(["startup", "workspace"]);
  expect(names).toContain("run_command");
  expect(names).toContain("read_file");
  expect(names).toContain("write_file");
  expect(names).toContain("grep_files");
  expect(names).toContain("read_tool_output_artifact");
  expect(names).not.toContain("web_search");
  expect(names).not.toContain("web_read");
});

for (const fixture of promptOnlySurfaceFixtures) {
  test(`prompt text alone keeps startup-only tool surface: ${fixture.name}`, () => {
    const profiles = selectButlerToolProfiles({
      role: "butler",
      text: fixture.text,
    });
    const tools = selectButlerToolsForTurn({
      role: "butler",
      text: fixture.text,
    });
    const names = tools.map((tool) => tool.name);

    expect(profiles).toEqual([...fixture.expectedProfiles]);
    expect(names).toEqual([...fixture.expectedToolNames]);
    expect(profiles).not.toContain("public-web");
    expect(profiles).not.toContain("workspace");
    expect(profiles).not.toContain("project");
    expect(profiles).not.toContain("planned-work");
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("web_read");
    expect(names).not.toContain("run_command");
    expect(names).not.toContain("read_file");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("grep_files");
    expect(names).not.toContain("inspect_project_status");
    expect(names).not.toContain("query_project_work");
    expect(names).not.toContain("render_project_dashboard");
    expect(names).not.toContain("complete_project_work");
    expect(names).not.toContain("create_planned_task");
    expect(names).not.toContain("dispatch_worker");
  });
}

test("tool profile selector does not contain legacy prompt keyword activation tables", () => {
  const source = readFileSync(
    join(root, "packages", "butler-agent", "src", "agent", "tools", "profiles.ts"),
    "utf8",
  );

  expect(source).not.toContain("profilesFromText");
  expect(source).not.toMatch(/\b(?:PUBLIC_WEB|WEB|RESEARCH|CURRENT|FRESHNESS|WORKSPACE|PROJECT)_?(?:KEYWORDS|TERMS|PATTERNS)\b/u);
  expect(source).not.toMatch(/\[\s*(?:"검색"|"리서치"|"최신"|"최근"|"요즘")/u);
  expect(source).not.toMatch(/\/[^/\n]*(?:latest|current|fresh|research|search)[^/\n]*\/[a-z]*/u);
});

test("structured public web profile exposes web tools without widening workspace", () => {
  const tools = selectButlerToolsForTurn({
    role: "butler",
    text: promptOnlySurfaceFixtures[0].text,
    turnMetadata: { runtimePolicy: { requiredNativeToolProfiles: ["public-web"] } },
  });
  const names = tools.map((tool) => tool.name);

  expect(selectButlerToolProfiles({
    role: "butler",
    text: promptOnlySurfaceFixtures[0].text,
    turnMetadata: { runtimePolicy: { requiredNativeToolProfiles: ["public-web"] } },
  })).toEqual(["startup", "public-web"]);
  expect(names).toEqual([
    "web_search",
    "web_read",
    ...startupOnlyToolNames,
  ]);
  expect(names).not.toContain("run_command");
  expect(names).not.toContain("read_file");
});

test("native file tool wording alone does not expose workspace file tools", () => {
  const text = "Read source.txt, write created.txt, then grep for needle-marker using native file tools.";
  const tools = selectButlerToolsForTurn({
    role: "butler",
    text,
  });
  const names = tools.map((tool) => tool.name);

  expect(selectButlerToolProfiles({ role: "butler", text })).toEqual(["startup"]);
  expect(names).not.toContain("read_file");
  expect(names).not.toContain("write_file");
  expect(names).not.toContain("grep_files");
});

test("session-level required native tools expose exact tool names only", () => {
  const tools = selectButlerToolsForTurn({
    role: "butler",
    text: "이 작업을 처리해줘.",
    sessionMetadata: { runtimePolicy: { requiredNativeTools: ["run_command"] } },
  });
  const names = tools.map((tool) => tool.name);

  expect(selectButlerToolProfiles({
    role: "butler",
    text: "이 작업을 처리해줘.",
    sessionMetadata: { runtimePolicy: { requiredNativeTools: ["run_command"] } },
  })).toEqual(["startup"]);
  expect(names).toContain("run_command");
  expect(names).not.toContain("read_file");
  expect(names).not.toContain("write_file");
  expect(names).not.toContain("grep_files");
  expect(names).not.toContain("web_search");
  expect(names).not.toContain("web_read");
});

test("invalid required native tool profiles are diagnosable", () => {
  expect(diagnoseButlerToolPolicy({
    sessionMetadata: { runtimePolicy: { requiredNativeToolProfiles: ["workspaec", "workspace"] } },
    turnMetadata: { requiredNativeToolProfiles: ["github", "workspace", "github"] },
  })).toEqual({
    unknownRequiredNativeToolProfiles: ["workspaec", "github"],
  });
});

test("free-form GitHub issue linkage text alone does not expose project or workspace tools", () => {
  const tools = selectButlerToolsForTurn({
    role: "butler",
    text: "GitHub issue를 열어서 Project Ledger task랑 연결해줘.",
  });
  const names = tools.map((tool) => tool.name);

  expect(selectButlerToolProfiles({
    role: "butler",
    text: "GitHub issue를 열어서 Project Ledger task랑 연결해줘.",
  })).toEqual(["startup"]);
  expect(names).not.toContain("inspect_project_status");
  expect(names).not.toContain("run_command");
});

test("Project Ledger requests without project metadata do not expose project tools", () => {
  const tools = selectButlerToolsForTurn({
    role: "butler",
    text: "Project Ledger 상태와 next action을 확인하고 dashboard를 갱신해줘.",
  });
  const names = tools.map((tool) => tool.name);

  expect(selectButlerToolProfiles({
    role: "butler",
    text: "Project Ledger 상태와 next action을 확인하고 dashboard를 갱신해줘.",
  })).toEqual(["startup"]);
  expect(names).toEqual(startupOnlyToolNames);
  expect(names).not.toContain("inspect_project_status");
  expect(names).not.toContain("query_project_work");
  expect(names).not.toContain("render_project_dashboard");
  expect(names).not.toContain("get_weather_with_knowhow");
  expect(toolContractJsonChars(tools)).toBeLessThan(toolContractJsonChars(BUTLER_TOOLS));
});

test("Project Ledger completion requests expose complete_project_work", () => {
  const tools = selectButlerToolsForTurn({
    role: "butler",
    text: "Project Ledger work W-RUNTIME-TOOL-MODULARIZATION를 complete 처리해줘.",
    sessionMetadata: { projectId: "butler" },
  });
  const names = tools.map((tool) => tool.name);

  expect(names).toContain("inspect_project_status");
  expect(names).toContain("query_project_work");
  expect(names).toContain("render_project_dashboard");
  expect(names).toContain("complete_project_work");
});

test("explicit required tools add exact tool names while removed tool names are ignored", () => {
  const tools = selectButlerToolsForTurn({
    role: "butler",
    text: "반드시 표 artifact를 만들어줘.",
    sessionMetadata: { projectId: "butler" },
    turnMetadata: {
      requiredNativeTools: [
        "transform_public_data_table",
        "get_weather_with_knowhow",
      ],
    },
  });
  const names = tools.map((tool) => tool.name);

  expect(selectButlerToolProfiles({
    role: "butler",
    text: "반드시 표 artifact를 만들어줘.",
    sessionMetadata: { projectId: "butler" },
    turnMetadata: {
      requiredNativeTools: [
        "transform_public_data_table",
        "get_weather_with_knowhow",
      ],
    },
  })).toEqual(["startup", "project"]);
  expect(names).toContain("transform_public_data_table");
  expect(names).not.toContain("get_weather_with_knowhow");
  expect(names).not.toContain("web_search");
  expect(names).not.toContain("web_read");
});

test("worker tool profile keeps execution tools and blocks recursive orchestration tools", () => {
  const tools = selectButlerToolsForTurn({
    role: "worker",
    text: "Implement the assigned change, verify it, and report worker evidence.",
    sessionMetadata: { projectPath: root },
    turnMetadata: {
      requiredNativeTools: [
        "dispatch_worker",
        "create_planned_task",
        "run_ready_work_streams",
        "write_planned_public_report",
        "run_command",
        "update_work_stream_state",
      ],
    },
  });
  const names = tools.map((tool) => tool.name);

  expect(names).toEqual(expect.arrayContaining([
    "run_command",
    "grep_files",
    "read_tool_output_artifact",
    "update_todo_list",
    "list_todo_list",
    "list_work_streams",
    "update_work_stream_state",
    "web_search",
    "web_read",
  ]));
  expect(names).not.toContain("dispatch_worker");
  expect(names).not.toContain("resume_worker");
  expect(names).not.toContain("create_planned_task");
  expect(names).not.toContain("run_planned_task");
  expect(names).not.toContain("repair_planned_task");
  expect(names).not.toContain("create_work_orchestration");
  expect(names).not.toContain("run_ready_work_streams");
  expect(names).not.toContain("write_planned_public_report");
});

test("web_search schema exposes query and domain filters", () => {
  const tool = BUTLER_TOOLS.find((item) => item.name === "web_search");

  expect(tool?.parameters.required).toEqual(["query"]);
  expect(Object.keys(tool?.parameters.properties ?? {})).toEqual([
    "query",
    "allowed_domains",
    "blocked_domains",
    "recency_days",
    "max_results",
  ]);
});

test("web_read schema exposes bounded page evidence controls", () => {
  const tool = BUTLER_TOOLS.find((item) => item.name === "web_read");

  expect(tool?.parameters.required).toEqual(["url"]);
  expect(Object.keys(tool?.parameters.properties ?? {})).toEqual([
    "url",
    "max_chars",
    "max_chunks",
    "backend",
  ]);
});

test("transform_public_data_table writes bounded public CSV artifacts", async () => {
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
  });

  const result = await executor({
    name: "transform_public_data_table",
    args: {
      title: "충주 행사 샘플",
      columns: ["name", "date", "source"],
      rows: [
        { name: "중원문화제", date: "2026-05-06", source: "public calendar" },
        { name: "Authorization: Bearer private-token", date: "2026-05-07", source: "/Users/alice/private.txt" },
      ],
    },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    durable_artifact_created: boolean;
    artifact_kind: string;
    artifact_label: string;
    artifact_note: string;
    csv_preview: string;
    row_count: number;
    evidence_receipts: Array<Record<string, any>>;
  };

  expect(result.ok).toBe(true);
  expect(result.durable_artifact_created).toBe(true);
  expect(result.artifact_kind).toBe("csv_file");
  expect(result.artifact_label).toMatch(/^충주-행사-샘플-public-data-[a-f0-9-]+\.csv$/u);
  expect(result.artifact_label).not.toContain("_");
  expect(result.artifact_note).toContain("CSV file artifact has been written");
  expect(result.row_count).toBe(2);
  expect(result.csv_preview).toContain("name,date,source");
  expect(result.csv_preview).toContain("[redacted]");
  expect(result.csv_preview).toContain("[redacted-path]");
  expect(result.evidence_receipts).toHaveLength(1);
  expect(result.evidence_receipts[0]).toMatchObject({
    schema: "butler.evidence-receipt.v1",
    producer: { kind: "tool", name: "transform_public_data_table" },
    receiptType: "deliverable",
    verified: true,
    satisfies: ["durable_artifact", "data_table_created"],
    artifacts: [{
      label: result.artifact_label,
      mediaType: "text/csv",
      role: "table",
    }],
    metrics: {
      row_count: 2,
      column_count: 3,
    },
  });
  const artifactPath = join(tempDir, "artifacts", "public-data", result.artifact_label);
  expect(existsSync(artifactPath)).toBe(true);
  expect(readFileSync(artifactPath, "utf8")).toContain("중원문화제");
});

test("run_command schema exposes bounded non-interactive bash execution", () => {
  const tool = BUTLER_TOOLS.find((item) => item.name === "run_command");

  expect(tool?.parameters.required).toEqual(["command"]);
  expect(Object.keys(tool?.parameters.properties ?? {})).toEqual([
    "command",
    "cwd",
    "timeout_ms",
    "max_output_tokens",
    "output_paths",
    "output_mode",
  ]);
  expect(tool?.description).toContain("non-interactive bash command");
  const properties = tool?.parameters.properties as Record<string, unknown> | undefined;
  expect(properties?.output_paths).toMatchObject({
    type: "array",
  });
  expect(properties?.output_mode).toMatchObject({
    type: "string",
    enum: ["auto", "silent_on_success", "full"],
  });
});

test("run_command executes in the session workspace and returns structured output", async () => {
  const workspace = join(tempDir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });

  const result = await executor({
    name: "run_command",
    args: {
      command: "printf 'city,population\\nSeoul,9300000\\n' > sample.csv && pwd && wc -l sample.csv",
    },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    command: string;
    cwd: string;
    exit_code: number;
    timed_out: boolean;
    stdout: string;
    stderr: string;
    durable_artifact_created?: boolean;
    data_table_created?: boolean;
    verified_output_files?: Array<{ path: string; artifact_kind: string }>;
    written_files?: string[];
    artifact_kind?: string;
    evidence_receipts: Array<Record<string, any>>;
  };

  expect(result.ok).toBe(true);
  expect(result.exit_code).toBe(0);
  expect(result.timed_out).toBe(false);
  expect(result.command).toContain("sample.csv");
  expect(result.cwd).toBe(workspace);
  expect(result.stdout).toContain(workspace);
  expect(result.stdout).toContain("2 sample.csv");
  expect(result.stderr).toBe("");
  expect(result.durable_artifact_created).toBeUndefined();
  expect(result.data_table_created).toBeUndefined();
  expect(result.written_files).toBeUndefined();
  expect(result.artifact_kind).toBeUndefined();
  expect(result.verified_output_files).toBeUndefined();
  expect(result.evidence_receipts).toEqual([
    expect.objectContaining({
      receiptType: "execution",
      verified: true,
      satisfies: ["command_executed"],
    }),
  ]);
  expect(readFileSync(join(workspace, "sample.csv"), "utf8")).toContain("Seoul,9300000");
});

test("run_command implicit artifact discovery does not auto-promote workspace files", async () => {
  const workspace = join(tempDir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });

  const result = await executor({
    name: "run_command",
    args: {
      command: "mkdir -p reports && printf 'city,population\\nSeoul,9300000\\n' > reports/population.csv",
    },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    durable_artifact_created?: boolean;
    verified_output_files?: Array<{ path: string; artifact_kind: string }>;
    evidence_receipts: Array<Record<string, any>>;
  };

  expect(result.ok).toBe(true);
  expect(result.durable_artifact_created).toBeUndefined();
  expect(result.verified_output_files).toBeUndefined();
  expect(result.evidence_receipts).toEqual([
    expect.objectContaining({
      receiptType: "execution",
      verified: true,
      satisfies: ["command_executed"],
    }),
  ]);
  expect(readFileSync(join(workspace, "reports", "population.csv"), "utf8")).toContain("Seoul,9300000");
});

test("run_command structured stdout does not auto-promote workspace-root generated artifacts", async () => {
  const workspace = join(tempDir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });

  const result = await executor({
    name: "run_command",
    args: {
      command: [
        "mkdir -p artifacts/generated/leak",
        "printf 'city,population\\nSeoul,9300000\\n' > artifacts/generated/leak/report.csv",
        "python3 -c 'import json; print(json.dumps({\"report_path\":\"artifacts/generated/leak/report.csv\"}))'",
      ].join("; "),
      output_mode: "full",
    },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    durable_artifact_created?: boolean;
    artifact_label?: string;
    verified_output_files?: Array<{ path: string; artifact_kind: string }>;
    evidence_receipts: Array<Record<string, any>>;
  };

  expect(result.ok).toBe(true);
  expect(existsSync(join(workspace, "artifacts", "generated", "leak", "report.csv"))).toBe(true);
  expect(existsSync(join(tempDir, "artifacts", "generated", "leak", "report.csv"))).toBe(false);
  expect(result.durable_artifact_created).toBeUndefined();
  expect(result.artifact_label).toBeUndefined();
  expect(result.verified_output_files).toBeUndefined();
  expect(result.evidence_receipts).toEqual([
    expect.objectContaining({
      receiptType: "execution",
      verified: true,
      satisfies: ["command_executed"],
    }),
  ]);
});

test("run_command verifies declared output paths as durable artifact evidence", async () => {
  const workspace = join(tempDir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });

  const result = await executor({
    name: "run_command",
    args: {
      command: "mkdir -p reports && printf 'city,population\\nSeoul,9300000\\nBusan,3300000\\n' > reports/population.csv",
      output_paths: ["reports/population.csv"],
    },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    durable_artifact_created?: boolean;
    data_table_created?: boolean;
    artifact_labels?: string[];
    verified_output_files?: Array<{ path: string; artifact_kind: string }>;
  };

  expect(result.ok).toBe(true);
  expect(result.durable_artifact_created).toBe(true);
  expect(result.data_table_created).toBe(true);
  expect(result.artifact_labels).toContain("reports/population.csv");
  expect(result.verified_output_files).toContainEqual(expect.objectContaining({
    path: "reports/population.csv",
    artifact_kind: "csv_file",
  }));
});

test("run_command stores generated artifacts under Butler data", async () => {
  const workspace = join(tempDir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });

  const result = await executor({
    name: "run_command",
    args: {
      command:
        "mkdir -p \"$BUTLER_ARTIFACTS_DIR/cyrene\"; printf 'name,count\\ncyrene,1\\n' > \"$BUTLER_ARTIFACTS_DIR/cyrene/report.csv\"",
    },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    durable_artifact_created?: boolean;
    data_table_created?: boolean;
    artifact_label?: string;
    verified_output_files?: Array<{ path: string; artifact_kind: string }>;
  };

  const dataArtifactPath = join(tempDir, "artifacts", "generated", "cyrene", "report.csv");
  expect(result.ok).toBe(true);
  expect(result.durable_artifact_created).toBe(true);
  expect(result.data_table_created).toBe(true);
  expect(result.artifact_label).toBe("artifacts/generated/cyrene/report.csv");
  expect(result.verified_output_files).toContainEqual(expect.objectContaining({
    path: "artifacts/generated/cyrene/report.csv",
    artifact_kind: "csv_file",
  }));
  expect(existsSync(dataArtifactPath)).toBe(true);
  expect(readFileSync(dataArtifactPath, "utf8")).toContain("cyrene,1");
  expect(existsSync(join(workspace, "artifacts"))).toBe(false);
});

test("run_command verifies structured stdout artifact paths under Butler data", async () => {
  const workspace = join(tempDir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });

  const result = await executor({
    name: "run_command",
    args: {
      command: [
        "out=\"$BUTLER_ARTIFACTS_DIR/issue-english-rewrite-verification.json\"",
        "printf '{\"ok\":true}\\n' > \"$out\"",
        "touch -t 202001010000 \"$out\"",
        "python3 -c 'import json, os; print(json.dumps({\"ok\": True, \"report_path\": os.environ[\"BUTLER_ARTIFACTS_DIR\"] + \"/issue-english-rewrite-verification.json\"}))'",
      ].join("; "),
      output_mode: "full",
    },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    durable_artifact_created?: boolean;
    artifact_label?: string;
    verified_output_files?: Array<{ path: string; artifact_kind: string }>;
    evidence_receipts: Array<Record<string, any>>;
  };

  expect(result.ok).toBe(true);
  expect(result.durable_artifact_created).toBe(true);
  expect(result.artifact_label).toBe("artifacts/generated/issue-english-rewrite-verification.json");
  expect(result.verified_output_files).toContainEqual(expect.objectContaining({
    path: "artifacts/generated/issue-english-rewrite-verification.json",
    artifact_kind: "file",
  }));
  expect(result.evidence_receipts).toEqual(expect.arrayContaining([
    expect.objectContaining({
      receiptType: "deliverable",
      verified: true,
      satisfies: ["durable_artifact"],
      artifacts: [expect.objectContaining({
        label: "artifacts/generated/issue-english-rewrite-verification.json",
        role: "file",
      })],
    }),
  ]));
});

test("default app suggestions do not advertise weather workflows", () => {
  const agentBriefing = readFileSync(
    join(root, "packages", "butler-agent", "src", "gateways", "app", "new-chat-briefing.ts"),
    "utf8",
  );
  const clientSuggestions = readFileSync(
    join(root, "packages", "butler-app", "client", "ui", "src", "components", "conversation", "emptyStateSuggestions.ts"),
    "utf8",
  );

  expect(agentBriefing).not.toMatch(/weather|날씨|forecast/iu);
  expect(clientSuggestions).not.toMatch(/weather|날씨|forecast/iu);
});

test("run_command rejects cwd outside the active workspace", async () => {
  const workspace = join(tempDir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });

  await expect(executor({
    name: "run_command",
    args: {
      command: "pwd",
      cwd: tmpdir(),
    },
    rawArguments: "{}",
  })).rejects.toThrow("run_command cwd must stay under the active session workspace");
});

test("run_command uses a sanitized environment instead of Butler process secrets", async () => {
  const workspace = join(tempDir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const previousSecret = process.env.BUTLER_SECRET_TOKEN;
  process.env.BUTLER_SECRET_TOKEN = "should-not-reach-command";
  try {
    const executor = createButlerToolExecutor({
      butlerHome: root,
      butlerData: tempDir,
      workspacePath: workspace,
    });

    const result = await executor({
      name: "run_command",
      args: {
        command: "env | grep BUTLER_SECRET_TOKEN || true",
      },
      rawArguments: "{}",
    }) as { ok: boolean; stdout: string };

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("");
  } finally {
    if (previousSecret === undefined) delete process.env.BUTLER_SECRET_TOKEN;
    else process.env.BUTLER_SECRET_TOKEN = previousSecret;
  }
});

test("run_command compacts large stdout into a focused tool-output artifact", async () => {
  const workspace = join(tempDir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });

  const result = await executor({
    name: "run_command",
    args: {
      command: "for i in $(seq 1 500); do echo \"row-$i,abcdefghijklmnopqrstuvwxyz\"; done",
      max_output_tokens: 120,
    },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    stdout: string;
    butler_tool_artifact?: {
      id: string;
      path: string;
      raw_tokens: number;
      compact_tokens: number;
    };
  };

  expect(result.ok).toBe(true);
  expect(result.stdout).toContain("Butler compacted");
  expect(result.butler_tool_artifact?.id).toMatch(/^cmd_/);
  expect(result.butler_tool_artifact?.raw_tokens).toBeGreaterThan(result.butler_tool_artifact?.compact_tokens ?? 0);
  expect(existsSync(result.butler_tool_artifact?.path ?? "")).toBe(true);
});

test("run_command with output_mode=full preserves all output", async () => {
  const workspace = join(tempDir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });

  const result = await executor({
    name: "run_command",
    args: {
      command: "echo 'test output' && echo 'error output' >&2",
      output_mode: "full",
    },
    rawArguments: "{}",
  }) as { ok: boolean; stdout: string; stderr: string; exit_code: number };

  expect(result.ok).toBe(true);
  expect(result.exit_code).toBe(0);
  expect(result.stdout).toContain("test output");
  expect(result.stderr).toContain("error output");
});

test("run_command with output_mode=silent_on_success suppresses successful output", async () => {
  const workspace = join(tempDir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });

  const result = await executor({
    name: "run_command",
    args: {
      command: "echo 'this should be suppressed' && echo 'error suppressed' >&2",
      output_mode: "silent_on_success",
    },
    rawArguments: "{}",
  }) as { ok: boolean; stdout: string; stderr: string; exit_code: number };

  expect(result.ok).toBe(true);
  expect(result.exit_code).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});

test("run_command with output_mode=silent_on_success shows bounded output on failure", async () => {
  const workspace = join(tempDir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });

  const result = await executor({
    name: "run_command",
    args: {
      command: "echo 'some output' && echo 'error message' >&2 && exit 1",
      output_mode: "silent_on_success",
    },
    rawArguments: "{}",
  }) as { ok: boolean; stdout: string; stderr: string; exit_code: number };

  expect(result.ok).toBe(false);
  expect(result.exit_code).toBe(1);
  expect(result.stdout).toContain("some output");
  expect(result.stderr).toContain("error message");
});

test("run_command with output_mode=auto suppresses validation command output on success", async () => {
  const workspace = join(tempDir, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "test.spec.ts"), "import { test, expect } from 'bun:test'; test('pass', () => { expect(true).toBe(true); });", "utf8");
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });

  const result = await executor({
    name: "run_command",
    args: {
      command: "bun test test.spec.ts",
      output_mode: "auto",
    },
    rawArguments: "{}",
  }) as { ok: boolean; stdout: string; stderr: string; exit_code: number };

  expect(result.ok).toBe(true);
  expect(result.exit_code).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});

test("run_command defaults output_mode to auto for validation command success", async () => {
  const workspace = join(tempDir, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "test.spec.ts"), "import { test, expect } from 'bun:test'; test('pass', () => { expect(true).toBe(true); });", "utf8");
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });

  const result = await executor({
    name: "run_command",
    args: {
      command: "bun test test.spec.ts",
    },
    rawArguments: "{}",
  }) as { ok: boolean; stdout: string; stderr: string; exit_code: number };

  expect(result.ok).toBe(true);
  expect(result.exit_code).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});

test("run_command auto recognizes bun run --silent validation scripts", async () => {
  const workspace = join(tempDir, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "package.json"), JSON.stringify({
    scripts: {
      check: "echo noisy check output",
    },
  }), "utf8");
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });

  const result = await executor({
    name: "run_command",
    args: {
      command: "bun run --silent check",
    },
    rawArguments: "{}",
  }) as { ok: boolean; stdout: string; stderr: string; exit_code: number };

  expect(result.ok).toBe(true);
  expect(result.exit_code).toBe(0);
  expect(result.stdout).toBe("");
});

test("run_command with output_mode=auto preserves non-validation command output", async () => {
  const workspace = join(tempDir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });

  const result = await executor({
    name: "run_command",
    args: {
      command: "echo 'regular command output'",
      output_mode: "auto",
    },
    rawArguments: "{}",
  }) as { ok: boolean; stdout: string; stderr: string; exit_code: number };

  expect(result.ok).toBe(true);
  expect(result.exit_code).toBe(0);
  expect(result.stdout).toContain("regular command output");
});

test("run_command with output_mode=auto shows bounded output for failed validation commands", async () => {
  const workspace = join(tempDir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });

  const longOutput = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
  const result = await executor({
    name: "run_command",
    args: {
      command: `printf '${longOutput}' && exit 1`,
      output_mode: "auto",
    },
    rawArguments: "{}",
  }) as { ok: boolean; stdout: string; stderr: string; exit_code: number };

  expect(result.ok).toBe(false);
  expect(result.exit_code).toBe(1);
  expect(result.stdout).toContain("...[output truncated]");
  expect(result.stdout).toContain("line 30");
  expect(result.stdout.split("\n").length).toBeLessThan(30);
});

test("public data transform tool description stays capability-only", () => {
  const tool = BUTLER_TOOLS.find((item) => item.name === "transform_public_data_table");

  expect(tool?.description).toContain("CSV artifact");
  expect(tool?.description).not.toMatch(/\buse this\b/iu);
  expect(tool?.description).not.toMatch(/after collecting|before writing|when .*csv|when .*table/iu);
});

test("work dashboard tool schemas expose status and control contracts", () => {
  const dashboard = BUTLER_TOOLS.find((item) => item.name === "get_work_dashboard");
  const control = BUTLER_TOOLS.find((item) => item.name === "control_work");

  expect(dashboard?.parameters.required).toEqual([]);
  expect(Object.keys(dashboard?.parameters.properties ?? {})).toEqual(["debug", "limit"]);
  expect(control?.parameters.required).toEqual(["action"]);
  expect(Object.keys(control?.parameters.properties ?? {})).toEqual(["action", "task_id", "notification_id"]);
});

test("Project Ledger tool schemas expose bounded project management wrappers", () => {
  const status = BUTLER_TOOLS.find((item) => item.name === "inspect_project_status");
  const query = BUTLER_TOOLS.find((item) => item.name === "query_project_work");
  const render = BUTLER_TOOLS.find((item) => item.name === "render_project_dashboard");
  const complete = BUTLER_TOOLS.find((item) => item.name === "complete_project_work");

  expect(status?.parameters.required).toEqual([]);
  expect(Object.keys(status?.parameters.properties ?? {})).toEqual(["project_path"]);
  expect(query?.parameters.required).toEqual(["kind"]);
  expect(Object.keys(query?.parameters.properties ?? {})).toEqual(["project_path", "kind"]);
  expect(render?.parameters.required).toEqual(["view"]);
  expect(Object.keys(render?.parameters.properties ?? {})).toEqual(["project_path", "view", "write"]);
  expect(complete?.parameters.required).toEqual(["id", "validation", "review", "report"]);
  expect(Object.keys(complete?.parameters.properties ?? {})).toEqual([
    "project_path",
    "id",
    "validation",
    "review",
    "report",
  ]);
});

test("context monitor tool schema exposes safe session lookup", () => {
  const tool = BUTLER_TOOLS.find((item) => item.name === "get_context_monitor");

  expect(tool?.parameters.required).toEqual([]);
  expect(Object.keys(tool?.parameters.properties ?? {})).toEqual(["session_id"]);
});

test("conversation context tool schema exposes bounded transcript lookup controls", () => {
  const tool = BUTLER_TOOLS.find((item) => item.name === "read_conversation_context");

  expect(tool?.parameters.required).toEqual([]);
  expect(Object.keys(tool?.parameters.properties ?? {})).toEqual([
    "query",
    "anchor_event_id",
    "direction",
    "limit",
    "max_chars",
  ]);
});

test("tool output artifact reader schema exposes focused recovery controls", () => {
  const tool = BUTLER_TOOLS.find((item) => item.name === "read_tool_output_artifact");

  expect(tool?.parameters.required).toEqual([]);
  expect(Object.keys(tool?.parameters.properties ?? {})).toEqual([
    "artifact_id",
    "path",
    "stream",
    "offset_lines",
    "limit_lines",
    "max_tokens",
  ]);
});

test("usage monitor tool schema exposes safe usage lookup", () => {
  const tool = BUTLER_TOOLS.find((item) => item.name === "get_usage_monitor");

  expect(tool?.parameters.required).toEqual([]);
  expect(Object.keys(tool?.parameters.properties ?? {})).toEqual(["session_id", "since_hours"]);
});

test("tool capability schema exposes discovery without deterministic selection", () => {
  const list = BUTLER_TOOLS.find((item) => item.name === "list_tool_capabilities");

  expect(list?.parameters.required).toEqual([]);
  expect(Object.keys(list?.parameters.properties ?? {})).toEqual(["category", "include_disabled"]);
  expect(BUTLER_TOOLS.find((item) => item.name === "select_tool_capability")).toBeUndefined();
});

test("tool_search schema exposes compact model-selected catalog search", () => {
  const search = BUTLER_TOOLS.find((item) => item.name === "tool_search");

  expect(search?.parameters.required).toEqual([]);
  expect(Object.keys(search?.parameters.properties ?? {})).toEqual([
    "query",
    "capability",
    "category",
    "provider",
    "include_disabled",
    "limit",
  ]);
});

test("tool_describe schema exposes explicit catalog id description", () => {
  const describe = BUTLER_TOOLS.find((item) => item.name === "tool_describe");

  expect(describe?.parameters.required).toEqual(["ids"]);
  expect(Object.keys(describe?.parameters.properties ?? {})).toEqual(["ids"]);
});

test("tool_call schema exposes guarded catalog invocation", () => {
  const call = BUTLER_TOOLS.find((item) => item.name === "tool_call");

  expect(call?.parameters.required).toEqual(["id", "arguments"]);
  expect(Object.keys(call?.parameters.properties ?? {})).toEqual(["id", "arguments"]);
});

test("tool capability discovery exposes run_command as enabled command capability", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: tempDir,
    currentToolNames: ["list_tool_capabilities", "inspect_project_status"],
  });

  const result = await execute({
    name: "list_tool_capabilities",
    args: { category: "command" },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    current_turn_surface_known: boolean;
    capabilities: Array<{
      name: string;
      category: string;
      enabled: boolean;
      current_turn_selected: boolean | null;
      current_turn_callable: boolean | null;
      omitted_by_profile: boolean | null;
      availability_scope: string;
    }>;
  };

  expect(result.ok).toBe(true);
  expect(result.current_turn_surface_known).toBe(true);
  expect(result.capabilities).toContainEqual(expect.objectContaining({
    name: "run_command",
    category: "command",
    enabled: true,
    current_turn_selected: false,
    current_turn_callable: false,
    omitted_by_profile: true,
    availability_scope: "registry",
  }));
});

test("tool capability discovery marks tools callable when the current profile exposes them", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: tempDir,
    currentToolNames: ["list_tool_capabilities", "run_command", "read_tool_output_artifact"],
  });

  const result = await execute({
    name: "list_tool_capabilities",
    args: { category: "command" },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    capabilities: Array<{
      name: string;
      current_turn_selected: boolean | null;
      current_turn_callable: boolean | null;
      omitted_by_profile: boolean | null;
      availability_scope: string;
    }>;
  };

  expect(result.ok).toBe(true);
  expect(result.capabilities).toContainEqual(expect.objectContaining({
    name: "run_command",
    current_turn_selected: true,
    current_turn_callable: true,
    omitted_by_profile: false,
    availability_scope: "current_turn",
  }));
});

test("tool capability discovery does not mark disabled selected tools callable", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: tempDir,
    webSearchProvider: new DisabledWebSearchProvider("disabled for test"),
    currentToolNames: ["list_tool_capabilities", "web_search"],
  });

  const result = await execute({
    name: "list_tool_capabilities",
    args: { category: "search" },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    capabilities: Array<{
      name: string;
      enabled: boolean;
      disabled_reason: string | null;
      current_turn_selected: boolean | null;
      current_turn_callable: boolean | null;
      omitted_by_profile: boolean | null;
      availability_scope: string;
    }>;
  };

  expect(result.ok).toBe(true);
  expect(result.capabilities).toContainEqual(expect.objectContaining({
    name: "web_search",
    enabled: false,
    disabled_reason: "web search provider is disabled by configuration",
    current_turn_selected: true,
    current_turn_callable: false,
    omitted_by_profile: false,
    availability_scope: "registry",
  }));
});

test("tool capability discovery rejects unknown categories instead of widening to the full registry", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: tempDir,
  });

  const result = await execute({
    name: "list_tool_capabilities",
    args: { category: "github" },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    error: { code: string };
    invalid_category: string;
    valid_categories: string[];
    capabilities: unknown[];
  };

  expect(result.ok).toBe(false);
  expect(result.error.code).toBe("invalid_tool_category");
  expect(result.invalid_category).toBe("github");
  expect(result.valid_categories).toContain("command");
  expect(result.capabilities).toEqual([]);
});

test("automation tool schemas expose native schedule contracts", () => {
  const create = BUTLER_TOOLS.find((item) => item.name === "create_automation");
  const list = BUTLER_TOOLS.find((item) => item.name === "list_automations");
  const remove = BUTLER_TOOLS.find((item) => item.name === "delete_automation");
  const runDue = BUTLER_TOOLS.find((item) => item.name === "run_due_automations");

  expect(create?.parameters.required).toEqual(["prompt", "schedule_type"]);
  expect(Object.keys(create?.parameters.properties ?? {})).toEqual([
    "id",
    "title",
    "prompt",
    "session_id",
    "schedule_type",
    "run_at",
    "interval_minutes",
    "start_at",
  ]);
  expect(list?.parameters.required).toEqual([]);
  expect(Object.keys(list?.parameters.properties ?? {})).toEqual(["include_deleted"]);
  expect(remove?.parameters.required).toEqual(["id"]);
  expect(runDue?.parameters.required).toEqual([]);
  expect(Object.keys(runDue?.parameters.properties ?? {})).toEqual(["now"]);
});

test("todo list tool schemas expose checklist contracts", () => {
  const update = BUTLER_TOOLS.find((item) => item.name === "update_todo_list");
  const list = BUTLER_TOOLS.find((item) => item.name === "list_todo_list");

  expect(update?.parameters.required).toEqual(["todos"]);
  expect(Object.keys(update?.parameters.properties ?? {})).toEqual(["list_id", "title", "todos"]);
  expect(list?.parameters.required).toEqual([]);
  expect(Object.keys(list?.parameters.properties ?? {})).toEqual(["list_id", "include_completed"]);
});

test("memory quality tool schemas expose health ingestion recall and explicit updates", () => {
  expect(BUTLER_TOOLS.find((item) => item.name === "get_memory_health")?.parameters.required).toEqual([]);
  expect(BUTLER_TOOLS.find((item) => item.name === "ingest_task_memory")?.parameters.required).toEqual(["task_id"]);
  expect(BUTLER_TOOLS.find((item) => item.name === "recall_memory")?.parameters.required).toEqual(["cue"]);
  expect(BUTLER_TOOLS.find((item) => item.name === "query_memory")?.parameters.required).toEqual([]);
  expect(BUTLER_TOOLS.find((item) => item.name === "recall_memory")?.description).toContain(
    "associative context",
  );
  expect(Object.keys(BUTLER_TOOLS.find((item) => item.name === "recall_memory")?.parameters.properties ?? {})).toEqual([
    "cue",
    "limit",
    "include_vector",
    "vector_queries",
    "generated_queries",
    "strategies",
    "evidence_required",
  ]);
  expect(BUTLER_TOOLS.find((item) => item.name === "query_memory")?.description).toContain(
    "exact memory/history evidence",
  );
  expect(BUTLER_TOOLS.find((item) => item.name === "query_memory")?.description).toContain(
    "exact transcript evidence is needed",
  );
  expect(Object.keys(BUTLER_TOOLS.find((item) => item.name === "query_memory")?.parameters.properties ?? {})).toEqual([
    "query",
    "scope",
    "session_id",
    "speaker",
    "event_kind",
    "order",
    "match_mode",
    "limit",
    "date_from",
    "date_to",
    "include_internal",
    "include_placeholders",
  ]);
  expect(BUTLER_TOOLS.find((item) => item.name === "update_explicit_memory")?.parameters.required).toEqual([
    "kind",
    "text",
    "source",
  ]);
  const updateExplicitMemory = BUTLER_TOOLS.find((item) => item.name === "update_explicit_memory");
  const updateParameters = updateExplicitMemory?.parameters as { properties: Record<string, unknown> };
  const kindProperty = updateParameters.properties.kind as { enum?: string[] };
  expect(kindProperty.enum).toEqual(["rule"]);
});

test("skill tools expose catalog discovery contract", () => {
  expect(BUTLER_TOOLS.find((item) => item.name === "list_skills")?.parameters.required).toEqual([]);
  expect(BUTLER_TOOLS.find((item) => item.name === "select_skill")).toBeUndefined();
});

test("work orchestration tool schemas expose role-aware stream contracts", () => {
  const create = BUTLER_TOOLS.find((item) => item.name === "create_work_orchestration");
  const runReady = BUTLER_TOOLS.find((item) => item.name === "run_ready_work_streams");
  const sync = BUTLER_TOOLS.find((item) => item.name === "sync_work_orchestration");
  const report = BUTLER_TOOLS.find((item) => item.name === "write_work_orchestration_report");
  const createParameters = create?.parameters as {
    required?: string[];
    properties?: Record<string, unknown>;
  } | undefined;

  expect(createParameters?.required).toEqual(["goal", "streams"]);
  expect(Object.keys(createParameters?.properties ?? {})).toEqual(["id", "title", "goal", "streams"]);
  const streams = createParameters?.properties?.streams as
    | { items?: { properties?: Record<string, unknown> } }
    | undefined;
  const streamKind = streams?.items?.properties?.kind as { enum?: string[] } | undefined;
  expect(streamKind?.enum).toEqual([
    "implementation",
    "setup",
    "planning",
    "investigation",
    "review",
  ]);
  expect(runReady?.parameters.required).toEqual(["orchestration_id"]);
  expect(Object.keys(runReady?.parameters.properties ?? {})).toEqual(["orchestration_id", "max_streams"]);
  expect(sync?.parameters.required).toEqual(["orchestration_id"]);
  expect(report?.parameters.required).toEqual(["orchestration_id", "report"]);
});

test("create_planned_task schema exposes autonomous planning fields", () => {
  const tool = BUTLER_TOOLS.find((item) => item.name === "create_planned_task");

  expect(tool?.parameters.required).toEqual(["goal", "acceptance_criteria"]);
  expect(Object.keys(tool?.parameters.properties ?? {})).toEqual([
    "goal",
    "internal_goal",
    "project_path",
    "acceptance_criteria",
    "verification_commands",
    "risk_notes",
    "repair_policy",
    "public_report_policy",
  ]);
});

test("run_planned_task schema requires a planned task id", () => {
  const tool = BUTLER_TOOLS.find((item) => item.name === "run_planned_task");

  expect(tool?.parameters.required).toEqual(["task_id"]);
  expect(Object.keys(tool?.parameters.properties ?? {})).toEqual(["task_id"]);
});

test("review_planned_task schema requires task id and criterion evidence", () => {
  const tool = BUTLER_TOOLS.find((item) => item.name === "review_planned_task");

  expect(tool?.parameters.required).toEqual(["task_id", "criteria"]);
  expect(Object.keys(tool?.parameters.properties ?? {})).toEqual([
    "task_id",
    "attempt",
    "worker_task_id",
    "review_event_id",
    "criteria",
    "goal_review",
    "missing_evidence",
    "repair_recommendation",
  ]);
});

test("repair_planned_task schema requires a planned task id", () => {
  const tool = BUTLER_TOOLS.find((item) => item.name === "repair_planned_task");

  expect(tool?.parameters.required).toEqual(["task_id"]);
  expect(Object.keys(tool?.parameters.properties ?? {})).toEqual([
    "task_id",
    "repair_objective",
    "attempt",
    "worker_task_id",
    "review_event_id",
  ]);
});

test("request_principal_decision schema requires recommendation and options", () => {
  const tool = BUTLER_TOOLS.find((item) => item.name === "request_principal_decision");

  expect(tool?.parameters.required).toEqual(["task_id", "situation", "recommended_option_id", "options"]);
  expect(Object.keys(tool?.parameters.properties ?? {})).toEqual([
    "task_id",
    "situation",
    "recommended_option_id",
    "options",
    "tradeoffs",
    "expires_at",
  ]);
});

test("write_planned_public_report schema requires user-facing report content", () => {
  const tool = BUTLER_TOOLS.find((item) => item.name === "write_planned_public_report");

  expect(tool?.parameters.required).toEqual(["task_id", "report"]);
});

test("create_planned_task creates a durable plan without starting a worker", async () => {
  let dispatches = 0;
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    sessionId: "butler/app-project-butler",
    projectId: "butler",
    dispatchTask: () => {
      dispatches += 1;
      throw new Error("planned creation must not dispatch");
    },
  });

  const result = await execute({
    name: "create_planned_task",
    args: {
      goal: "프로젝트 구조를 조사하고 개선안을 정리한다",
      project_path: "fixtures/butler-project",
      acceptance_criteria: [
        "현재 구조의 핵심 진입점을 식별한다",
        "개선안을 검증 가능한 항목으로 정리한다",
      ],
      verification_commands: ["bun run typecheck"],
      risk_notes: ["코드 변경 없이 조사만 수행한다"],
      repair_policy: {
        max_attempts: 2,
        allow_autonomous_repair: true,
      },
      public_report_policy: "핵심 결과와 다음 조치만 간결히 보고한다",
    },
    rawArguments: "{}",
  }) as {
    task_id: string;
    status: string;
    public_plan_summary: Record<string, unknown>;
  };

  expect(dispatches).toBe(0);
  expect(result).toMatchObject({
    ok: true,
    status: "PLANNED",
    public_plan_summary: {
      goal: "프로젝트 구조를 조사하고 개선안을 정리한다",
      project: "fixtures/butler-project",
      acceptance_criteria_count: 2,
      verification_commands: ["bun run typecheck"],
    },
  });
  expect(String(result.task_id)).toStartWith("planned-");

  const stored = await execute({
    name: "list_tasks",
    args: { limit: 5 },
    rawArguments: "{\"limit\":5}",
  }) as { tasks: unknown[] };
  expect(stored.tasks).toEqual([
    expect.objectContaining({
      task_type: "planned",
      planned_status: "PLANNED",
      origin_session_id: "butler/app-project-butler",
      origin_project: "butler",
      planned_goal: "프로젝트 구조를 조사하고 개선안을 정리한다",
      public_report_ready: false,
    }),
  ]);
});

test("create_planned_task stores a compact source context snapshot", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    sessionId: "butler/app-project-butler",
    projectId: "butler",
    turnContext: [
      "Live Configuration Hash: abc123",
      "",
      "---",
      "",
      "## Active Persona Reminder",
      "persona text that should not be copied into planned task source context",
      "",
      "---",
      "",
      "## Runtime State",
      "Session ID: butler/app-project-butler",
      "Project ID: butler",
      "",
      "---",
      "",
      "## Hot Cache",
      "older retrieved memories should stay out of the planned source context",
      "",
      "---",
      "",
      "## Current User Input",
      "Message Text: 이 프로젝트 안정성을 확인해줘.",
    ].join("\n"),
    dispatchTask: () => {
      throw new Error("planned creation must not dispatch");
    },
  });

  const result = await execute({
    name: "create_planned_task",
    args: {
      goal: "컨텍스트 소스 스냅샷을 작게 저장한다",
      acceptance_criteria: ["source context is compact"],
    },
    rawArguments: "{}",
  }) as { task_id: string };

  const record = new PlannedTaskStore(tempDir).read(result.task_id);
  expect(record?.plan.source_context).toContain("Live Configuration Hash: abc123");
  expect(record?.plan.source_context).toContain("## Runtime State");
  expect(record?.plan.source_context).toContain("## Current User Input");
  expect(record?.plan.source_context).not.toContain("persona text");
  expect(record?.plan.source_context).not.toContain("older retrieved memories");
});

test("create_planned_task rejects empty acceptance criteria", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    sessionId: "butler/app-project-butler",
    projectId: "butler",
  });

  await expect(execute({
    name: "create_planned_task",
    args: {
      goal: "검증 불가능한 계획",
      acceptance_criteria: ["  "],
    },
    rawArguments: "{}",
  })).rejects.toThrow("planned task requires non-empty acceptance criteria");
});

test("dispatch_worker remains a direct background dispatch", async () => {
  const dispatched: Array<{
    task: string;
    projectPath: string;
    model?: string;
    reasoningEffort?: string;
  }> = [];
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    workerModelRules: [
      {
        id: "deep_work",
        label: "Deep work",
        condition: "Research and analysis",
        model: "openai/gpt-5.5",
        reasoning_effort: "high",
        enabled: true,
      },
      {
        id: "routine_work",
        label: "Routine work",
        condition: "Simple inspection",
        model: "openai/gpt-5.4-mini",
        reasoning_effort: "medium",
        enabled: true,
      },
    ],
    dispatchTask: (input) => {
      dispatched.push({
        task: input.task,
        projectPath: input.projectPath,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
      });
      return {
        task_id: "task-direct",
        status: "RUNNING",
        message: "stubbed",
      };
    },
  });

  expect(await execute({
    name: "dispatch_worker",
    args: {
      task: "간단한 로그만 확인한다",
      project_path: "/tmp/project",
    },
    rawArguments: "{}",
  })).toMatchObject({
    ok: true,
    task_id: "task-direct",
    status: "RUNNING",
  });
  expect(dispatched).toEqual([{
    task: "간단한 로그만 확인한다",
    projectPath: "/tmp/project",
    model: "openai/gpt-5.4-mini",
    reasoningEffort: "medium",
  }]);
});

test("dispatch_worker inherits the active session model before worker rules", async () => {
  const dispatched: Array<{
    model?: string;
    reasoningEffort?: string;
  }> = [];
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    workerModel: "openai/gpt-5.5",
    workerModelRules: [
      {
        id: "routine_work",
        label: "Routine work",
        condition: "Simple inspection",
        model: "local/gemma-4-31B-it",
        reasoning_effort: "medium",
        enabled: true,
      },
    ],
    dispatchTask: (input) => {
      dispatched.push({
        model: input.model,
        reasoningEffort: input.reasoningEffort,
      });
      return {
        task_id: "task-direct",
        status: "RUNNING",
        message: "stubbed",
      };
    },
  });

  await execute({
    name: "dispatch_worker",
    args: {
      task: "문서를 짧게 보강한다",
      project_path: "/tmp/project",
    },
    rawArguments: "{}",
  });

  expect(dispatched).toEqual([{
    model: "openai/gpt-5.5",
    reasoningEffort: undefined,
  }]);
});

test("dispatch_worker launches with sanitized environment plus Butler task vars", async () => {
  const fakeHome = join(tempDir, "fake-butler-home");
  const scriptDir = join(fakeHome, "packages", "butler-agent", "scripts");
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(join(scriptDir, "dispatch.sh"), [
    "#!/usr/bin/env bash",
    "env > \"$BUTLER_DATA/worker-env.txt\"",
  ].join("\n"), "utf8");
  const previousSecret = process.env.BUTLER_SECRET_TOKEN;
  process.env.BUTLER_SECRET_TOKEN = "should-not-reach-worker";
  try {
    const execute = createButlerToolExecutor({
      butlerHome: fakeHome,
      butlerData: tempDir,
    });

    const result = await execute({
      name: "dispatch_worker",
      args: {
        task: "record environment",
        project_path: tempDir,
      },
      rawArguments: "{}",
    }) as { ok: boolean; task_id: string };

    expect(result.ok).toBe(true);
    for (let index = 0; index < 50; index += 1) {
      if (
        existsSync(join(tempDir, "worker-env.txt")) &&
        readFileSync(join(tempDir, "worker-env.txt"), "utf8").includes(`BUTLER_HOME=${fakeHome}`)
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const envText = readFileSync(join(tempDir, "worker-env.txt"), "utf8");
    expect(envText).toContain(`BUTLER_HOME=${fakeHome}`);
    expect(envText).toContain(`BUTLER_DATA=${tempDir}`);
    expect(envText).toContain(`TASK_ID_OVERRIDE=${result.task_id}`);
    expect(envText).not.toContain("BUTLER_SECRET_TOKEN");
    expect(envText).not.toContain("should-not-reach-worker");
  } finally {
    if (previousSecret === undefined) delete process.env.BUTLER_SECRET_TOKEN;
    else process.env.BUTLER_SECRET_TOKEN = previousSecret;
  }
});

test("dispatch_worker refuses to report success when the dispatch script is missing", async () => {
  const fakeHome = join(tempDir, "fake-butler-home");
  const execute = createButlerToolExecutor({
    butlerHome: fakeHome,
    butlerData: tempDir,
  });

  await expect(execute({
    name: "dispatch_worker",
    args: {
      task: "record environment",
      project_path: tempDir,
    },
    rawArguments: "{}",
  })).rejects.toThrow("worker dispatch script not found");
});

test("web_search returns normalized source-bearing results and telemetry", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    webSearchProvider: new MockWebSearchProvider([{
      title: "OpenAI Docs",
      url: "https://platform.openai.com/docs",
      snippet: "Official OpenAI platform documentation.",
      source: "platform.openai.com",
      published_at: "2026-04-26",
    }]),
  });

  const result = await execute({
    name: "web_search",
    args: {
      query: "latest OpenAI docs",
      allowed_domains: ["platform.openai.com"],
      max_results: 3,
    },
    rawArguments: "{}",
  }) as Record<string, any>;

  expect(result).toMatchObject({
    ok: true,
    query: "latest OpenAI docs",
    provider: "mock",
    citation_required: true,
    source_urls: ["https://platform.openai.com/docs"],
    coverage_budget: {
      mode: "coverage_based",
      result_count: 1,
      stop_reason: "provider_results_exhausted",
    },
  });
  expect(result.coverage_budget.next_search_guidance).toContain("specific missing outcome");
  expect(result.evidence_receipts).toEqual([
    expect.objectContaining({
      schema: "butler.evidence-receipt.v1",
      producer: { kind: "tool", name: "web_search" },
      receiptType: "coverage",
      verified: true,
      covers: ["source_candidates"],
      references: [{ kind: "url", ref: "https://platform.openai.com/docs" }],
      metrics: {
        result_count: 1,
        search_requests: 1,
      },
    }),
  ]);
  expect(result.results).toEqual([{
    title: "OpenAI Docs",
    url: "https://platform.openai.com/docs",
    snippet: "Official OpenAI platform documentation.",
    source: "platform.openai.com",
    published_at: "2026-04-26",
  }]);
  expect(readWebSearchMetrics(tempDir)).toMatchObject({
    requestCount: 1,
    lastProvider: "mock",
    lastQuery: "latest OpenAI docs",
    lastError: null,
  });
});

test("web_search uses smart planner queries and returns the compact search plan", async () => {
  const searchedQueries: string[] = [];
  let plannerInput: Record<string, any> | undefined;
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    searchPlannerModel: "openai/gpt-5.5",
    searchPlannerOriginalRequest: "오늘 게임이랑 AI 쪽에서 중요한 뉴스 근거 포함해서 정리해줘",
    turnContext: "Live Configuration Hash: 2111fdc87398035d\n\n## Inbound Message\nMessage Text: 오늘 게임이랑 AI 쪽에서 중요한 뉴스 근거 포함해서 정리해줘",
    webSearchProvider: {
      id: "tracking",
      async search(input: any) {
        searchedQueries.push(input.query);
        return {
          query: input.query,
          results: [{
            title: `Result for ${input.query}`,
            url: `https://example.com/${searchedQueries.length}`,
            snippet: "planned search result",
            source: "example.com",
          }],
          duration_ms: 1,
          provider: "tracking",
          usage: {
            search_requests: 1,
          },
        };
      },
    },
    searchPlanner: async (input) => {
      plannerInput = input as unknown as Record<string, any>;
      return {
        usedPlanner: true,
        attempts: 1,
        plan: {
          mode: "smart",
          depth: "deep",
          originalRequest: "오늘 게임이랑 AI 쪽에서 중요한 뉴스 근거 포함해서 정리해줘",
          intent: "current multi-domain briefing with evidence",
          scope: "multi_domain",
          decomposition: [{
            id: "ai",
            label: "AI",
            reason: "Separate AI sources",
            priority: "high",
          }, {
            id: "gaming",
            label: "Gaming",
            reason: "Separate gaming sources",
            priority: "normal",
          }],
          queries: [{
            bucketId: "ai",
            query: "today AI industry news sources",
            purpose: "validation",
            priority: "high",
            expectedSourceType: "news",
          }, {
            bucketId: "gaming",
            query: "today gaming industry news sources",
            purpose: "validation",
            priority: "normal",
            expectedSourceType: "news",
          }],
          parallelizable: true,
          verificationRequired: true,
        },
      };
      },
  });

  const result = await execute({
    name: "web_search",
    args: {
      query: "2026년 5월 21일 게임 AI 주요 뉴스",
      max_results: 5,
    },
    rawArguments: "{}",
  }) as Record<string, any>;

  expect(searchedQueries).toEqual([
    "today AI industry news sources",
    "today gaming industry news sources",
  ]);
  expect(plannerInput).toMatchObject({
    query: "2026년 5월 21일 게임 AI 주요 뉴스",
    originalRequest: "오늘 게임이랑 AI 쪽에서 중요한 뉴스 근거 포함해서 정리해줘",
    model: "openai/gpt-5.5",
  });
  expect(result.search_plan).toMatchObject({
    mode: "smart",
    depth: "deep",
    verification_required: true,
    planner_attempts: 1,
  });
  expect(result.usage.search_requests).toBe(2);
  expect(result.source_urls).toEqual([
    "https://example.com/1",
    "https://example.com/2",
  ]);
  expect(result.read_required).toBe(true);
  expect(result.recommended_read_urls).toEqual([
    "https://example.com/1",
    "https://example.com/2",
  ]);
  expect(readWebSearchMetrics(tempDir)).toMatchObject({
    requestCount: 1,
    lastProvider: "tracking",
    lastQuery: "2026년 5월 21일 게임 AI 주요 뉴스",
    lastError: null,
  });
});

test("web_search applies smart planning once per executor turn and leaves follow-up searches direct", async () => {
  const searchedQueries: string[] = [];
  let plannerCalls = 0;
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    searchPlannerOriginalRequest: "오늘 국내외 주요 이슈 알려줘",
    webSearchProvider: {
      id: "tracking",
      async search(input: any) {
        searchedQueries.push(input.query);
        return {
          query: input.query,
          results: [{
            title: `Result for ${input.query}`,
            url: `https://example.com/${searchedQueries.length}`,
            snippet: "search result",
            source: "example.com",
          }],
          duration_ms: 1,
          provider: "tracking",
          usage: {
            search_requests: 1,
          },
        };
      },
    },
    searchPlanner: async () => {
      plannerCalls += 1;
      return {
        usedPlanner: true,
        attempts: 1,
        plan: {
          mode: "smart",
          depth: "balanced",
          originalRequest: "오늘 국내외 주요 이슈 알려줘",
          intent: "briefing",
          scope: "multi_domain",
          decomposition: [],
          queries: [{
            query: "planned domestic international news",
            purpose: "curation",
            priority: "high",
            expectedSourceType: "news",
          }],
          parallelizable: true,
          verificationRequired: false,
        },
      };
    },
  });

  const first = await execute({
    name: "web_search",
    args: { query: "raw briefing", max_results: 3 },
    rawArguments: "{}",
  }) as Record<string, any>;
  const second = await execute({
    name: "web_search",
    args: { query: "follow-up source query", max_results: 3 },
    rawArguments: "{}",
  }) as Record<string, any>;

  expect(plannerCalls).toBe(1);
  expect(searchedQueries).toEqual([
    "planned domestic international news",
    "follow-up source query",
  ]);
  expect(first.search_plan.mode).toBe("smart");
  expect(second.search_plan).toMatchObject({
    mode: "direct",
    planner_used: false,
    fallback_reason: "smart search planning already ran in this turn; direct follow-up search used",
  });
});

test("web_search interleaves planned query results to preserve domain coverage", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    turnContext: "## Current User Input\n오늘 게임이랑 AI 쪽에서 중요한 뉴스 근거 포함해서 정리해줘",
    webSearchProvider: {
      id: "tracking",
      async search(input: any) {
        return {
          query: input.query,
          results: [1, 2, 3].map((index) => ({
            title: `${input.query} result ${index}`,
            url: `https://example.com/${input.query.replaceAll(" ", "-")}/${index}`,
            snippet: "planned search result",
            source: "example.com",
          })),
          duration_ms: 1,
          provider: "tracking",
          usage: {
            search_requests: 1,
          },
        };
      },
    },
    searchPlanner: async () => ({
      usedPlanner: true,
      attempts: 1,
      plan: {
        mode: "smart",
        depth: "deep",
        originalRequest: "오늘 게임이랑 AI 쪽에서 중요한 뉴스 근거 포함해서 정리해줘",
        intent: "current multi-domain briefing with evidence",
        scope: "multi_domain",
        decomposition: [{
          id: "gaming",
          label: "Gaming",
          reason: "Separate gaming sources",
          priority: "high",
        }, {
          id: "ai",
          label: "AI",
          reason: "Separate AI sources",
          priority: "high",
        }],
        queries: [{
          bucketId: "gaming",
          query: "gaming news",
          purpose: "validation",
          priority: "high",
          expectedSourceType: "news",
        }, {
          bucketId: "ai",
          query: "AI news",
          purpose: "validation",
          priority: "high",
          expectedSourceType: "news",
        }],
        parallelizable: true,
        verificationRequired: true,
      },
    }),
  });

  const result = await execute({
    name: "web_search",
    args: {
      query: "today gaming AI news",
      max_results: 4,
    },
    rawArguments: "{}",
  }) as Record<string, any>;

  expect(result.source_urls).toEqual([
    "https://example.com/gaming-news/1",
    "https://example.com/AI-news/1",
    "https://example.com/gaming-news/2",
    "https://example.com/AI-news/2",
  ]);
});

test("web_read returns bounded page evidence without full document dumps", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    pageReader: async () => ({
      reader: "butler-lightweight",
      requestedUrl: "https://example.com/story",
      finalUrl: "https://example.com/story",
      ok: true,
      status: 200,
      title: "Evidence Story",
      text: "Evidence body text ".repeat(200),
      markdown: `# Evidence Story\n\n${"Evidence body text ".repeat(200)}`,
      document: "FULL DOCUMENT SHOULD NOT BE RETURNED",
      chunks: [{
        id: "ev_test",
        index: 0,
        title: "Evidence Story",
        url: "https://example.com/story",
        text: "First chunk evidence",
        charCount: 20,
      }],
      method: "readability",
      durationMs: 12,
      warnings: [],
      renderRecommended: false,
    }),
  });

  const result = await execute({
    name: "web_read",
    args: {
      url: "https://example.com/story",
      max_chars: 80,
      max_chunks: 1,
    },
    rawArguments: "{}",
  }) as Record<string, any>;

  expect(result).toMatchObject({
    ok: true,
    source_url: "https://example.com/story",
    title: "Evidence Story",
    evidence_quality: "good",
    truncated: true,
  });
  expect(result.evidence_receipts).toEqual([
    expect.objectContaining({
      schema: "butler.evidence-receipt.v1",
      producer: { kind: "tool", name: "web_read" },
      receiptType: "source",
      verified: true,
      satisfies: ["source_verified"],
      references: [{ kind: "url", ref: "https://example.com/story" }],
    }),
  ]);
  expect(result.markdown.length).toBeLessThanOrEqual(520);
  expect(result.chunks).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain("FULL DOCUMENT SHOULD NOT BE RETURNED");
});

test("web_read reuses same-turn page evidence for duplicate URL reads", async () => {
  let readCount = 0;
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    pageReader: async () => {
      readCount += 1;
      return {
        reader: "butler-lightweight",
        requestedUrl: "https://example.com/story",
        finalUrl: "https://example.com/story",
        ok: true,
        status: 200,
        title: "Evidence Story",
        text: "Evidence body text ".repeat(80),
        markdown: `# Evidence Story\n\n${"Evidence body text ".repeat(80)}`,
        document: "document",
        chunks: [],
        method: "readability",
        durationMs: 12,
        warnings: [],
        renderRecommended: false,
      };
    },
  });

  const first = await execute({
    name: "web_read",
    args: { url: "https://example.com/story", max_chars: 600 },
    rawArguments: "{}",
  }) as Record<string, any>;
  const second = await execute({
    name: "web_read",
    args: { url: "https://example.com/story", max_chars: 600 },
    rawArguments: "{}",
  }) as Record<string, any>;

  expect(readCount).toBe(1);
  expect(first.cache_hit).toBe(false);
  expect(second.cache_hit).toBe(true);
  expect(second.title).toBe("Evidence Story");
});

test("web_read defaults to compact chunk previews instead of duplicate long chunks", async () => {
  const longChunk = "chunk evidence detail ".repeat(220);
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    pageReader: async () => ({
      reader: "butler-lightweight",
      requestedUrl: "https://example.com/compact",
      finalUrl: "https://example.com/compact",
      ok: true,
      status: 200,
      title: "Compact Evidence",
      text: "Evidence body text ".repeat(400),
      markdown: `# Compact Evidence\n\n${"Evidence body text ".repeat(400)}`,
      document: "document",
      chunks: [{
        id: "ev_compact",
        index: 0,
        title: "Compact Evidence",
        url: "https://example.com/compact",
        text: longChunk,
        charCount: longChunk.length,
      }],
      method: "readability",
      durationMs: 12,
      warnings: [],
      renderRecommended: false,
    }),
  });

  const result = await execute({
    name: "web_read",
    args: {
      url: "https://example.com/compact",
    },
    rawArguments: "{}",
  }) as Record<string, any>;

  expect(result.markdown.length).toBeLessThanOrEqual(2_020);
  expect(result.chunks).toHaveLength(1);
  expect(result.chunks[0].text.length).toBeLessThanOrEqual(360);
  expect(JSON.stringify(result).length).toBeLessThan(longChunk.length + result.markdown.length + 1_000);
});

test("web_search rejects invalid input and records provider failures", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    webSearchProvider: {
      id: "broken",
      async search() {
        throw new Error("search provider unavailable");
      },
    },
  });

  await expect(execute({
    name: "web_search",
    args: { query: "" },
    rawArguments: "{}",
  })).rejects.toThrow("web_search requires a query");

  await expect(execute({
    name: "web_search",
    args: {
      query: "conflicting filters",
      allowed_domains: ["example.com"],
      blocked_domains: ["example.org"],
    },
    rawArguments: "{}",
  })).rejects.toThrow("allowed_domains and blocked_domains");

  await expect(execute({
    name: "web_search",
    args: { query: "provider failure" },
    rawArguments: "{}",
  })).rejects.toThrow("search provider unavailable");
  expect(readWebSearchMetrics(tempDir)).toMatchObject({
    requestCount: 1,
    lastProvider: "broken",
    lastQuery: "provider failure",
    lastError: "search provider unavailable",
  });
});

test("work dashboard and control tools expose canonical task state", async () => {
  const taskDir = join(tempDir, "tasks", "task-dashboard-recoverable");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "RECOVERABLE\n", "utf8");
  writeFileSync(join(taskDir, "request.md"), "resume dashboard task\n", "utf8");
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    sessionId: "butler/app-project-butler",
    projectId: "butler",
  });

  const dashboard = await execute({
    name: "get_work_dashboard",
    args: { debug: false },
    rawArguments: "{\"debug\":false}",
  }) as Record<string, any>;

  expect(dashboard.ok).toBe(true);
  expect(dashboard.counts).toMatchObject({
    recoverable: 1,
  });
  expect(dashboard.recoverable[0].raw_id).toBeUndefined();
  expect(dashboard.recoverable[0].actions.find((action: any) => action.action === "resume").enabled).toBe(true);

  const control = await execute({
    name: "control_work",
    args: {
      action: "resume",
      task_id: "task-dashboard-recoverable",
    },
    rawArguments: "{}",
  }) as Record<string, any>;

  expect(control).toMatchObject({
    ok: true,
    action: "resume",
    intent: {
      action: "resume",
      task_id: "task-dashboard-recoverable",
    },
  });
});

test("Project Ledger tools wrap the portable CLI without Butler runtime coupling", async () => {
  const projectPath = join(tempDir, "ledger-project");
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(
    join(projectPath, "package.json"),
    JSON.stringify({ name: "ledger-demo", private: true }),
    "utf8",
  );
  runProjectLedger(["init", "--id", "ledger-demo", "--name", "Ledger Demo"], projectPath);
  runProjectLedger([
    "work",
    "create",
    "--id",
    "W-TOOL",
    "--title",
    "Tool wrapper work",
    "--spec",
    "docs/specs/project-ledger.md",
    "--acceptance",
    "Butler tool wrapper can inspect the project ledger",
  ], projectPath);
  runProjectLedger(["index"], projectPath);

  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
  });

  const status = await execute({
    name: "inspect_project_status",
    args: { project_path: projectPath },
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(status.ok).toBe(true);
  expect(status.data.counts.work).toBe(1);

  const query = await execute({
    name: "query_project_work",
    args: { project_path: projectPath, kind: "next-actions" },
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(query.ok).toBe(true);
  expect(query.data.results[0].id).toBe("W-TOOL");

  const rendered = await execute({
    name: "render_project_dashboard",
    args: { project_path: projectPath, view: "dashboard" },
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(rendered.ok).toBe(true);
  expect(rendered.data.markdown).toContain("Project Ledger Dashboard");

  const written = await execute({
    name: "render_project_dashboard",
    args: { project_path: projectPath, view: "dashboard", write: true },
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(written.ok).toBe(true);
  expect(written.durable_artifact_created).toBe(true);
  expect(written.artifact_kind).toBe("markdown_file");
  expect(written.artifact_label).toBe("project-ledger/projects/ledger-demo/views/dashboard.md");
  expect(written.verified_output_files).toContainEqual({
    path: "project-ledger/projects/ledger-demo/views/dashboard.md",
    artifact_kind: "markdown_file",
  });
});

test("Project Ledger tools prefer Butler data project roots over repo-local ledgers", async () => {
  const previousButlerData = process.env.BUTLER_DATA;
  try {
    process.env.BUTLER_DATA = tempDir;
    const workspace = join(tempDir, "workspace");
    const canonicalRoot = join(
      tempDir,
      "project-ledger",
      "projects",
      "ledger-demo",
    );
    mkdirSync(workspace, { recursive: true });
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({ name: "ledger-demo" }),
      "utf8",
    );

    runProjectLedger(["init", "--id", "ledger-demo", "--name", "Ledger Demo"], canonicalRoot);
    runProjectLedger([
      "work",
      "create",
      "--id",
      "W-CANONICAL",
      "--title",
      "Canonical Project Ledger work",
      "--spec",
      "project-ledger/projects/ledger-demo/specs/project-ledger.md",
      "--acceptance",
      "Butler tools read the data-home Project Ledger",
      "--status",
      "specified",
    ], workspace);
    runProjectLedger(["index"], workspace);

    const execute = createButlerToolExecutor({
      butlerHome: root,
      butlerData: tempDir,
    });

    const status = await execute({
      name: "inspect_project_status",
      args: { project_path: workspace },
      rawArguments: "{}",
    }) as Record<string, any>;
    expect(status.ok).toBe(true);
    expect(status.data.project.path).toBe(
      "project-ledger/projects/ledger-demo/project.json",
    );
    expect(status.data.nextActions[0].path).toBe(
      "project-ledger/projects/ledger-demo/work/W-CANONICAL/work.md",
    );
  } finally {
    if (previousButlerData === undefined) delete process.env.BUTLER_DATA;
    else process.env.BUTLER_DATA = previousButlerData;
  }
});

test("context monitor tool returns safe active-session pressure summary", async () => {
  appendRuntimeTurnContextMetric({
    butlerData: tempDir,
    sessionId: "butler/main",
    model: "openai/auto:codex-latest",
    totalPromptChars: 1600,
    promptContextChars: 100,
    recentConversationChars: 400,
    recallContextChars: 300,
    inboundMessageChars: 80,
  });
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    sessionId: "butler/main",
  });

  const result = await execute({
    name: "get_context_monitor",
    args: {},
    rawArguments: "{}",
  }) as Record<string, any>;

  expect(result).toMatchObject({
    ok: true,
    sessionId: "butler/main",
    latestTurn: {
      totalPromptChars: 1600,
      recallContextChars: 300,
      estimatedTokens: 400,
    },
    pressure: {
      level: "low",
    },
    privacy: {
      rawTextStored: false,
    },
  });
});

test("tool output artifact reader executes bounded Butler-owned slices", async () => {
  const artifact = budgetToolOutput({
    butlerData: tempDir,
    command: "produce output",
    maxModelTokens: 200,
    now: new Date("2026-04-27T00:00:00.000Z"),
    result: {
      stdout: Array.from({ length: 120 }, (_, index) => `stdout row ${index} ${"x".repeat(40)}`).join("\n"),
      stderr: Array.from({ length: 40 }, (_, index) => `stderr row ${index} ${"y".repeat(20)}`).join("\n"),
      exit_code: 0,
      timed_out: false,
    },
  }).butler_tool_artifact!;
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    sessionId: "butler/main",
  });

  const result = await execute({
    name: "read_tool_output_artifact",
    args: {
      artifact_id: artifact.id,
      stream: "stderr",
      offset_lines: 2,
      limit_lines: 3,
      max_tokens: 80,
    },
    rawArguments: "{}",
  }) as Record<string, any>;

  expect(result).toMatchObject({
    ok: true,
    rawTextStored: false,
    artifact: {
      id: artifact.id,
    },
    stderr: {
      start_line: 2,
      returned_lines: 3,
      total_lines: 40,
    },
  });
  expect(result.stderr.text).toContain("stderr row 2");
  expect(result.stderr.text).not.toContain("stderr row 1");
  expect(result.stdout).toBeUndefined();
});

test("usage monitor tool returns safe active-session usage summary", async () => {
  appendPromptCacheMetric({
    ts: Date.now(),
    model: "openai/auto:codex-latest",
    scope: "session-turn",
    promptTokens: 64,
    cachedTokens: 16,
    totalTokens: 96,
  }, { butlerData: tempDir });
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    sessionId: "butler/main",
  });

  const result = await execute({
    name: "get_usage_monitor",
    args: {},
    rawArguments: "{}",
  }) as Record<string, any>;

  expect(result).toMatchObject({
    ok: true,
    filters: {
      sessionId: "butler/main",
      sinceTs: null,
    },
    model: {
      requestCount: 1,
      promptTokens: 64,
      cachedTokens: 16,
      uncachedTokens: 48,
      outputTokens: 32,
      totalTokens: 96,
      byScopeUsage: {
        "session-turn": {
          requestCount: 1,
          promptTokens: 64,
          cachedTokens: 16,
          uncachedTokens: 48,
          outputTokens: 32,
          totalTokens: 96,
          missingTotalTokenCount: 0,
        },
      },
    },
    cost: {
      available: false,
      estimatedUsd: null,
    },
    privacy: {
      rawTextStored: false,
      rawToolArgumentsIncluded: false,
      rawToolResultsIncluded: false,
    },
  });
});

test("tool capability tools list disabled reasons without ranking intent", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    webSearchProvider: new DisabledWebSearchProvider("disabled for test"),
  });

  const listed = await execute({
    name: "list_tool_capabilities",
    args: { category: "search" },
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(listed.ok).toBe(true);
  expect(listed.capabilities).toEqual(expect.arrayContaining([
    expect.objectContaining({
      name: "web_search",
      category: "search",
      enabled: false,
      disabled_reason: "web search provider is disabled by configuration",
      concurrency_safe: true,
      interrupt_behavior: "continue",
      transcript_visibility: "visible",
    }),
    expect.objectContaining({
      name: "web_read",
      category: "search",
      enabled: true,
      disabled_reason: null,
      concurrency_safe: true,
    }),
  ]));
  const searchCapability = listed.capabilities.find((item: any) => item.name === "web_search");
  expect(searchCapability.tags).toContain("검색");
  expect(searchCapability.safety_notes[0]).toContain("citations");

  const enabledOnly = await execute({
    name: "list_tool_capabilities",
    args: { category: "search", include_disabled: false },
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(enabledOnly.capabilities.map((item: any) => item.name)).toEqual(["web_read"]);

  expect(BUTLER_TOOLS.find((tool) => tool.name === "select_tool_capability")).toBeUndefined();
});

test("automation tools create list claim and delete native schedules", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    sessionId: "butler/main",
  });

  const created = await execute({
    name: "create_automation",
    args: {
      id: "tool-automation",
      title: "Tool automation",
      prompt: "Run a concise scheduled health check.",
      schedule_type: "once",
      run_at: "2026-04-27T08:00:00.000Z",
    },
    rawArguments: "{}",
  }) as Record<string, any>;

  expect(created).toMatchObject({
    ok: true,
    automation: {
      id: "tool-automation",
      session_id: "butler/main",
      status: "active",
      next_run_at: "2026-04-27T08:00:00.000Z",
      prompt_preview: "Run a concise scheduled health check.",
    },
  });

  const listed = await execute({
    name: "list_automations",
    args: {},
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(listed.automations.map((automation: any) => automation.id)).toEqual(["tool-automation"]);

  const claimed = await execute({
    name: "run_due_automations",
    args: { now: "2026-04-27T08:00:00.000Z" },
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(claimed).toMatchObject({
    ok: true,
    claimed: 1,
    runs: [{
      automation: {
        id: "tool-automation",
        status: "completed",
      },
      envelope: {
        transport: "automation",
        routingHints: {
          sessionId: "butler/main",
        },
      },
    }],
  });

  const deleted = await execute({
    name: "delete_automation",
    args: { id: "tool-automation" },
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(deleted.automation).toMatchObject({
    id: "tool-automation",
    status: "deleted",
  });
});

test("todo list tools persist checklist progress under Butler data", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    sessionId: "butler/app-project-butler",
    projectId: "butler",
  });

  const updated = await execute({
    name: "update_todo_list",
    args: {
      list_id: "main",
      title: "Agentic core feature",
      todos: [
        {
          id: "spec",
          content: "Write the governing spec",
          active_form: "Writing the governing spec",
          status: "completed",
          phase: "conception",
        },
        {
          id: "plan",
          content: "Create the execution plan",
          active_form: "Creating the execution plan",
          status: "completed",
          phase: "planning",
        },
        {
          id: "implementation",
          content: "Implement the change",
          active_form: "Implementing the change",
          status: "completed",
          phase: "execution",
        },
        {
          id: "tests",
          content: "Write todo tests",
          active_form: "Writing todo tests",
          status: "in_progress",
          phase: "review",
          priority: "high",
        },
      ],
    },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    progress: { completed: number; in_progress: number; progress_pct: number };
    work_stream: { state: string; current_phase: string; owner_session_id: string; project_id: string };
  };

  expect(updated).toMatchObject({
    ok: true,
    progress: {
      completed: 3,
      in_progress: 1,
      progress_pct: 75,
    },
    work_stream: {
      state: "reviewing",
      current_phase: "review",
      owner_session_id: "butler/app-project-butler",
      project_id: "butler",
    },
  });

  const active = await execute({
    name: "list_todo_list",
    args: {},
    rawArguments: "{}",
  }) as {
    items: Array<{ id: string }>;
    progress: { total: number };
  };
  expect(active.items.map((item) => item.id)).toEqual(["tests"]);
  expect(active.progress.total).toBe(4);

  const all = await execute({
    name: "list_todo_list",
    args: { include_completed: true },
    rawArguments: "{}",
  }) as { items: Array<{ id: string; phase?: string }> };
  expect(all.items.map((item) => item.id)).toEqual(["spec", "plan", "implementation", "tests"]);
  expect(all.items.map((item) => item.phase)).toEqual(["conception", "planning", "execution", "review"]);

  const workStreams = await execute({
    name: "list_work_streams",
    args: {},
    rawArguments: "{}",
  }) as { work_streams: Array<{ state: string; current_phase?: string }> };
  expect(workStreams.work_streams).toEqual([
    expect.objectContaining({ state: "reviewing", current_phase: "review" }),
  ]);
});

test("default todo list scope is isolated per app turn", async () => {
  const sessionId = "butler/app-project-butler";
  const firstTurn = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    sessionId,
    projectId: "butler",
    turnId: "turn-first",
  });
  const first = await firstTurn({
    name: "update_todo_list",
    args: {
      title: "First turn checklist",
      todos: [
        {
          id: "inspect",
          content: "Inspect files",
          active_form: "Inspecting files",
          status: "completed",
          phase: "execution",
        },
        {
          id: "report",
          content: "Report result",
          active_form: "Reporting result",
          status: "completed",
          phase: "reporting",
        },
      ],
    },
    rawArguments: "{}",
  }) as { list_id: string; work_stream: { state: string; todo_list_id: string } };
  expect(first.list_id).toBe("turn-first:main");
  expect(first.work_stream).toMatchObject({
    state: "complete",
    todo_list_id: "turn-first:main",
  });

  const secondTurn = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    sessionId,
    projectId: "butler",
    turnId: "turn-second",
  });
  const second = await secondTurn({
    name: "update_todo_list",
    args: {
      title: "Second turn checklist",
      todos: [
        {
          id: "inspect",
          content: "Inspect new files",
          active_form: "Inspecting new files",
          status: "in_progress",
          phase: "execution",
        },
      ],
    },
    rawArguments: "{}",
  }) as { list_id: string; work_stream: { state: string; todo_list_id: string } };

  expect(second.list_id).toBe("turn-second:main");
  expect(second.work_stream).toMatchObject({
    state: "executing",
    todo_list_id: "turn-second:main",
  });
  const streams = await secondTurn({
    name: "list_work_streams",
    args: { include_terminal: true },
    rawArguments: "{}",
  }) as { work_streams: Array<{ title: string; state: string; todo_list_id: string }> };
  expect(streams.work_streams).toEqual(expect.arrayContaining([
    expect.objectContaining({ title: "First turn checklist", state: "complete", todo_list_id: "turn-first:main" }),
    expect.objectContaining({ title: "Second turn checklist", state: "executing", todo_list_id: "turn-second:main" }),
  ]));
});

test("memory quality tools ingest task outcomes and recall local memory", async () => {
  const taskDir = join(tempDir, "tasks", "task-memory-tool");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "DONE\n", "utf8");
  writeFileSync(join(taskDir, "request.md"), "remember source-backed reports\n", "utf8");
  writeFileSync(join(taskDir, "result.md"), "Source-backed report workflow was completed.\n", "utf8");
  indexTranscriptLinesForQuery({
    butlerData: tempDir,
    transcriptFile: "synthetic-butler-tools.jsonl",
    lines: [
      JSON.stringify({
        eventId: "first-user",
        sessionId: "butler/main",
        kind: "inbound",
        timestamp: "2026-04-24T12:05:34.000Z",
        payload: { message: { text: "SYNTHETIC_FIRST_USER_CHECKPOINT" } },
      }),
      JSON.stringify({
        eventId: "tool-result",
        sessionId: "butler/main",
        kind: "tool_result",
        timestamp: "2026-04-24T12:00:00.000Z",
        payload: { name: "run_command", result: "ignore me" },
      }),
    ],
  });
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
  });

  expect(await execute({
    name: "get_memory_health",
    args: {},
    rawArguments: "{}",
  })).toMatchObject({
    ok: true,
    taskMemoryEntries: 0,
  });
  expect(await execute({
    name: "ingest_task_memory",
    args: { task_id: "task-memory-tool" },
    rawArguments: "{}",
  })).toMatchObject({
    ok: true,
    task_id: "task-memory-tool",
  });
  expect(await execute({
    name: "recall_memory",
    args: { cue: "source-backed reports" },
    rawArguments: "{}",
  })).toMatchObject({
    ok: true,
    results: [expect.objectContaining({ source: "task-memory" })],
  });
  expect(await execute({
    name: "recall_memory",
    args: {
      cue: "source-backed reports",
      include_vector: false,
      strategies: ["query_exact_transcript"],
      evidence_required: ["exact_quote"],
    },
    rawArguments: "{}",
  })).toMatchObject({
    ok: true,
    abstained: true,
    results: [],
    diagnostics: expect.arrayContaining(["evidence=exact_quote_requires_query_memory"]),
  });
  expect(await execute({
    name: "query_memory",
    args: { speaker: "user", order: "earliest", limit: 1 },
    rawArguments: "{}",
  })).toMatchObject({
    ok: true,
    total_matches: 1,
    results: [expect.objectContaining({
      event_id: "first-user",
      timestamp: "2026-04-24T12:05:34.000Z",
      speaker: "user",
    })],
  });
  expect(await execute({
    name: "update_explicit_memory",
    args: {
      kind: "rule",
      text: "Keep memory reports short.",
      source: "unit-test",
    },
    rawArguments: "{}",
  })).toMatchObject({
    ok: true,
  });
});

test("recall_memory tool applies model-provided retrieval strategy evidence", async () => {
  mkdirSync(join(tempDir, "cognition", "memory", "hot"), { recursive: true });
  mkdirSync(join(tempDir, "cognition", "memory", "projects"), { recursive: true });
  writeFileSync(
    join(tempDir, "cognition", "memory", "hot", "runtime.md"),
    "Runtime decision appears in hot cache but is not project memory.\n",
    "utf8",
  );
  writeFileSync(
    join(tempDir, "cognition", "memory", "projects", "butler.md"),
    "Runtime decision is recorded in Butler project memory.\n",
    "utf8",
  );
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    projectId: "butler",
  });

  const recall = await execute({
    name: "recall_memory",
    args: {
      cue: "runtime decision",
      include_vector: false,
      strategies: ["search_lexical_memory"],
      evidence_required: ["project_memory_hit"],
    },
    rawArguments: JSON.stringify({
      cue: "runtime decision",
      include_vector: false,
      strategies: ["search_lexical_memory"],
      evidence_required: ["project_memory_hit"],
    }),
  }) as {
    ok: boolean;
    results: Array<{ source: string; text: string }>;
    diagnostics: string[];
  };

  expect(recall.ok).toBe(true);
  expect(recall.diagnostics).toContain("ranking_policy=planned");
  expect(recall.diagnostics).toContain("evidence=verified");
  expect(recall.results.map((result) => result.source)).toEqual(["project-memory"]);
  expect(recall.results[0]?.text).toContain("Butler project memory");
});

test("recall_memory tool runs retrieval planner when model omits recall policy", async () => {
  const plannerCalls: string[] = [];
  const embedQueries: string[] = [];
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    projectId: "butler",
    sessionId: "butler/main",
    workerModel: "openai/test-memory-planner",
    memoryRetrievalPlanner: async (input) => {
      plannerCalls.push(input.request);
      return {
        usedPlanner: true,
        attempts: 1,
        diagnostics: ["planner_succeeded_attempt_1"],
        plan: {
          self_sufficient: false,
          missing_referents: ["target"],
          strategies: ["search_vector_episode"],
          generated_queries: [{
            strategy: "search_vector_episode",
            query: "semantic composer approval episode",
          }],
          evidence_required: ["vector_episode_hit"],
          max_latency_ms: 500,
        },
      };
    },
    memoryVectorBackend: {
      async embed(query: string) {
        embedQueries.push(query);
        return [0.1, 0.2, 0.3];
      },
      async search() {
        return [{
          id: "composer-vector",
          text: "Semantic composer approval episode says the approval form replaces the input.",
          project: "butler",
          session_id: "s-composer",
          _distance: 0.1,
        }];
      },
    },
  });

  const recall = await execute({
    name: "recall_memory",
    args: { cue: "그거 뭐였지?", limit: 1 },
    rawArguments: JSON.stringify({ cue: "그거 뭐였지?", limit: 1 }),
  }) as {
    ok: boolean;
    results: Array<{ source: string; text: string }>;
    diagnostics: string[];
  };

  expect(plannerCalls).toEqual(["그거 뭐였지?"]);
  expect(embedQueries).toContain("semantic composer approval episode");
  expect(recall.ok).toBe(true);
  expect(recall.results).toEqual([expect.objectContaining({ source: "vector" })]);
  expect(recall.diagnostics).toContain("ranking_policy=planned");
  expect(recall.diagnostics).toContain("retrieval_planner=used");
  expect(recall.diagnostics).toContain("retrieval_planner_planner_succeeded_attempt_1");
});

test("recall_memory tool ignores model vector opt-out for associative recall", async () => {
  const embedQueries: string[] = [];
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    projectId: "butler",
    memoryVectorBackend: {
      async embed(query: string) {
        embedQueries.push(query);
        return [0.1, 0.2, 0.3];
      },
      async search() {
        return [{
          id: "reader-vector",
          text: "Web reader noise reduction used hybrid extraction, confidence scoring, and raw fallback.",
          project: "butler",
          session_id: "s-reader",
          _score: 0.91,
        }];
      },
    },
  });

  const recall = await execute({
    name: "recall_memory",
    args: {
      cue: "웹 리더 본문 노이즈를 줄이는 안전한 접근",
      include_vector: false,
      strategies: ["search_vector_episode"],
      evidence_required: ["vector_episode_hit"],
      limit: 1,
    },
    rawArguments: JSON.stringify({
      cue: "웹 리더 본문 노이즈를 줄이는 안전한 접근",
      include_vector: false,
      strategies: ["search_vector_episode"],
      evidence_required: ["vector_episode_hit"],
      limit: 1,
    }),
  }) as {
    ok: boolean;
    results: Array<{ source: string; text: string }>;
    diagnostics: string[];
  };

  expect(embedQueries).toEqual(["웹 리더 본문 노이즈를 줄이는 안전한 접근"]);
  expect(recall.ok).toBe(true);
  expect(recall.results).toEqual([expect.objectContaining({ source: "vector" })]);
  expect(recall.diagnostics).toContain("vector=ok");
  expect(recall.diagnostics).toContain("vector=forced:model-opt-out-ignored");
});

test("skill catalog tool lists strategy skills for model inspection", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
  });

  const list = await execute({
    name: "list_skills",
    args: {},
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(list.ok).toBe(true);
  expect(list.validation_issues).toEqual([]);
  expect(list.skills.map((skill: any) => skill.name)).toContain("dispatch");
  expect(list.skills.find((skill: any) => skill.name === "dispatch")).toMatchObject({
    dispatch: "auto",
  });
  expect(list.skills.find((skill: any) => skill.name === "dispatch").applicability).toContain("model decides");
  expect(BUTLER_TOOLS.find((tool) => tool.name === "select_skill")).toBeUndefined();
});

test("list_tasks returns user-facing status guidance from durable task state", async () => {
  const taskDir = join(tempDir, "tasks", "task-recoverable");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "RECOVERABLE\n", "utf8");
  writeFileSync(join(taskDir, "request.md"), "조사하던 작업을 이어서 마무리한다\n", "utf8");
  writeFileSync(join(taskDir, "log.txt"), "partial evidence\n", "utf8");
  writeFileSync(join(taskDir, "origin.json"), `${JSON.stringify({
    version: 1,
    origin_session_id: "butler/main",
    origin_message_id: "42",
    origin_inbound_event_id: "mock:42",
    task_summary: "프로젝트 구조 조사",
    created_at: "2026-04-26T00:00:00.000Z",
    project: tempDir,
    transcript_ref: {
      session_id: "butler/main",
      path: join(tempDir, "transcripts", "butler_main.jsonl"),
      origin_event_id: "mock:42",
      origin_message_id: "42",
      recent_event_ids: ["mock:42"],
    },
    memory_refs: [],
  }, null, 2)}\n`, "utf8");

  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
  });

  const listed = await execute({
    name: "list_tasks",
    args: { limit: 5 },
    rawArguments: "{\"limit\":5}",
  }) as { tasks: Array<Record<string, unknown>> };
  const task = listed.tasks[0]!;

  expect(task).toMatchObject({
    task_id: "task-recoverable",
    status: "RECOVERABLE",
    work_mode: "repairing",
    safe_to_report: false,
    completion_claim_allowed: false,
    can_resume: true,
    origin_summary: "프로젝트 구조 조사",
  });
  expect(task.guard_reason).toContain("interrupted");
  expect(task.user_summary).toBe("프로젝트 구조 조사: worker was interrupted and can be resumed.");
  expect(task.next_step).toBe("Resume the worker if the principal asks to continue.");
});

test("get_task_result includes concise user guidance for status follow-ups", async () => {
  const taskDir = join(tempDir, "tasks", "task-done");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "DONE\n", "utf8");
  writeFileSync(join(taskDir, "request.md"), "최근 로그를 요약한다\n", "utf8");
  writeFileSync(join(taskDir, "result.md"), "로그 이상 없음\n", "utf8");

  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
  });

  const result = await execute({
    name: "get_task_result",
    args: { task_id: "task-done" },
    rawArguments: "{\"task_id\":\"task-done\"}",
  }) as Record<string, unknown>;

  expect(result).toMatchObject({
    ok: true,
    status: "DONE",
    work_mode: "complete",
    safe_to_report: true,
    completion_claim_allowed: true,
    guard_reason: null,
    can_resume: false,
    user_summary: "최근 로그를 요약한다: DONE",
    next_step: "Answer from the durable result and observed log evidence.",
    observed_result: "로그 이상 없음",
  });
});

test("run_planned_task consumes a plan and starts a linked worker attempt", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    sessionId: "butler/app-project-planned",
    projectId: "project-planned",
    turnContext: "## Inbound Message\nMessage Text: 첨부 문서를 검토해줘\n\n## Inbound Attachments\nUnique planned source context.",
    workerModel: "openai/gpt-5.4-mini",
    workerModelRules: [
      {
        id: "deep_work",
        label: "Deep work",
        condition: "Research and analysis",
        model: "openai/gpt-5.5",
        reasoning_effort: "high",
        enabled: true,
      },
      {
        id: "routine_work",
        label: "Routine work",
        condition: "Simple inspection",
        model: "openai/gpt-5.4-mini",
        reasoning_effort: "medium",
        enabled: true,
      },
    ],
    dispatchTask: (input) => {
      expect(input.projectPath).toBe("/tmp/planned-project");
      expect(input.model).toBe("openai/gpt-5.4-mini");
      expect(input.reasoningEffort).toBeUndefined();
      expect(input.task).toContain("Execute planned Butler task");
      expect(input.task).toContain("GOAL: 조사하고 보고한다");
      expect(input.task).toContain("User-facing objective: 조사하고 보고한다");
      expect(input.task).toContain("Original Turn Source Context");
      expect(input.task).toContain("Unique planned source context.");
      expect(input.task).toContain("Acceptance Criteria");
      expect(input.task).toContain("증거를 남긴다");
      return {
        task_id: "worker-planned-1",
        status: "RUNNING",
        message: "stubbed",
      };
    },
  });

  const created = await execute({
    name: "create_planned_task",
    args: {
      goal: "조사하고 보고한다",
      project_path: "/tmp/planned-project",
      acceptance_criteria: ["증거를 남긴다"],
      verification_commands: ["bun test"],
    },
    rawArguments: "{}",
  }) as { task_id: string };

  expect(await execute({
    name: "run_planned_task",
    args: { task_id: created.task_id },
    rawArguments: "{}",
  })).toMatchObject({
    ok: true,
    task_id: created.task_id,
    worker_task_id: "worker-planned-1",
    attempt: 1,
    status: "PLANNED_RUNNING",
  });

  const originPath = join(tempDir, "tasks", "worker-planned-1", "origin.json");
  expect(existsSync(originPath)).toBe(true);
  expect(JSON.parse(readFileSync(originPath, "utf8"))).toMatchObject({
    origin_session_id: "butler/app-project-planned",
    task_summary: "조사하고 보고한다",
    project: "project-planned",
  });
});

test("run_planned_task refuses a non-runnable planned task state", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    dispatchTask: () => ({
      task_id: "worker-planned-1",
      status: "RUNNING",
      message: "stubbed",
    }),
  });

  const created = await execute({
    name: "create_planned_task",
    args: {
      goal: "한 번만 실행한다",
      acceptance_criteria: ["한 번만 실행된다"],
    },
    rawArguments: "{}",
  }) as { task_id: string };
  await execute({
    name: "run_planned_task",
    args: { task_id: created.task_id },
    rawArguments: "{}",
  });

  await expect(execute({
    name: "run_planned_task",
    args: { task_id: created.task_id },
    rawArguments: "{}",
  })).rejects.toThrow("invalid planned task transition PLANNED_RUNNING -> PLANNED_RUNNING");
});

test("review_planned_task passes only when every criterion passes", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    dispatchTask: () => ({
      task_id: "worker-pass",
      status: "RUNNING",
      message: "stubbed",
    }),
  });
  const created = await execute({
    name: "create_planned_task",
    args: {
      goal: "검토 가능한 작업",
      acceptance_criteria: ["테스트 통과", "문서 업데이트"],
    },
    rawArguments: "{}",
  }) as { task_id: string };
  await execute({ name: "run_planned_task", args: { task_id: created.task_id }, rawArguments: "{}" });

  const store = new PlannedTaskStore(tempDir);
  store.writeAttemptResult(created.task_id, 1, "tests pass and docs updated");
  store.transition(created.task_id, "WORKER_DONE");

  const reviewed = await execute({
    name: "review_planned_task",
    args: {
      task_id: created.task_id,
      criteria: [
        { criterion: "테스트 통과", verdict: "PASS", evidence: "bun test passed" },
        { criterion: "문서 업데이트", verdict: "PASS", evidence: "docs updated" },
      ],
      goal_review: { verdict: "PASS", evidence: "tests pass and docs updated" },
    },
    rawArguments: "{}",
  });

  expect(reviewed).toMatchObject({
    ok: true,
    verdict: "PASS",
    status: "REVIEW_PASSED",
  });
  expect((reviewed as Record<string, unknown>).evidence_capability_receipts).toEqual([
    expect.objectContaining({
      capability: "review_completed",
      evidence_kind: "review_result",
      verified: true,
      scope: expect.objectContaining({ result: "completed" }),
    }),
  ]);
});

test("review_planned_task cannot pass without internal GOAL review evidence", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    dispatchTask: () => ({
      task_id: "worker-goal-review",
      status: "RUNNING",
      message: "stubbed",
    }),
  });
  const created = await execute({
    name: "create_planned_task",
    args: {
      goal: "BTCC 목표를 끝까지 확인한다",
      internal_goal: "BTCC cycle must prove the requested objective complete",
      acceptance_criteria: ["검증 증거가 있다"],
    },
    rawArguments: "{}",
  }) as { task_id: string };
  await execute({ name: "run_planned_task", args: { task_id: created.task_id }, rawArguments: "{}" });

  const store = new PlannedTaskStore(tempDir);
  store.writeAttemptResult(created.task_id, 1, "verification passed");
  store.transition(created.task_id, "WORKER_DONE");

  expect(await execute({
    name: "review_planned_task",
    args: {
      task_id: created.task_id,
      criteria: [{ criterion: "검증 증거가 있다", verdict: "PASS", evidence: "verification passed" }],
    },
    rawArguments: "{}",
  })).toMatchObject({
    ok: true,
    verdict: "INCONCLUSIVE",
    status: "REVIEW_INCONCLUSIVE",
    missing_evidence: ["Internal GOAL review: Internal GOAL review evidence was not supplied."],
    repair_recommendation: "Continue the BTCC cycle until the internal GOAL is complete or safely failed with evidence.",
  });
});

test("review_planned_task records failed and inconclusive evidence", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    dispatchTask: () => ({
      task_id: "worker-fail",
      status: "RUNNING",
      message: "stubbed",
    }),
  });
  const created = await execute({
    name: "create_planned_task",
    args: {
      goal: "검토 실패를 기록한다",
      acceptance_criteria: ["테스트 통과", "회귀 없음"],
    },
    rawArguments: "{}",
  }) as { task_id: string };
  await execute({ name: "run_planned_task", args: { task_id: created.task_id }, rawArguments: "{}" });

  const store = new PlannedTaskStore(tempDir);
  store.writeAttemptResult(created.task_id, 1, "tests failed");
  store.transition(created.task_id, "WORKER_DONE");

  const failed = await execute({
    name: "review_planned_task",
    args: {
      task_id: created.task_id,
      criteria: [
        { criterion: "테스트 통과", verdict: "FAIL", evidence: "bun test failed" },
        { criterion: "회귀 없음", verdict: "INCONCLUSIVE", evidence: "regression suite not run" },
      ],
      missing_evidence: ["regression suite"],
      repair_recommendation: "Fix failing tests and rerun regression suite.",
    },
    rawArguments: "{}",
  });

  expect(failed).toMatchObject({
    ok: true,
    verdict: "FAIL",
    status: "REVIEW_FAILED",
    missing_evidence: ["regression suite"],
    repair_recommendation: "Fix failing tests and rerun regression suite.",
  });
  expect((failed as Record<string, unknown>).evidence_capability_receipts).toEqual([
    expect.objectContaining({
      capability: "review_completed",
      evidence_kind: "review_result",
      verified: false,
      scope: expect.objectContaining({ result: "changes_requested" }),
      limitations: ["regression suite"],
    }),
  ]);
});

test("review_planned_task cannot pass with missing acceptance-criterion evidence", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    dispatchTask: () => ({
      task_id: "worker-missing-criterion",
      status: "RUNNING",
      message: "stubbed",
    }),
  });
  const created = await execute({
    name: "create_planned_task",
    args: {
      goal: "모든 기준을 검토해야 한다",
      acceptance_criteria: ["테스트 통과", "문서 업데이트"],
    },
    rawArguments: "{}",
  }) as { task_id: string };
  await execute({ name: "run_planned_task", args: { task_id: created.task_id }, rawArguments: "{}" });

  const store = new PlannedTaskStore(tempDir);
  store.writeAttemptResult(created.task_id, 1, "tests pass, docs not checked");
  store.transition(created.task_id, "WORKER_DONE");

  expect(await execute({
    name: "review_planned_task",
    args: {
      task_id: created.task_id,
      criteria: [
        { criterion: "테스트 통과", verdict: "PASS", evidence: "bun test passed" },
      ],
    },
    rawArguments: "{}",
  })).toMatchObject({
    ok: true,
    verdict: "INCONCLUSIVE",
    status: "REVIEW_INCONCLUSIVE",
    missing_evidence: ["문서 업데이트"],
    repair_recommendation: "Review every acceptance criterion before preparing a public completion report.",
  });
});

test("review_planned_task covers acceptance criteria by stable index", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    dispatchTask: () => ({
      task_id: "worker-indexed-review",
      status: "RUNNING",
      message: "stubbed",
    }),
  });
  const created = await execute({
    name: "create_planned_task",
    args: {
      goal: "문장 변경에도 기준을 안정적으로 검토한다",
      acceptance_criteria: [
        "Identify durable storage paths exactly",
        "Verify startup recovery process",
        "Confirm transport identity mapping",
      ],
    },
    rawArguments: "{}",
  }) as { task_id: string };
  await execute({ name: "run_planned_task", args: { task_id: created.task_id }, rawArguments: "{}" });

  const store = new PlannedTaskStore(tempDir);
  store.writeAttemptResult(created.task_id, 1, "all indexed evidence exists");
  store.transition(created.task_id, "WORKER_DONE");

  expect(await execute({
    name: "review_planned_task",
    args: {
      task_id: created.task_id,
      criteria: [
        { criterion_index: 1, criterion: "storage paths", verdict: "PASS", evidence: "found session-store.sqlite" },
        { criterion_index: 2, criterion: "startup", verdict: "PASS", evidence: "found ensureButlerSession" },
        { criterion_index: 3, criterion: "transport", verdict: "PASS", evidence: "found session_transport_bindings" },
      ],
      goal_review: { verdict: "PASS", evidence: "all indexed evidence exists" },
    },
    rawArguments: "{}",
  })).toMatchObject({
    ok: true,
    verdict: "PASS",
    status: "REVIEW_PASSED",
    missing_evidence: [],
  });
});

test("review_planned_task rejects missing attempt numbers", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    dispatchTask: () => ({
      task_id: "worker-attempt",
      status: "RUNNING",
      message: "stubbed",
    }),
  });
  const created = await execute({
    name: "create_planned_task",
    args: {
      goal: "없는 attempt를 검토하지 않는다",
      acceptance_criteria: ["attempt 존재"],
    },
    rawArguments: "{}",
  }) as { task_id: string };
  await execute({ name: "run_planned_task", args: { task_id: created.task_id }, rawArguments: "{}" });

  const store = new PlannedTaskStore(tempDir);
  store.writeAttemptResult(created.task_id, 1, "attempt 1 only");
  store.transition(created.task_id, "WORKER_DONE");

  await expect(execute({
    name: "review_planned_task",
    args: {
      task_id: created.task_id,
      attempt: 2,
      criteria: [{ criterion: "attempt 존재", verdict: "PASS", evidence: "attempt 1 exists only" }],
    },
    rawArguments: "{}",
  })).rejects.toThrow(`planned task ${created.task_id} has no attempt 2`);
});

test("review_planned_task treats stale attempt ownership as non-mutating", async () => {
  let dispatches = 0;
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    dispatchTask: () => {
      dispatches += 1;
      return {
        task_id: `worker-stale-${dispatches}`,
        status: "RUNNING",
        message: "stubbed",
      };
    },
  });
  const created = await execute({
    name: "create_planned_task",
    args: {
      goal: "오래된 리뷰가 최신 작업을 덮지 않는다",
      acceptance_criteria: ["최신 attempt만 상태를 바꾼다"],
      repair_policy: { max_attempts: 2, allow_autonomous_repair: true },
    },
    rawArguments: "{}",
  }) as { task_id: string };
  await execute({ name: "run_planned_task", args: { task_id: created.task_id }, rawArguments: "{}" });

  const store = new PlannedTaskStore(tempDir);
  store.writeAttemptResult(created.task_id, 1, "first attempt failed");
  store.transition(created.task_id, "WORKER_DONE");
  await execute({
    name: "review_planned_task",
    args: {
      task_id: created.task_id,
      attempt: 1,
      worker_task_id: "worker-stale-1",
      review_event_id: "review-stale-1",
      criteria: [{ criterion: "최신 attempt만 상태를 바꾼다", verdict: "FAIL", evidence: "first attempt failed" }],
      repair_recommendation: "Run a repair.",
    },
    rawArguments: "{}",
  });
  await execute({
    name: "repair_planned_task",
    args: { task_id: created.task_id, repair_objective: "다시 시도한다" },
    rawArguments: "{}",
  });

  const staleReview = await execute({
    name: "review_planned_task",
    args: {
      task_id: created.task_id,
      attempt: 1,
      worker_task_id: "worker-stale-1",
      review_event_id: "review-stale-duplicate",
      criteria: [{ criterion: "최신 attempt만 상태를 바꾼다", verdict: "FAIL", evidence: "old result" }],
      repair_recommendation: "This stale review must not start another repair.",
    },
    rawArguments: "{}",
  }) as Record<string, unknown>;

  expect(staleReview).toMatchObject({
    ok: false,
    task_id: created.task_id,
    classification: "STALE_REVIEW_EVENT",
  });
  expect(store.read(created.task_id)?.status).toBe("PLANNED_RUNNING");
  expect(store.read(created.task_id)?.attempts).toEqual(["001", "002"]);
});

test("repair_planned_task starts another linked worker attempt when retry budget remains", async () => {
  const dispatched: string[] = [];
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    sessionId: "butler/app-project-repair",
    projectId: "project-repair",
    dispatchTask: (input) => {
      dispatched.push(input.task);
      return {
        task_id: `worker-repair-${dispatched.length}`,
        status: "RUNNING",
        message: "stubbed",
      };
    },
  });
  const created = await execute({
    name: "create_planned_task",
    args: {
      goal: "수리 후 통과한다",
      acceptance_criteria: ["테스트 통과"],
      repair_policy: { max_attempts: 2, allow_autonomous_repair: true },
    },
    rawArguments: "{}",
  }) as { task_id: string };
  await execute({ name: "run_planned_task", args: { task_id: created.task_id }, rawArguments: "{}" });

  const store = new PlannedTaskStore(tempDir);
  store.writeAttemptResult(created.task_id, 1, "tests failed");
  store.transition(created.task_id, "WORKER_DONE");
  await execute({
    name: "review_planned_task",
    args: {
      task_id: created.task_id,
      criteria: [{ criterion: "테스트 통과", verdict: "FAIL", evidence: "bun test failed" }],
      repair_recommendation: "Fix tests.",
    },
    rawArguments: "{}",
  });

  expect(await execute({
    name: "repair_planned_task",
    args: {
      task_id: created.task_id,
      repair_objective: "테스트 실패를 수정한다",
    },
    rawArguments: "{}",
  })).toMatchObject({
    ok: true,
    task_id: created.task_id,
    worker_task_id: "worker-repair-2",
    attempt: 2,
    status: "PLANNED_RUNNING",
  });
  expect(dispatched[1]).toContain("Repair planned Butler task");
  expect(dispatched[1]).toContain("Fix tests.");
  const originPath = join(tempDir, "tasks", "worker-repair-2", "origin.json");
  expect(existsSync(originPath)).toBe(true);
  expect(JSON.parse(readFileSync(originPath, "utf8"))).toMatchObject({
    origin_session_id: "butler/app-project-repair",
    task_summary: "수리 후 통과한다",
    project: "project-repair",
    topic_summary: "Planned Butler repair attempt",
  });
});

test("repair_planned_task writes failure report when retry cap is exhausted", async () => {
  let dispatches = 0;
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    dispatchTask: () => {
      dispatches += 1;
      return {
        task_id: `worker-cap-${dispatches}`,
        status: "RUNNING",
        message: "stubbed",
      };
    },
  });
  const created = await execute({
    name: "create_planned_task",
    args: {
      goal: "cap에 걸린다",
      acceptance_criteria: ["통과할 수 없다"],
      repair_policy: { max_attempts: 0, allow_autonomous_repair: true },
    },
    rawArguments: "{}",
  }) as { task_id: string };
  await execute({ name: "run_planned_task", args: { task_id: created.task_id }, rawArguments: "{}" });

  const store = new PlannedTaskStore(tempDir);
  store.writeAttemptResult(created.task_id, 1, "still failing");
  store.transition(created.task_id, "WORKER_DONE");
  await execute({
    name: "review_planned_task",
    args: {
      task_id: created.task_id,
      criteria: [{ criterion: "통과할 수 없다", verdict: "FAIL", evidence: "failure remains" }],
      missing_evidence: ["passing verification"],
      repair_recommendation: "Needs more work.",
    },
    rawArguments: "{}",
  });

  expect(await execute({
    name: "repair_planned_task",
    args: { task_id: created.task_id },
    rawArguments: "{}",
  })).toMatchObject({
    ok: false,
    task_id: created.task_id,
    status: "FAILED_PUBLIC_REPORT_READY",
    reason: "repair_cap_exhausted",
  });
  expect(dispatches).toBe(1);
  const publicReport = store.read(created.task_id)?.publicReport ?? "";
  expect(publicReport).toContain("What was completed");
  expect(publicReport).toContain("Why Butler is not claiming completion");
  expect(publicReport).not.toContain("repair retry cap exhausted");
  expect(publicReport).not.toContain("Planned task could not be completed");
});

test("repair_planned_task writes failure report when autonomous repair is disabled", async () => {
  let dispatches = 0;
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    dispatchTask: () => {
      dispatches += 1;
      return {
        task_id: `worker-disabled-${dispatches}`,
        status: "RUNNING",
        message: "stubbed",
      };
    },
  });
  const created = await execute({
    name: "create_planned_task",
    args: {
      goal: "수리 비활성화",
      acceptance_criteria: ["검토 실패"],
      repair_policy: { max_attempts: 2, allow_autonomous_repair: false },
    },
    rawArguments: "{}",
  }) as { task_id: string };
  await execute({ name: "run_planned_task", args: { task_id: created.task_id }, rawArguments: "{}" });

  const store = new PlannedTaskStore(tempDir);
  store.writeAttemptResult(created.task_id, 1, "failed");
  store.transition(created.task_id, "WORKER_DONE");
  await execute({
    name: "review_planned_task",
    args: {
      task_id: created.task_id,
      criteria: [{ criterion: "검토 실패", verdict: "FAIL", evidence: "failed" }],
    },
    rawArguments: "{}",
  });

  expect(await execute({
    name: "repair_planned_task",
    args: { task_id: created.task_id },
    rawArguments: "{}",
  })).toMatchObject({
    ok: false,
    status: "FAILED_PUBLIC_REPORT_READY",
    reason: "autonomous_repair_disabled",
  });
  expect(dispatches).toBe(1);
});

test("repair_planned_task supports inconclusive reviews and worker failures", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    dispatchTask: () => ({
      task_id: `worker-${Math.random()}`,
      status: "RUNNING",
      message: "stubbed",
    }),
  });

  const inconclusive = await execute({
    name: "create_planned_task",
    args: {
      goal: "불충분한 증거를 보강한다",
      acceptance_criteria: ["증거 충분"],
      repair_policy: { max_attempts: 1, allow_autonomous_repair: true },
    },
    rawArguments: "{}",
  }) as { task_id: string };
  await execute({ name: "run_planned_task", args: { task_id: inconclusive.task_id }, rawArguments: "{}" });
  const store = new PlannedTaskStore(tempDir);
  store.writeAttemptResult(inconclusive.task_id, 1, "not enough evidence");
  store.transition(inconclusive.task_id, "WORKER_DONE");
  await execute({
    name: "review_planned_task",
    args: {
      task_id: inconclusive.task_id,
      criteria: [{ criterion: "증거 충분", verdict: "INCONCLUSIVE", evidence: "evidence missing" }],
    },
    rawArguments: "{}",
  });
  expect(await execute({
    name: "repair_planned_task",
    args: { task_id: inconclusive.task_id },
    rawArguments: "{}",
  })).toMatchObject({
    ok: true,
    attempt: 2,
    status: "PLANNED_RUNNING",
  });

  const workerFailed = await execute({
    name: "create_planned_task",
    args: {
      goal: "실패한 워커를 복구한다",
      acceptance_criteria: ["워커 성공"],
      repair_policy: { max_attempts: 1, allow_autonomous_repair: true },
    },
    rawArguments: "{}",
  }) as { task_id: string };
  await execute({ name: "run_planned_task", args: { task_id: workerFailed.task_id }, rawArguments: "{}" });
  store.writeAttemptResult(workerFailed.task_id, 1, "worker crashed");
  store.transition(workerFailed.task_id, "WORKER_FAILED");
  expect(await execute({
    name: "repair_planned_task",
    args: { task_id: workerFailed.task_id, repair_objective: "crash 원인을 복구한다" },
    rawArguments: "{}",
  })).toMatchObject({
    ok: true,
    attempt: 2,
    status: "PLANNED_RUNNING",
  });
});

test("request_principal_decision blocks a planned task and returns transport event metadata", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
  });
  const created = await execute({
    name: "create_planned_task",
    args: {
      goal: "외부 비용 결정을 요청한다",
      acceptance_criteria: ["주요 결정은 사용자에게 묻는다"],
    },
    rawArguments: "{}",
  }) as { task_id: string };

  const result = await execute({
    name: "request_principal_decision",
    args: {
      task_id: created.task_id,
      situation: "A paid external service is needed to continue.",
      recommended_option_id: "approve",
      options: [
        { id: "approve", label: "Approve", description: "Use the paid service." },
        { id: "skip", label: "Skip", description: "Avoid external cost." },
      ],
      tradeoffs: ["Approving is faster; skipping is cheaper."],
    },
    rawArguments: "{}",
  }) as {
    status: string;
    decision: { decision_id: string };
    outbound_event: {
      kind: string;
      metadata: { replyMarkup: { inline_keyboard: Array<Array<{ callback_data: string }>> } };
    };
  };

  expect(result.status).toBe("BLOCKED_WAITING_PRINCIPAL");
  expect(result.outbound_event.kind).toBe("principal_decision_requested");
  expect(result.outbound_event.metadata.replyMarkup.inline_keyboard[0]![0]!.callback_data)
    .toBe(`pd:${result.decision.decision_id}:approve`);

  const stored = new PlannedTaskStore(tempDir).read(created.task_id);
  expect(stored?.status).toBe("BLOCKED_WAITING_PRINCIPAL");
  expect(stored?.decision?.recommended_option_id).toBe("approve");
});

test("request_principal_decision rejects invalid recommendations and oversized callbacks", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
  });
  const created = await execute({
    name: "create_planned_task",
    args: {
      goal: "잘못된 선택지를 거절한다",
      acceptance_criteria: ["선택지가 검증된다"],
    },
    rawArguments: "{}",
  }) as { task_id: string };

  await expect(execute({
    name: "request_principal_decision",
    args: {
      task_id: created.task_id,
      situation: "Need a decision.",
      recommended_option_id: "missing",
      options: [
        { id: "approve", label: "Approve", description: "Proceed." },
        { id: "skip", label: "Skip", description: "Do not proceed." },
      ],
    },
    rawArguments: "{}",
  })).rejects.toThrow("recommended option must match an option id");

  await expect(execute({
    name: "request_principal_decision",
    args: {
      task_id: created.task_id,
      situation: "Need a decision.",
      recommended_option_id: "approve",
      options: [
        { id: "approve", label: "Approve", description: "Proceed." },
        {
          id: "this-option-id-is-too-long-for-telegram-callback-data",
          label: "Too long",
          description: "This should be rejected.",
        },
      ],
    },
    rawArguments: "{}",
  })).rejects.toThrow("callback_data exceeds 64 bytes");
});

test("write_planned_public_report stores the user-facing report without internal review evidence", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    dispatchTask: () => ({
      task_id: "worker-report",
      status: "RUNNING",
      message: "stubbed",
    }),
  });
  const created = await execute({
    name: "create_planned_task",
    args: {
      goal: "최종 보고서를 만든다",
      acceptance_criteria: ["검증 증거 포함"],
    },
    rawArguments: "{}",
  }) as { task_id: string };
  await execute({ name: "run_planned_task", args: { task_id: created.task_id }, rawArguments: "{}" });
  const store = new PlannedTaskStore(tempDir);
  store.writeAttemptResult(created.task_id, 1, "raw worker prompt: secret\nverification passed");
  store.transition(created.task_id, "WORKER_DONE");
  await execute({
    name: "review_planned_task",
    args: {
      task_id: created.task_id,
      criteria: [{ criterion: "검증 증거 포함", verdict: "PASS", evidence: "verification passed" }],
      goal_review: { verdict: "PASS", evidence: "verification passed" },
    },
    rawArguments: "{}",
  });

  const result = await execute({
    name: "write_planned_public_report",
    args: {
      task_id: created.task_id,
      report: [
        "검증 결과를 바탕으로 최종 보고서를 완성했습니다.",
        "",
        "## 핵심 결과",
        "- 사용자에게 필요한 결론과 근거를 정리했습니다.",
        "- 내부 검토 판정은 사용자 보고서에 노출하지 않습니다.",
      ].join("\n"),
      outcome: "검토까지 완료했습니다.",
      what_was_done: ["계획된 작업을 실행하고 검증 증거를 확인했습니다."],
      residual_risk: [],
      next_action: "추가 요청이 있으면 이어서 진행하겠습니다.",
    },
    rawArguments: "{}",
  }) as { status: string; report: string };

  expect(result.status).toBe("PUBLIC_REPORT_READY");
  expect(result.report).toContain("## 핵심 결과");
  expect(result.report).not.toContain("Verdict: PASS");
  expect(result.report).not.toContain("verification passed");
  expect(result.report).not.toContain(created.task_id);
  expect(result.report).not.toContain("raw worker prompt");
});

test("write_planned_public_report refuses missing review and existing failure reports", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
  });
  const store = new PlannedTaskStore(tempDir);
  store.create({
    task_id: "planned-no-review",
    type: "planned",
    goal: "No review",
    project: tempDir,
    created_at: "2026-04-25T00:00:00.000Z",
    decision_policy: "autonomous",
    acceptance_criteria: ["review required"],
    verification_commands: [],
    review_policy: "review all criteria",
    repair_policy: { max_attempts: 1, allow_autonomous_repair: true },
    public_report_policy: "brief",
  });
  store.transition("planned-no-review", "PLANNED_RUNNING");
  store.writeAttemptResult("planned-no-review", 1, "done");
  store.transition("planned-no-review", "WORKER_DONE");
  store.transition("planned-no-review", "REVIEWING");
  store.transition("planned-no-review", "REVIEW_PASSED");

  await expect(execute({
    name: "write_planned_public_report",
    args: {
      task_id: "planned-no-review",
      report: "Should fail",
      outcome: "Should fail",
      what_was_done: ["No review was recorded."],
    },
    rawArguments: "{}",
  })).rejects.toThrow("requires a recorded planned review");

  store.create({
    task_id: "planned-failure-ready",
    type: "planned",
    goal: "Already failed",
    project: tempDir,
    created_at: "2026-04-25T00:00:00.000Z",
    decision_policy: "autonomous",
    acceptance_criteria: ["failure report ready"],
    verification_commands: [],
    review_policy: "review all criteria",
    repair_policy: { max_attempts: 0, allow_autonomous_repair: true },
    public_report_policy: "brief",
  });
  store.transition("planned-failure-ready", "PLANNED_RUNNING");
  store.writeAttemptResult("planned-failure-ready", 1, "failed");
  store.transition("planned-failure-ready", "WORKER_DONE");
  store.transition("planned-failure-ready", "REVIEWING");
  store.writeReview({
    task_id: "planned-failure-ready",
    attempt: 1,
    verdict: "FAIL",
    reviewed_at: "2026-04-25T00:00:00.000Z",
    criteria: [{ criterion: "failure report ready", verdict: "FAIL", evidence: "failed" }],
    missing_evidence: ["pass"],
    repair_recommendation: "No repair budget.",
  });
  store.transition("planned-failure-ready", "REVIEW_FAILED");
  store.transition("planned-failure-ready", "FAILED_PUBLIC_REPORT_READY");
  store.writePublicReport("planned-failure-ready", "Existing failure report");

  await expect(execute({
    name: "write_planned_public_report",
    args: {
      task_id: "planned-failure-ready",
      outcome: "Overwrite",
      what_was_done: ["This should not overwrite."],
    },
    rawArguments: "{}",
  })).rejects.toThrow("already ready");
});

test("resume_worker starts a new worker from the latest recoverable task context", async () => {
  const taskDir = join(tempDir, "tasks", "task-recoverable");
  const fixtureProjectPath = join(tempDir, "workspace", "butler");
  mkdirSync(fixtureProjectPath, { recursive: true });
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "RECOVERABLE");
  writeFileSync(join(taskDir, "request.md"), "continue the chart implementation");
  writeFileSync(join(taskDir, "project"), fixtureProjectPath);
  writeFileSync(join(taskDir, "log.txt"), [
    "[worker-runner] [2026-04-25 01:00:00] run_shell (inspect files): rg chart",
    "[worker-runner] [2026-04-25 01:00:01] run_shell result: exit=0 timed_out=false",
  ].join("\n"));

  const dispatched: Array<{ task: string; projectPath: string }> = [];
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    dispatchTask: (input) => {
      dispatched.push({
        task: input.task,
        projectPath: input.projectPath,
      });
      return {
        task_id: "task-resumed",
        status: "RUNNING",
        message: "stubbed",
      };
    },
  });

  const result = await execute({
    name: "resume_worker",
    args: {},
    rawArguments: "{}",
  });

  expect(result).toMatchObject({
    ok: true,
    original_task_id: "task-recoverable",
    task_id: "task-resumed",
    status: "RUNNING",
  });
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]!.projectPath).toBe(fixtureProjectPath);
  expect(dispatched[0]!.task).toContain("Resume interrupted worker task task-recoverable.");
  expect(dispatched[0]!.task).toContain("continue the chart implementation");
  expect(dispatched[0]!.task).toContain("Previous worker log tail");
});

test("resume_worker reconciles a dead RUNNING task before resuming it", async () => {
  const taskDir = join(tempDir, "tasks", "task-dead-running");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "RUNNING");
  writeFileSync(join(taskDir, "pid"), "99999999");
  writeFileSync(join(taskDir, "request.md"), "finish interrupted research");
  writeFileSync(join(taskDir, "project"), tempDir);

  const prompts: string[] = [];
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    dispatchTask: (input) => {
      prompts.push(input.task);
      return {
        task_id: "task-resumed-after-reconcile",
        status: "RUNNING",
        message: "stubbed",
      };
    },
  });

  const result = await execute({
    name: "resume_worker",
    args: { task_id: "task-dead-running" },
    rawArguments: "{\"task_id\":\"task-dead-running\"}",
  });

  expect(result).toMatchObject({
    ok: true,
    original_task_id: "task-dead-running",
    task_id: "task-resumed-after-reconcile",
    status: "RUNNING",
  });
  expect(prompts[0]).toContain("Resume interrupted worker task task-dead-running");
  expect(new TaskStore(tempDir).read("task-dead-running")?.status).toBe("RECOVERABLE");
});

test("resume_worker refuses non-recoverable tasks", async () => {
  const taskDir = join(tempDir, "tasks", "task-done");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "DONE");

  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    dispatchTask: () => {
      throw new Error("dispatch should not run");
    },
  });

  expect(await execute({
    name: "resume_worker",
    args: { task_id: "task-done" },
    rawArguments: "{\"task_id\":\"task-done\"}",
  })).toMatchObject({
    ok: false,
    task_id: "task-done",
    status: "DONE",
    error: "task is not recoverable",
  });
});

test("work orchestration tools dispatch dependency-ready streams and gate reporting", async () => {
  let dispatchIndex = 0;
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    sessionId: "butler/app-general",
    projectId: "general-project",
    dispatchTask: (input) => {
      dispatchIndex += 1;
      expect(input.task).toContain("Execute Butler orchestration work stream");
      return {
        task_id: `orch-worker-${dispatchIndex}`,
        status: "RUNNING",
        message: "stubbed",
      };
    },
  });

  const created = await execute({
    name: "create_work_orchestration",
    args: {
      id: "orch-tool",
      goal: "조사와 구현을 역할별로 진행한다",
      streams: [
        {
          id: "research",
          role: "researcher",
          objective: "관련 제약을 조사한다",
          acceptance_criteria: ["제약 요약이 있다"],
        },
        {
          id: "build",
          role: "builder",
          objective: "조사 결과에 맞춰 구현한다",
          acceptance_criteria: ["구현 증거가 있다"],
          depends_on: ["research"],
        },
      ],
    },
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(created.orchestration).toMatchObject({
    id: "orch-tool",
    status: "draft",
    stream_count: 2,
  });
  await expect(execute({
    name: "create_work_orchestration",
    args: {
      goal: "다른 세션으로 만들면 안 된다",
      origin_session_id: "butler/other",
      streams: [{
        role: "researcher",
        objective: "test",
        acceptance_criteria: ["safe"],
      }],
    },
    rawArguments: "{}",
  })).rejects.toThrow("origin_session_id must match active session");

  const firstRun = await execute({
    name: "run_ready_work_streams",
    args: { orchestration_id: "orch-tool" },
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(firstRun.dispatched).toEqual([{ stream_id: "research", worker_task_id: "orch-worker-1" }]);
  expect(firstRun.orchestration).toMatchObject({
    status: "running",
    counts: { running: 1, pending: 1 },
  });
  expect(new TaskStore(tempDir).read("orch-worker-1")?.origin).toMatchObject({
    origin_session_id: "butler/app-general",
    project: "general-project",
    topic_summary: "Work orchestration stream research",
  });

  await expect(execute({
    name: "write_work_orchestration_report",
    args: { orchestration_id: "orch-tool", report: "아직 보고하면 안 됩니다." },
    rawArguments: "{}",
  })).rejects.toThrow("requires all streams to be terminal");

  const workerOne = join(tempDir, "tasks", "orch-worker-1");
  mkdirSync(workerOne, { recursive: true });
  writeFileSync(join(workerOne, "status"), "DONE\n", "utf8");
  writeFileSync(join(workerOne, "result.md"), "research evidence\n", "utf8");

  expect(await execute({
    name: "sync_work_orchestration",
    args: { orchestration_id: "orch-tool" },
    rawArguments: "{}",
  })).toMatchObject({
    ok: true,
    orchestration: {
      counts: { done: 1, pending: 1 },
    },
  });

  const secondRun = await execute({
    name: "run_ready_work_streams",
    args: { orchestration_id: "orch-tool" },
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(secondRun.dispatched).toEqual([{ stream_id: "build", worker_task_id: "orch-worker-2" }]);
  expect(new TaskStore(tempDir).read("orch-worker-2")?.origin).toMatchObject({
    origin_session_id: "butler/app-general",
    project: "general-project",
    topic_summary: "Work orchestration stream build",
  });

  const workerTwo = join(tempDir, "tasks", "orch-worker-2");
  mkdirSync(workerTwo, { recursive: true });
  writeFileSync(join(workerTwo, "status"), "DONE\n", "utf8");
  writeFileSync(join(workerTwo, "result.md"), "build evidence\n", "utf8");
  await execute({
    name: "sync_work_orchestration",
    args: { orchestration_id: "orch-tool" },
    rawArguments: "{}",
  });

  expect(await execute({
    name: "write_work_orchestration_report",
    args: { orchestration_id: "orch-tool", report: "두 역할의 결과를 종합했습니다." },
    rawArguments: "{}",
  })).toMatchObject({
    ok: true,
    orchestration: {
      status: "reported",
      safe_to_report: true,
      completion_claim_allowed: true,
    },
  });
});

test("Butler tool registry converts to agent-loop schemas", () => {
  const tools = butlerToolsForAgentLoop();
  const dispatch = tools.find((tool) => tool.name === "dispatch_worker");
  expect(dispatch?.inputSchema?.required).toEqual(["task"]);
  expect(dispatch?.inputSchema?.additionalProperties).toBe(false);
});

test("direct worker dispatch records durable app origin", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    sessionId: "butler/app-general",
    projectId: "general-project",
    dispatchTask: (input) => {
      expect(input.task).toBe("Inspect the current issue");
      return {
        task_id: "direct-worker-origin",
        status: "RUNNING",
        message: "stubbed",
      };
    },
  });

  await execute({
    name: "dispatch_worker",
    args: { task: "Inspect the current issue" },
    rawArguments: "{}",
  });

  expect(new TaskStore(tempDir).read("direct-worker-origin")?.origin).toMatchObject({
    origin_session_id: "butler/app-general",
    project: "general-project",
    task_summary: "Inspect the current issue",
  });
});

test("list_tasks returns durable task summaries from Butler data", async () => {
  const taskDir = join(tempDir, "tasks", "task-1");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "DONE");
  writeFileSync(join(taskDir, "project"), "/tmp/project");
  writeFileSync(join(taskDir, "request.md"), "check the project");
  writeFileSync(join(taskDir, "result.md"), "finished");

  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
  });
  const result = await execute({
    name: "list_tasks",
    args: { limit: 5 },
    rawArguments: "{\"limit\":5}",
  });

  expect(result).toEqual({
    ok: true,
    tasks: [{
      task_id: "task-1",
      task_type: "direct",
      status: "DONE",
      project: "/tmp/project",
      origin_session_id: null,
      origin_project: null,
      request: "check the project",
      has_result: true,
      has_log: false,
      observed_result_preview: "finished",
      origin_summary: null,
      planned_status: null,
      planned_goal: null,
      review_verdict: null,
      public_report_ready: false,
      work_mode: "complete",
      safe_to_report: true,
      completion_claim_allowed: true,
      completion_evidence: expect.objectContaining({
        classification: "diagnosis-only",
        safe_to_report: true,
        completion_claim_allowed: true,
      }),
      guard_reason: null,
      can_resume: false,
      user_summary: "check the project: worker completed.",
      next_step: "Answer from durable task state and avoid exposing internal ids unless asked.",
      updated_at: expect.any(String),
    }],
  });
});

test("list_tasks exposes observed log summaries for failed tasks without result files", async () => {
  const taskDir = join(tempDir, "tasks", "task-log-summary");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "FAILED");
  writeFileSync(join(taskDir, "request.md"), "verify the project");
  writeFileSync(join(taskDir, "log.txt"), [
    "[worker-runner] [2026-04-24 13:50:11] run_shell (Run the project's declared aggregate validation script to determine current test status.): bun run check",
    "[worker-runner] [2026-04-24 13:50:15] run_shell result: exit=0 timed_out=false",
    "[worker-runner] [2026-04-24 13:50:15] stdout:",
    "PASS: managed bun runtime",
    "PASS: native purge gate",
  ].join("\n"));

  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
  });
  const result = await execute({
    name: "list_tasks",
    args: { limit: 5 },
    rawArguments: "{\"limit\":5}",
  });

  expect(result).toMatchObject({
    ok: true,
    tasks: [{
      task_id: "task-log-summary",
      status: "FAILED",
      request: "verify the project",
      has_result: false,
      has_log: true,
    }],
  });
  const task = (result as { tasks: Array<{ observed_result_preview: string | null }> }).tasks[0];
  expect(task.observed_result_preview).toContain("Root validation: passed");
});

test("get_task_result reports missing and completed task states", async () => {
  const taskDir = join(tempDir, "tasks", "task-2");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "FAILED");
  writeFileSync(join(taskDir, "result.md"), "boom");
  writeFileSync(join(taskDir, "log.txt"), "stderr tail");

  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
  });

  await expect(execute({
    name: "get_task_result",
    args: { task_id: "" },
    rawArguments: "{}",
  })).rejects.toThrow("get_task_result requires task_id");

  expect(await execute({
    name: "get_task_result",
    args: { task_id: "missing" },
    rawArguments: "{\"task_id\":\"missing\"}",
  })).toEqual({
    ok: false,
    task_id: "missing",
    error: "task not found",
  });

  expect(await execute({
    name: "get_task_result",
    args: { task_id: "task-2" },
    rawArguments: "{\"task_id\":\"task-2\"}",
  })).toEqual({
    ok: true,
    task_id: "task-2",
    status: "FAILED",
    work_mode: "failed",
    safe_to_report: true,
    completion_claim_allowed: false,
    guard_reason: "Only a failure report is safe; do not claim completion.",
    can_resume: false,
    user_summary: "worker task task-2: FAILED",
    next_step: "Answer from the durable result and observed log evidence.",
    result: "boom",
    observed_result: "boom",
    log_tail: "stderr tail",
    origin: null,
  });
});

test("get_task_result includes observed log summary when result file is empty", async () => {
  const taskDir = join(tempDir, "tasks", "task-log");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "FAILED");
  writeFileSync(join(taskDir, "log.txt"), [
    "[worker-runner] [2026-04-24 13:50:11] run_shell (Run the project's declared aggregate validation script to determine current test status.): bun run check",
    "[worker-runner] [2026-04-24 13:50:15] run_shell result: exit=0 timed_out=false",
    "[worker-runner] [2026-04-24 13:50:15] stdout:",
    "PASS: managed bun runtime",
    "PASS: native purge gate",
  ].join("\n"));

  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
  });

  const result = await execute({
    name: "get_task_result",
    args: { task_id: "task-log" },
    rawArguments: "{\"task_id\":\"task-log\"}",
  });

  expect(result).toMatchObject({
    ok: true,
    task_id: "task-log",
    status: "FAILED",
    result: null,
  });
  expect(String((result as Record<string, unknown>).observed_result)).toContain("Root validation: passed");
});

test("get_task_result exposes origin context for follow-up routing", async () => {
  const taskDir = join(tempDir, "tasks", "task-origin-result");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "DONE");
  writeFileSync(join(taskDir, "result.md"), "done");
  writeFileSync(join(taskDir, "origin.json"), `${JSON.stringify({
    version: 1,
    origin_session_id: "butler/main",
    origin_message_id: "101",
    origin_inbound_event_id: "mock:101",
    task_summary: "Topic A report",
    created_at: "2026-04-25T00:00:00.000Z",
    project: "fixtures/butler-project",
    topic_summary: "Topic A",
    transcript_ref: {
      session_id: "butler/main",
      path: "fixtures/butler-data/transcripts/butler_main.jsonl",
      origin_event_id: "mock:101",
      origin_message_id: "101",
      recent_event_ids: ["mock:101"],
    },
    memory_refs: [],
  }, null, 2)}\n`, "utf8");

  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
  });
  const result = await execute({
    name: "get_task_result",
    args: { task_id: "task-origin-result" },
    rawArguments: "{\"task_id\":\"task-origin-result\"}",
  });

  expect(result).toMatchObject({
    ok: true,
    task_id: "task-origin-result",
    origin: {
      origin_session_id: "butler/main",
      task_summary: "Topic A report",
      transcript_ref: {
        origin_event_id: "mock:101",
      },
    },
  });
});
