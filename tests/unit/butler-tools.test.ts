import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  BUTLER_TOOLS,
  createButlerToolExecutor,
  createButlerToolExecutorRegistry,
  satisfiedCompletionObligationsForToolResult,
} from "../../packages/butler-agent/src/agent/tools/butler-tools.ts";
import {
  diagnoseButlerToolPolicy,
  selectButlerToolProfiles,
  selectButlerToolsForTurn,
  toolContractJsonChars,
} from "../../packages/butler-agent/src/agent/tools/profiles.ts";
import {
  PROJECT_LEDGER_LIFECYCLE_TOOL_NAMES,
  PROJECT_LEDGER_MUTATION_TOOL_NAMES,
} from "../../packages/butler-agent/src/agent/tools/project-ledger/mutation-tools.ts";
import {
  createProjectLedgerNativeToolHandler,
  projectLedgerNativeToolDefinitions,
} from "../../packages/butler-agent/src/agent/tools/project-ledger/native.ts";
import { TodoListStore } from "../../packages/butler-agent/src/agent/work/todo-list.ts";
import { WorkStreamStore } from "../../packages/butler-agent/src/agent/work/work-stream.ts";
import {
  createWorkTrackingToolHandlers,
  WORK_TRACKING_TOOL_NAMES,
} from "../../packages/butler-agent/src/agent/tools/work-tracking/shared.ts";
import { DisabledWebSearchProvider, MockWebSearchProvider, readWebSearchMetrics } from "../../packages/butler-agent/src/integrations/search/provider.ts";
import { appendRuntimeTurnContextMetric } from "../../packages/butler-agent/src/operations/metrics/context-monitor.ts";
import { appendPromptCacheMetric } from "../../packages/butler-agent/src/integrations/providers/prompt-cache-metrics.ts";
import { retainToolEvidence } from "../../packages/butler-agent/src/agent/context/tool-evidence-retention.ts";
import { budgetToolOutput } from "../../packages/butler-agent/src/agent/context/tool-output-budgeter.ts";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";

let tempDir = "";
const root = process.cwd();
const projectLedgerCli = join(root, "packages", "project-ledger", "bin", "project-ledger");
const startupOnlyToolNames: string[] = [
  "get_context_monitor",
  "read_tool_evidence_artifact",
  "list_tool_capabilities",
  "tool_search",
  "tool_describe",
  "tool_call",
  "update_todo_list",
  "list_todo_list",
  "recall_memory",
  "read_conversation_context",
  "list_conversation_sessions",
  "read_conversation_session",
];
const projectLedgerToolNames: string[] = [
  "project_ledger_index",
  "project_ledger_status",
  "project_ledger_list",
  "project_ledger_show",
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
  "project_ledger_check",
];
const projectMetadataToolNames: string[] = [
  "project_ledger_status",
  "project_ledger_list",
  "project_ledger_show",
  "project_ledger_check",
  "inspect_project_status",
  "query_project_work",
  ...startupOnlyToolNames,
];
const projectLifecycleWorkspaceToolNames: string[] = [
  "run_command",
  "read_file",
  "write_file",
  "edit_file",
  "grep_files",
  "project_ledger_status",
  "project_ledger_list",
  "project_ledger_show",
  "project_ledger_work_update",
  "project_ledger_work_complete",
  "project_ledger_task_update",
  "project_ledger_task_complete",
  "project_ledger_attempt_start",
  "project_ledger_attempt_succeed",
  "project_ledger_attempt_fail",
  "project_ledger_check",
  "inspect_project_status",
  "query_project_work",
  "render_project_dashboard",
  "get_context_monitor",
  "read_tool_evidence_artifact",
  "read_tool_output_artifact",
  "list_tool_capabilities",
  "tool_search",
  "tool_describe",
  "tool_call",
  "update_todo_list",
  "list_todo_list",
  "recall_memory",
  "read_conversation_context",
  "list_conversation_sessions",
  "read_conversation_session",
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

function writeAppProjectDb(path: string, input: {
  id: string;
  displayName: string;
  workspacePath: string;
  ledgerProjectId?: string;
}): void {
  const db = new Database(path);
  db.run(`
    CREATE TABLE projects (
      id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      workspace_label TEXT NOT NULL,
      safe_path_label TEXT NOT NULL,
      ledger_project_id TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `);
  db.query(`
    INSERT INTO projects (
      id, display_name, workspace_path, workspace_label, safe_path_label,
      ledger_project_id, archived, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `).run(
    input.id,
    input.displayName,
    input.workspacePath,
    input.displayName,
    input.displayName,
    input.ledgerProjectId ?? input.id,
    new Date().toISOString(),
  );
  db.close(false);
}

test("Project Ledger tool wrappers inherit the active workspace when project_path is omitted", async () => {
  const butlerHome = join(tempDir, "butler-home");
  const butlerData = join(tempDir, "butler-data");
  const workspacePath = join(tempDir, "workspaces", "sandy-bot");
  const cliPath = join(butlerHome, "packages", "project-ledger", "bin", "project-ledger");
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(join(butlerHome, "packages", "project-ledger", "bin"), { recursive: true });
  writeFileSync(join(workspacePath, "package.json"), `${JSON.stringify({ name: "sandy-bot" })}\n`, "utf8");
  writeFileSync(
    cliPath,
    [
      "const argv = process.argv.slice(2);",
      "console.log(JSON.stringify({",
      "  ok: true,",
      "  command: argv.join(' '),",
      "  privacy: {},",
      "  data: { argv, counts: { work: 0 }, results: [] }",
      "}));",
      "",
    ].join("\n"),
    "utf8",
  );

  const execute = createButlerToolExecutor({
    butlerHome,
    butlerData,
    workspacePath,
  });
  const result = await execute({
    name: "inspect_project_status",
    args: {},
    rawArguments: "{}",
  }) as Record<string, any>;

  expect(result.ok).toBe(true);
  expect(result.data.argv).toEqual([
    "status",
    "--project",
    join(butlerData, "project-ledger", "projects", "sandy-bot"),
    "--json",
  ]);
});

test("Project Ledger tool wrappers resolve active app project id through the app registry", async () => {
  const butlerHome = join(tempDir, "butler-home");
  const butlerData = join(tempDir, "butler-data");
  const workspacePath = join(tempDir, "workspaces", "sandy-folder");
  const appDbPath = join(tempDir, "butler-client.sqlite");
  const cliPath = join(butlerHome, "packages", "project-ledger", "bin", "project-ledger");
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(join(butlerHome, "packages", "project-ledger", "bin"), { recursive: true });
  writeFileSync(join(workspacePath, "package.json"), `${JSON.stringify({ name: "sandy-bot" })}\n`, "utf8");
  writeAppProjectDb(appDbPath, {
    id: "project-sandy-bot-35a0e102",
    displayName: "Sandy Bot",
    workspacePath,
    ledgerProjectId: "sandy-bot",
  });
  writeFileSync(
    cliPath,
    "console.log(JSON.stringify({ ok: true, command: process.argv.slice(2).join(' '), privacy: {}, data: { argv: process.argv.slice(2) } }));\n",
    "utf8",
  );

  const execute = createButlerToolExecutor({
    butlerHome,
    butlerData,
    appMessageDbPath: appDbPath,
    projectId: "project-sandy-bot-35a0e102",
  });
  const result = await execute({
    name: "inspect_project_status",
    args: {},
    rawArguments: "{}",
  }) as Record<string, any>;

  expect(result.ok).toBe(true);
  expect(result.data.argv).toEqual([
    "status",
    "--project",
    join(
      butlerData,
      "project-ledger",
      "projects",
      "sandy-bot",
    ),
    "--json",
  ]);
});

test("Project Ledger read tools cannot leave the active App project", async () => {
  const butlerHome = join(tempDir, "butler-home");
  const butlerData = join(tempDir, "butler-data");
  const workspacePath = join(tempDir, "workspaces", "sandy-folder");
  const appDbPath = join(tempDir, "butler-client.sqlite");
  mkdirSync(workspacePath, { recursive: true });
  writeAppProjectDb(appDbPath, {
    id: "project-sandy-bot-35a0e102",
    displayName: "Sandy Bot",
    workspacePath,
    ledgerProjectId: "sandy-bot",
  });
  const execute = createButlerToolExecutor({
    butlerHome,
    butlerData,
    appMessageDbPath: appDbPath,
    projectId: "project-sandy-bot-35a0e102",
  });
  const calls = [
    { name: "project_ledger_status", args: { project_ref: "other-project" } },
    { name: "project_ledger_list", args: { project_path: workspacePath, kind: "work" } },
    { name: "project_ledger_show", args: { project_ref: "other-project", kind: "work", id: "W-OTHER" } },
  ];

  for (const call of calls) {
    const result = await execute({
      ...call,
      rawArguments: JSON.stringify(call.args),
    }) as Record<string, any>;
    expect(result).toEqual({
      ok: false,
      error: {
        code: "project_ledger_project_scope_mismatch",
        message: "Explicit Project Ledger reference must match the active project id or be omitted.",
      },
    });
  }

  await expect(execute({
    name: "inspect_project_status",
    args: { project_ref: "other-project" },
    rawArguments: "{\"project_ref\":\"other-project\"}",
  })).rejects.toThrow("Explicit Project Ledger reference must match the active project id or be omitted.");
});

test("Project Ledger native tools route task completion through task handlers", async () => {
  const projectPath = join(tempDir, "project-ledger", "projects", "butler");
  runProjectLedger(["init", "--id", "butler", "--name", "Butler"], projectPath);
  runProjectLedger(["work", "create", "--id", "W-SANDY", "--title", "Sandy work", "--status", "specified", "--spec-exemption", "--acceptance-exemption"], projectPath);
  runProjectLedger(["index"], projectPath);
  runProjectLedger(["task", "create", "--work", "W-SANDY", "--id", "T-SANDY", "--title", "Sandy task"], projectPath);
  runProjectLedger(["index"], projectPath);

  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    currentToolNames: ["project_ledger_status"],
    describedToolIds: ["native:project_ledger_work_complete", "native:project_ledger_task_complete"],
  });

  const wrongKind = await executor({
    name: "project_ledger_work_complete",
    args: {
      project_path: projectPath,
      id: "T-SANDY",
      validation: "validation evidence",
      review: "review evidence",
      report: "reports/sandy.md",
    },
    rawArguments: "{}",
  }) as { ok: boolean; recoverable?: boolean; error?: { code?: string; next?: string[] } };
  expect(wrongKind.ok).toBe(false);
  expect(wrongKind.recoverable).toBe(true);
  expect(wrongKind.error?.code).toBe("record_not_found");
  expect(JSON.stringify(wrongKind.error?.next)).toContain("project-ledger query --kind work");

  const legacyWrongKind = await executor({
    name: "complete_project_work",
    args: {
      project_path: projectPath,
      id: "T-SANDY",
      validation: "validation evidence",
      review: "review evidence",
      report: "reports/sandy.md",
    },
    rawArguments: "{}",
  }) as { ok: boolean; recoverable?: boolean; error?: { code?: string; next?: string[] } };
  expect(legacyWrongKind.ok).toBe(false);
  expect(legacyWrongKind.recoverable).toBe(true);
  expect(legacyWrongKind.error?.code).toBe("record_not_found");
  expect(JSON.stringify(legacyWrongKind.error?.next)).toContain("project-ledger query --kind work");

  const missingParent = await executor({
    name: "project_ledger_create",
    args: {
      project_path: projectPath,
      kind: "task",
      id: "T-MISSING-PARENT",
      title: "Missing parent task",
    },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    recoverable?: boolean;
    error?: { code?: string; next?: string[]; native_next?: Array<{ tool?: string; reason?: string }> };
  };
  expect(missingParent.ok).toBe(false);
  expect(missingParent.recoverable).toBe(true);
  expect(missingParent.error?.code).toBe("invalid_arguments");
  expect(JSON.stringify(missingParent.error?.native_next)).toContain("Correct required Project Ledger");

  const plannedTodoTask = await executor({
    name: "project_ledger_create",
    args: {
      project_path: projectPath,
      kind: "task",
      work_id: "W-SANDY",
      id: "T-PLANNED-TODO",
      title: "Planned todo task",
    },
    rawArguments: "{}",
  }) as { ok: boolean; data?: { id?: string; status?: string } };
  expect(plannedTodoTask.ok).toBe(true);
  expect(plannedTodoTask.data).toMatchObject({ id: "T-PLANNED-TODO", status: "todo" });

  const completedTodoTask = await executor({
    name: "project_ledger_task_complete",
    args: {
      project_path: projectPath,
      id: "T-PLANNED-TODO",
      validation: "validation evidence",
      review: "review evidence",
      report: "reports/planned-todo.md",
    },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    data?: { id?: string; kind?: string; status?: string };
    project_ledger_transition_plan?: { executed?: Array<{ command?: string }> };
  };
  expect(completedTodoTask.ok).toBe(true);
  expect(completedTodoTask.data).toMatchObject({ id: "T-PLANNED-TODO", kind: "task", status: "done" });
  expect(completedTodoTask.project_ledger_transition_plan?.executed).toEqual([
    { command: "task update --id T-PLANNED-TODO --status in_progress" },
    expect.objectContaining({ command: expect.stringContaining("task complete") }),
  ]);

  for (const status of ["blocked", "failed"] as const) {
    const id = `T-PLANNED-${status.toUpperCase()}`;
    const plannedTask = await executor({
      name: "project_ledger_create",
      args: {
        project_path: projectPath,
        kind: "task",
        work_id: "W-SANDY",
        id,
        title: `Planned ${status} task`,
        status,
      },
      rawArguments: "{}",
    }) as { ok: boolean; data?: { id?: string; status?: string } };
    expect(plannedTask.ok).toBe(true);
    expect(plannedTask.data).toMatchObject({ id, status });

    const completedTask = await executor({
      name: "project_ledger_task_complete",
      args: {
        project_path: projectPath,
        id,
        validation: "validation evidence",
        review: "review evidence",
        report: `reports/${id}.md`,
      },
      rawArguments: "{}",
    }) as {
      ok: boolean;
      data?: { id?: string; kind?: string; status?: string };
      project_ledger_transition_plan?: { executed?: Array<{ command?: string }> };
    };
    expect(completedTask.ok).toBe(true);
    expect(completedTask.data).toMatchObject({ id, kind: "task", status: "done" });
    expect(completedTask.project_ledger_transition_plan?.executed).toEqual([
      { command: `task update --id ${id} --status in_progress` },
      expect.objectContaining({ command: expect.stringContaining("task complete") }),
    ]);
  }

  const cancelledTask = await executor({
    name: "project_ledger_create",
    args: {
      project_path: projectPath,
      kind: "task",
      work_id: "W-SANDY",
      id: "T-PLANNED-CANCELLED",
      title: "Planned cancelled task",
      status: "cancelled",
    },
    rawArguments: "{}",
  }) as { ok: boolean; data?: { id?: string; status?: string } };
  expect(cancelledTask.ok).toBe(true);
  expect(cancelledTask.data).toMatchObject({ id: "T-PLANNED-CANCELLED", status: "cancelled" });
  const cancelledComplete = await executor({
    name: "project_ledger_task_complete",
    args: {
      project_path: projectPath,
      id: "T-PLANNED-CANCELLED",
      validation: "validation evidence",
      review: "review evidence",
      report: "reports/cancelled.md",
    },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    recoverable?: boolean;
    error?: { code?: string };
    project_ledger_transition_plan?: { refreshes?: number; executed?: Array<{ command?: string }> };
  };
  expect(cancelledComplete.ok).toBe(false);
  expect(cancelledComplete.recoverable).toBe(true);
  expect(cancelledComplete.error?.code).toBe("invalid_transition");
  expect(cancelledComplete.project_ledger_transition_plan).toMatchObject({
    refreshes: 1,
    executed: [expect.objectContaining({ command: expect.stringContaining("task complete") })],
  });

  const startedWork = await executor({
    name: "project_ledger_work_update",
    args: {
      project_path: projectPath,
      id: "W-SANDY",
      status: "in_progress",
    },
    rawArguments: "{}",
  }) as { ok: boolean; data?: { id?: string; kind?: string; status?: string } };
  expect(startedWork.ok).toBe(true);
  expect(startedWork.data).toMatchObject({ id: "W-SANDY", kind: "work", status: "in_progress" });

  const missingEvidenceWorkComplete = await executor({
    name: "project_ledger_work_complete",
    args: {
      project_path: projectPath,
      id: "W-SANDY",
      validation: "validation evidence",
      review: "review evidence",
    },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    recoverable?: boolean;
    error?: {
      code?: string;
      next?: Array<{ command?: string }>;
      native_next?: Array<{ tool?: string; args?: Record<string, string> }>;
    };
  };
  expect(missingEvidenceWorkComplete.ok).toBe(false);
  expect(missingEvidenceWorkComplete.recoverable).toBe(true);
  expect(missingEvidenceWorkComplete.error?.code).toBe("completion_gate_failed");
  expect(JSON.stringify(missingEvidenceWorkComplete.error)).toContain("missing_report");
  expect(missingEvidenceWorkComplete.error?.native_next).toContainEqual(expect.objectContaining({
    tool: "project_ledger_work_complete",
  }));

  runProjectLedger([
    "work",
    "create",
    "--id",
    "W-COMMIT-EVIDENCE",
    "--title",
    "Commit evidence work",
    "--status",
    "specified",
    "--spec-exemption",
    "--acceptance-exemption",
    "--requires-commit-evidence",
  ], projectPath);
  const missingCommitEvidence = await executor({
    name: "project_ledger_work_complete",
    args: {
      project_path: projectPath,
      id: "W-COMMIT-EVIDENCE",
      validation: "validation evidence",
      review: "review evidence",
      report: "reports/commit-evidence.md",
    },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    recoverable?: boolean;
    error?: { code?: string };
  };
  expect(missingCommitEvidence.ok).toBe(false);
  expect(missingCommitEvidence.recoverable).toBe(true);
  expect(missingCommitEvidence.error?.code).toBe("completion_gate_failed");
  expect(JSON.stringify(missingCommitEvidence.error)).toContain("missing_codeCommits");
  const unchangedCommitEvidenceWork = await executor({
    name: "project_ledger_show",
    args: {
      project_path: projectPath,
      kind: "work",
      id: "W-COMMIT-EVIDENCE",
    },
    rawArguments: "{}",
  }) as { ok: boolean; data?: { id?: string; status?: string } };
  expect(unchangedCommitEvidenceWork.ok).toBe(true);
  expect(unchangedCommitEvidenceWork.data).toMatchObject({ id: "W-COMMIT-EVIDENCE", status: "specified" });
  expect((unchangedCommitEvidenceWork as Record<string, any>).evidence_capability_receipts)
    .toEqual([expect.objectContaining({ capability: "source_verified", evidence_kind: "project_state" })]);

  const codeCommits = JSON.stringify([{ repo: "butler", hash: "abc123", message: "Task commit" }]);
  const completedCommitEvidenceWork = await executor({
    name: "project_ledger_work_complete",
    args: {
      project_path: projectPath,
      id: "W-COMMIT-EVIDENCE",
      validation: "validation evidence",
      review: "review evidence",
      report: "reports/commit-evidence.md",
      code_commits: codeCommits,
    },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    data?: { id?: string; status?: string; codeCommits?: string };
    project_ledger_transition_plan?: { executed?: Array<{ command?: string }> };
  };
  expect(completedCommitEvidenceWork.ok).toBe(true);
  expect(completedCommitEvidenceWork.data).toMatchObject({
    id: "W-COMMIT-EVIDENCE",
    status: "done",
    codeCommits,
  });
  expect(completedCommitEvidenceWork.project_ledger_transition_plan?.executed).toEqual([
    { command: "work update --id W-COMMIT-EVIDENCE --status in_progress" },
    { command: "work update --id W-COMMIT-EVIDENCE --status review" },
    expect.objectContaining({ command: expect.stringContaining("work complete") }),
  ]);

  const workCloseoutCases = [
    { id: "W-LEGAL-PROPOSED", status: "proposed", planned: ["scoped", "in_progress", "review"] },
    { id: "W-LEGAL-SCOPED", status: "scoped", planned: ["in_progress", "review"] },
    { id: "W-LEGAL-SPECIFIED", status: "specified", planned: ["in_progress", "review"] },
    { id: "W-LEGAL-IN-PROGRESS", status: "in_progress", planned: ["review"] },
    { id: "W-LEGAL-REVIEW", status: "review", planned: [] },
    { id: "W-LEGAL-BLOCKED", status: "blocked", planned: ["in_progress", "review"] },
  ];
  for (const closeoutCase of workCloseoutCases) {
    runProjectLedger([
      "work",
      "create",
      "--id",
      closeoutCase.id,
      "--title",
      closeoutCase.status,
      "--status",
      closeoutCase.status,
      "--spec-exemption",
      "--acceptance-exemption",
    ], projectPath);
    const plannedWorkComplete = await executor({
      name: "project_ledger_work_complete",
      args: {
        project_path: projectPath,
        id: closeoutCase.id,
        validation: "validation evidence",
        review: "review evidence",
        report: `reports/${closeoutCase.id}.md`,
      },
      rawArguments: "{}",
    }) as {
      ok: boolean;
      data?: { id?: string; kind?: string; status?: string };
      project_ledger_transition_plan?: { executed?: Array<{ command?: string }> };
    };
    expect(plannedWorkComplete.ok).toBe(true);
    expect(plannedWorkComplete.data).toMatchObject({ id: closeoutCase.id, kind: "work", status: "done" });
    expect(plannedWorkComplete.project_ledger_transition_plan?.executed).toEqual([
      ...closeoutCase.planned.map((status) => ({
        command: `work update --id ${closeoutCase.id} --status ${status}`,
      })),
      expect.objectContaining({ command: expect.stringContaining("work complete") }),
    ]);
  }

  const started = await executor({
    name: "project_ledger_task_update",
    args: {
      project_path: projectPath,
      id: "T-SANDY",
      status: "in_progress",
    },
    rawArguments: "{}",
  }) as { ok: boolean; data?: { id?: string; kind?: string; status?: string } };
  expect(started.ok).toBe(true);
  expect(started.data).toMatchObject({ id: "T-SANDY", kind: "task", status: "in_progress" });

  const completed = await executor({
    name: "project_ledger_task_complete",
    args: {
      project_path: projectPath,
      id: "T-SANDY",
      validation: "validation evidence",
      review: "review evidence",
      report: "reports/sandy.md",
    },
    rawArguments: "{}",
  }) as { ok: boolean; data?: { id?: string; kind?: string; status?: string } };
  expect(completed.ok).toBe(true);
  expect(completed.data).toMatchObject({ id: "T-SANDY", kind: "task", status: "done" });
}, 15_000);

test("Project Ledger mutation policy covers every mutating native Project Ledger tool", () => {
  const mutatingNativeLedgerTools = projectLedgerNativeToolDefinitions
    .filter((tool) => !tool.concurrencySafe)
    .map((tool) => tool.name)
    .sort();

  const expectedMutationTools: string[] = [...PROJECT_LEDGER_MUTATION_TOOL_NAMES]
    .filter((name) => name.startsWith("project_ledger_"))
    .sort();
  expect(expectedMutationTools).toEqual(mutatingNativeLedgerTools);
  expect(PROJECT_LEDGER_MUTATION_TOOL_NAMES).toEqual(expect.arrayContaining([
    "render_project_dashboard",
    "complete_project_work",
  ]));
});

test("Butler tool registry exposes stable native tool contracts", () => {
  expect(BUTLER_TOOLS.map((tool) => tool.name)).toEqual([
    "web_search",
    "web_read",
    "transform_public_data_table",
    "run_command",
    "read_file",
    "write_file",
    "edit_file",
    "grep_files",
    "inspect_workspace_page",
    ...projectLedgerToolNames,
    "get_work_dashboard",
    "inspect_project_status",
    "query_project_work",
    "render_project_dashboard",
    "complete_project_work",
    "get_context_monitor",
    "read_tool_evidence_artifact",
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
    "list_conversation_sessions",
    "read_conversation_session",
    "update_explicit_memory",
    "list_skills",
  ]);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "web_search")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "web_read")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "transform_public_data_table")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "run_command")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "edit_file")?.concurrencySafe).toBe(false);
  for (const name of projectLedgerToolNames) {
    expect(BUTLER_TOOLS.find((tool) => tool.name === name)).toBeDefined();
  }
  expect(BUTLER_TOOLS.find((tool) => tool.name === "project_ledger_status")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "project_ledger_list")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "project_ledger_show")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "project_ledger_index")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "project_ledger_create")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "project_ledger_update")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "project_ledger_work_complete")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "project_ledger_task_complete")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "project_ledger_check")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "get_work_dashboard")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "inspect_project_status")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "query_project_work")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "render_project_dashboard")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "complete_project_work")?.concurrencySafe).toBe(false);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "get_context_monitor")?.concurrencySafe).toBe(true);
  expect(BUTLER_TOOLS.find((tool) => tool.name === "read_tool_evidence_artifact")?.concurrencySafe).toBe(true);
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
  expect(BUTLER_TOOLS.every((tool) => tool.transcriptVisibility === "visible")).toBe(true);
  const onboardingTool = BUTLER_TOOLS.find((tool) => tool.name === "update_onboarding_profile");
  const onboardingProperties = onboardingTool?.parameters.properties as Record<string, unknown> | undefined;
  const personaPresetProperty = onboardingProperties?.persona_preset as { enum?: unknown; description?: unknown } | undefined;
  expect(personaPresetProperty?.enum).toBeUndefined();
  expect(String(personaPresetProperty?.description)).toContain("persona_preset id");
});

test("Project Ledger completion schema makes automatic Git evidence the canonical model path", () => {
  const definition = projectLedgerNativeToolDefinitions.find((tool) =>
    tool.name === "project_ledger_work_complete",
  );
  const properties = definition?.parameters.properties as
    | Record<string, Record<string, unknown>>
    | undefined;

  expect(properties?.code_commit).toMatchObject({
    type: "string",
    enum: ["auto"],
  });
  expect(String(properties?.code_commit?.description)).toContain("never pass a SHA");
  expect(String(properties?.code_commits?.description)).toContain('"repo", "hash", and "message"');
  expect(definition?.description).toContain('code_commit:"auto"');
});

test("Project Ledger auto evidence degrades without blocking Butler when Git is missing", async () => {
  const originalPath = process.env.PATH;
  const originalGitExecutable = process.env.BUTLER_GIT_EXECUTABLE;
  process.env.PATH = "";
  process.env.BUTLER_GIT_EXECUTABLE = join(tempDir, "missing-git-executable");
  try {
    const execute = createProjectLedgerNativeToolHandler({
      butlerHome: tempDir,
      butlerData: tempDir,
      workspacePath: tempDir,
    }, "project_ledger_work_complete");
    const result = await execute({
      args: {
        id: "W-NO-GIT",
        validation: "validated",
        review: "reviewed",
        report: "reported",
        code_commit: "auto",
      },
    }) as Record<string, any>;

    expect(result).toMatchObject({
      ok: false,
      recoverable: true,
      butler_operational: true,
      git_features_available: false,
      error: {
        code: "git_not_installed",
        install_url: "https://git-scm.com/downloads",
      },
    });
    expect(result.error.native_next).toBeUndefined();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalGitExecutable === undefined) {
      delete process.env.BUTLER_GIT_EXECUTABLE;
    } else {
      process.env.BUTLER_GIT_EXECUTABLE = originalGitExecutable;
    }
  }
});

test("work-tracking runtime ownership list matches handler keys", () => {
  const handlers = createWorkTrackingToolHandlers({
    butlerData: tempDir,
    sessionId: "butler/main/work-tracking-ownership",
    todoListStore: new TodoListStore(tempDir),
    workStreamStore: new WorkStreamStore(tempDir),
  });

  const ownedToolNames: string[] = Array.from(WORK_TRACKING_TOOL_NAMES);
  const handlerNames: string[] = Object.keys(handlers);
  expect(ownedToolNames).toEqual(handlerNames);
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
    "project-ledger",
    "run-command",
    "skills",
    "tool-bridge",
    "web-read",
    "web-search",
    "work-tracking",
    "workspace-page-preview",
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
  expect(executorSource).toContain("executeRegisteredButlerTool(");
  expect(executorSource).toContain("toolExecutorRef.current!,\n      prepared");
  expect(executorSource).toContain("input.executionBoundary");
  expect(executorSource).not.toMatch(/if\s*\(\s*call\.name\s*===/u);
});

test("Butler tool compatibility entrypoint does not own capability executor bodies", () => {
  const source = readFileSync(
    join(root, "packages", "butler-agent", "src", "agent", "tools", "butler-tools.ts"),
    "utf8",
  );
  const lineCount = source.split("\n").length;
  expect(lineCount).toBeLessThanOrEqual(300);
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
  // Direct Conception recall plus canonical session list/read are intentionally
  // part of the default surface; keep the expanded contract bounded.
  expect(toolContractJsonChars(tools)).toBeLessThan(16_000);
});

test("project sessions keep Project Ledger lifecycle tools hidden for status-only wording", () => {
  const prompts = [
    "Project Ledger 처리 현황만 확인해줘.",
    "Project Ledger update status만 확인해줘.",
    "코드 수정 방향만 검토해줘.",
    [
      "Local private Butler workspace E2E toolchain check.",
      "Complete the work in one turn. Use the available local Butler tools; do not ask the user a follow-up question.",
      "1. Inspect local Project Ledger status for workspace path: /tmp/project",
      "2. Query local Project Ledger work with kind: next-actions for workspace path: /tmp/project",
      "3. Render the local Project Ledger dashboard with view: dashboard, write: true, workspace path: /tmp/project",
    ].join("\n"),
  ];

  for (const text of prompts) {
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
    })).not.toContain("project-lifecycle");
    expect(names).toContain("project_ledger_status");
    expect(names).not.toContain("project_ledger_work_update");
    expect(names).not.toContain("project_ledger_work_complete");
    expect(names).not.toContain("project_ledger_task_update");
    expect(names).not.toContain("project_ledger_task_complete");
  }
});

test("Korean Project Ledger registration prompts require explicit workspace policy", () => {
  const text = "그럼 이 목록들을 정리해서 다음 Feature 작업들로 등록하자. Project ledger에 등록해두고, github issue도 열어서 연결해놔. 각 phase가 work가 되고, 각 세부 구현이 task되겠지? 각 단계별로 세부적으로 스펙 작성해.";
  const tools = selectButlerToolsForTurn({
    role: "butler",
    text,
    sessionMetadata: { projectId: "butler" },
    turnMetadata: {
      runtimePolicy: {
        requiredNativeToolProfiles: ["workspace", "project-lifecycle"],
        tracking_mode: "ledger",
        runtime_phase: "closeout_planned",
        validation_state: "validation_passed",
      },
    },
  });
  const names = tools.map((tool) => tool.name);

  expect(selectButlerToolProfiles({
    role: "butler",
    text,
    sessionMetadata: { projectId: "butler" },
    turnMetadata: {
      runtimePolicy: {
        requiredNativeToolProfiles: ["workspace", "project-lifecycle"],
        tracking_mode: "ledger",
        runtime_phase: "closeout_planned",
        validation_state: "validation_passed",
      },
    },
  })).toEqual(["startup", "project", "project-lifecycle", "workspace"]);
  expect(names).toEqual(projectLifecycleWorkspaceToolNames);
  expect(names).not.toContain("web_search");
  expect(names).not.toContain("web_read");
  expect(names).not.toContain("create_automation");
  expect(names).not.toContain("call_mcp_tool");
  // The workspace surface carries the same default memory-reference contract.
  expect(toolContractJsonChars(tools)).toBeLessThan(31_000);
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

test("tool profile selector keeps multilingual prompt wording out of routing decisions", () => {
  const promptTexts = [
    "요즘 공개 자료를 확인해서 알려줘.",
    "Please research the current release state.",
    "Veuillez rechercher les informations recentes.",
    "最近の公開情報を調べてください。",
  ];

  for (const text of promptTexts) {
    const profiles = selectButlerToolProfiles({ role: "butler", text });
    const tools = selectButlerToolsForTurn({ role: "butler", text });
    const names = tools.map((tool) => tool.name);

    expect(profiles).toEqual(["startup"]);
    expect(names).toEqual(startupOnlyToolNames);
  }
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

test("free-form Project Ledger linkage text alone keeps startup-only tools", () => {
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
  expect(names).not.toContain("project_ledger_status");
  expect(names).not.toContain("run_command");
});

test("Project Ledger runtime metadata exposes the bounded project profile without text matching", () => {
  const tools = selectButlerToolsForTurn({
    role: "butler",
    text: "상태와 next action을 확인하고 dashboard를 갱신해줘.",
    turnMetadata: { runtimePolicy: { tracking_mode: "ledger" } },
  });
  const names = tools.map((tool) => tool.name);

  expect(selectButlerToolProfiles({
    role: "butler",
    text: "상태와 next action을 확인하고 dashboard를 갱신해줘.",
    turnMetadata: { runtimePolicy: { tracking_mode: "ledger" } },
  })).toEqual(["startup", "project"]);
  expect(names).toContain("project_ledger_status");
  expect(names).toContain("project_ledger_list");
  expect(names).toContain("project_ledger_show");
  expect(names).toContain("inspect_project_status");
  expect(names).toContain("query_project_work");
  expect(names).toContain("render_project_dashboard");
  expect(names).toContain("project_ledger_check");
  expect(names).not.toContain("project_ledger_work_update");
  expect(names).not.toContain("project_ledger_work_complete");
  expect(names).not.toContain("project_ledger_task_update");
  expect(names).not.toContain("project_ledger_task_complete");
  expect(names).not.toContain("project_ledger_create");
  expect(names).not.toContain("get_weather_with_knowhow");
  expect(toolContractJsonChars(tools)).toBeLessThan(toolContractJsonChars(BUTLER_TOOLS));
});

test("Project Ledger project sessions expose lifecycle tools whenever Ledger tracked", () => {
  const tools = selectButlerToolsForTurn({
    role: "butler",
    text: "이어서 계속 진행해줘.",
    sessionMetadata: { projectId: "butler" },
    turnMetadata: {
      runtimePolicy: {
        requiredNativeToolProfiles: ["project-lifecycle"],
        tracking_mode: "ledger",
      },
    },
  });
  const names = tools.map((tool) => tool.name);

  expect(names).toContain("inspect_project_status");
  expect(names).toContain("project_ledger_status");
  expect(names).toContain("project_ledger_task_update");
  expect(names).toContain("project_ledger_task_complete");
  expect(names).toContain("project_ledger_work_update");
  expect(names).toContain("project_ledger_work_complete");
  expect(names).toContain("project_ledger_attempt_start");
  expect(names).toContain("project_ledger_attempt_succeed");
  expect(names).toContain("project_ledger_attempt_fail");
  expect(names).toContain("project_ledger_check");
  expect(names).toContain("query_project_work");
  expect(names).toContain("render_project_dashboard");
  expect(names).not.toContain("complete_project_work");
});

test("Ledger-tracked app sessions expose Project Ledger read tools from runtime policy alone", () => {
  const runtimePolicy = {
    accessMode: "full_access",
    trackingMode: "ledger",
    tracking_mode: "ledger",
    trackingModeSource: "app_project_default",
    tracking_mode_source: "app_project_default",
    closeoutStrategy: "ledger",
    closeout_strategy: "ledger",
    requiredNativeTools: [],
    required_tools: [],
    requiredNativeToolProfiles: ["project-lifecycle", "workspace"],
  };
  const tools = selectButlerToolsForTurn({
    role: "butler",
    text: "진행해",
    sessionMetadata: {
      source: "app-server",
      appSessionKind: "project",
      accessMode: "full_access",
      requiredNativeToolProfiles: ["project-lifecycle", "workspace"],
      runtimePolicy,
    },
  });
  const names = tools.map((tool) => tool.name);

  expect(selectButlerToolProfiles({
    role: "butler",
    text: "진행해",
    sessionMetadata: {
      source: "app-server",
      appSessionKind: "project",
      accessMode: "full_access",
      requiredNativeToolProfiles: ["project-lifecycle", "workspace"],
      runtimePolicy,
    },
  })).toEqual(["startup", "project", "project-lifecycle", "workspace"]);
  expect(names).toContain("project_ledger_status");
  expect(names).toContain("inspect_project_status");
  expect(names).toContain("query_project_work");
  expect(names).toContain("project_ledger_work_complete");
  expect(names).toContain("project_ledger_task_complete");
  expect(names).toContain("run_command");
  expect(names).toContain("read_file");
});

test("Project Ledger tools stay hidden in local and none tracking modes", () => {
  for (const trackingMode of ["local", "none"]) {
    const tools = selectButlerToolsForTurn({
      role: "butler",
      text: "Project Ledger task T-1 complete 처리해줘.",
      sessionMetadata: { projectId: "butler" },
      turnMetadata: {
        runtimePolicy: {
          requiredNativeToolProfiles: ["project-lifecycle"],
          requiredNativeTools: [
            "project_ledger_task_complete",
            "project_ledger_attempt_succeed",
          ],
          tracking_mode: trackingMode,
          runtime_phase: "closeout_planned",
          validation_state: "validation_passed",
        },
      },
    });
    const names = tools.map((tool) => tool.name);

    expect(names.some((name) => name.startsWith("project_ledger_"))).toBe(false);
    expect(names).not.toContain("query_project_work");
    expect(names).not.toContain("inspect_project_status");
    expect(names).not.toContain("render_project_dashboard");
    for (const toolName of PROJECT_LEDGER_LIFECYCLE_TOOL_NAMES) {
      expect(names).not.toContain(toolName);
    }
  }
});

test("Project Ledger lifecycle tools are not hidden by phase or validation metadata in Ledger mode", () => {
  const policies = [
    { runtime_phase: "validation", validation_state: "validation_passed" },
    { runtime_phase: "closeout_planned", validation_state: "validation_repair" },
    { runtime_phase: "closeout_planned", validation_state: "validation_failed" },
  ];

  for (const runtimePolicy of policies) {
    const tools = selectButlerToolsForTurn({
      role: "butler",
      text: "이어서 계속 진행해줘.",
      sessionMetadata: { projectId: "butler" },
      turnMetadata: {
        runtimePolicy: {
          requiredNativeToolProfiles: ["project-lifecycle"],
          tracking_mode: "ledger",
          ...runtimePolicy,
        },
      },
    });

    const names = tools.map((tool) => tool.name);
    for (const toolName of PROJECT_LEDGER_LIFECYCLE_TOOL_NAMES) {
      expect(names).toContain(toolName);
    }
  }
});

test("Project Ledger generic mutation tools require the same structured closeout gate", () => {
  const tools = selectButlerToolsForTurn({
    role: "butler",
    text: "Project Ledger task T-1 상태를 정리하고 렌더해줘.",
    sessionMetadata: { projectId: "butler" },
    turnMetadata: {
      runtimePolicy: {
        requiredNativeTools: [
          "project_ledger_index",
          "project_ledger_update",
          "project_ledger_render",
        ],
        tracking_mode: "ledger",
        runtime_phase: "closeout_planned",
        validation_state: "validation_passed",
      },
    },
  });
  const names = tools.map((tool) => tool.name);

  expect(names).toContain("project_ledger_index");
  expect(names).toContain("project_ledger_update");
  expect(names).toContain("project_ledger_render");
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

test("web_search schema exposes query and domain filters", () => {
  const tool = BUTLER_TOOLS.find((item) => item.name === "web_search");
  const properties = tool?.parameters.properties as Record<
    string,
    { description?: string }
  > | undefined;

  expect(tool?.parameters.required).toEqual(["query"]);
  expect(Object.keys(tool?.parameters.properties ?? {})).toEqual([
    "query",
    "allowed_domains",
    "blocked_domains",
    "recency_days",
    "max_results",
  ]);
  expect(properties?.allowed_domains?.description)
    .toContain("Strict result filter for every planned search");
  expect(properties?.allowed_domains?.description)
    .toContain("Omit it for broad or multi-source research");
  expect(tool?.description)
    .toContain("broaden the query or use another accessible authoritative");
});

test("web_read schema exposes bounded page evidence controls", () => {
  const tool = BUTLER_TOOLS.find((item) => item.name === "web_read");
  const properties = tool?.parameters.properties as Record<string, Record<string, unknown>>;

  expect(tool?.parameters.required).toEqual(["url"]);
  expect(Object.keys(tool?.parameters.properties ?? {})).toEqual([
    "url",
    "max_chars",
    "max_chunks",
    "start_chunk",
    "backend",
  ]);
  expect(properties.max_chars).toMatchObject({ minimum: 1_500, maximum: 8_000, default: 2_000 });
  expect(properties.max_chunks).toMatchObject({ minimum: 1, maximum: 8, default: 1 });
  expect(properties.start_chunk).toMatchObject({ minimum: 0, default: 0 });
  expect(properties.max_chars.description).toContain("Use start_chunk");
  expect(properties.start_chunk.description).toContain("next_start_chunk");
  expect(tool?.description).toContain("content_has_more");
  expect(tool?.description).toContain("next_start_chunk");
  expect(tool?.description)
    .toContain("search for an accessible source covering the same requested fact");
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

test("run_command schema exposes bounded platform-neutral command execution", () => {
  const tool = BUTLER_TOOLS.find((item) => item.name === "run_command");

  expect(tool?.parameters.required).toEqual(["command", "summary"]);
  expect(Object.keys(tool?.parameters.properties ?? {})).toEqual([
    "command",
    "summary",
    "cwd",
    "timeout_ms",
    "max_output_tokens",
    "output_paths",
    "validation_suite",
    "state_effect",
    "output_mode",
  ]);
  expect(tool?.description).toContain("platform-neutral command executor");
  const properties = tool?.parameters.properties as Record<string, unknown> | undefined;
  expect(properties?.summary).toMatchObject({
    type: "string",
    minLength: 1,
  });
  expect((properties?.summary as { description?: string }).description?.toLowerCase())
    .toContain("presentation only");
  expect(properties?.output_paths).toMatchObject({
    type: "array",
  });
  expect(properties?.output_mode).toMatchObject({
    type: "string",
    enum: ["auto", "silent_on_success", "full"],
  });
  expect(properties?.validation_suite).toMatchObject({
    type: "string",
  });
  expect(properties?.state_effect).toMatchObject({
    type: "string",
    enum: ["read_only", "mutation", "validation", "remote_observation"],
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

test("run_command rejects direct Project Ledger writes through shell redirection", async () => {
  const workspace = join(tempDir, "workspace");
  const ledgerFile = join(workspace, ".project-ledger", "specs", "feature.md");
  mkdirSync(join(workspace, ".project-ledger", "specs"), { recursive: true });
  writeFileSync(ledgerFile, "old", "utf8");
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });

  const result = await executor({
    name: "run_command",
    args: {
      command: "printf 'new\\n' > .project-ledger/specs/feature.md",
    },
    rawArguments: "{}",
  }) as any;

  expect(result.ok).toBe(false);
  expect(result.error).toBe("protected_path");
  expect(result.stderr).toContain("Project Ledger");
  expect(result.next[0].command).toContain("project-ledger");
  expect(readFileSync(ledgerFile, "utf8")).toBe("old");
});

test("run_command rejects raw Project Ledger source inspection", async () => {
  const workspace = join(tempDir, "workspace");
  const dataLedgerFile = join(tempDir, "project-ledger", "projects", "demo", "specs", "feature.md");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(tempDir, "project-ledger", "projects", "demo", "specs"), { recursive: true });
  writeFileSync(dataLedgerFile, "source", "utf8");
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });

  const result = await executor({
    name: "run_command",
    args: {
      command: "cat \"$BUTLER_DATA/project-ledger/projects/demo/specs/feature.md\"",
    },
    rawArguments: "{}",
  }) as any;

  expect(result.ok).toBe(false);
  expect(result.error).toBe("protected_path");
  expect(result.stderr).toContain("Project Ledger");
});

test("file tools reject raw Butler data Project Ledger source inspection", async () => {
  const workspace = join(tempDir, "workspace");
  const dataLedgerFile = join(tempDir, "project-ledger", "projects", "demo", "specs", "feature.md");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(tempDir, "project-ledger", "projects", "demo", "specs"), { recursive: true });
  writeFileSync(dataLedgerFile, "source", "utf8");
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });

  const readResult = await executor({
    name: "read_file",
    args: {
      workspace_root: tempDir,
      path: "project-ledger/projects/demo/specs/feature.md",
    },
    rawArguments: "{}",
  }) as any;
  expect(readResult.ok).toBe(false);
  expect(readResult.error).toBe("protected_path");

  const grepResult = await executor({
    name: "grep_files",
    args: {
      workspace_root: tempDir,
      pattern: "source",
    },
    rawArguments: "{}",
  }) as any;
  expect(grepResult.ok).toBe(true);
  expect(grepResult.matches).toEqual([]);
});

test("run_command rejects ad hoc scripts writing Butler data-home Project Ledger records", async () => {
  const workspace = join(tempDir, "workspace");
  const dataLedgerFile = join(tempDir, "project-ledger", "projects", "demo", "specs", "feature.md");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(tempDir, "project-ledger", "projects", "demo", "specs"), { recursive: true });
  writeFileSync(dataLedgerFile, "old", "utf8");
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });

  const result = await executor({
    name: "run_command",
    args: {
      command: `node -e "require('fs').writeFileSync('${dataLedgerFile}', 'new')"`,
    },
    rawArguments: "{}",
  }) as any;

  expect(result.ok).toBe(false);
  expect(result.error).toBe("protected_path");
  expect(result.protected_path).toContain("project-ledger/projects/demo");
  expect(readFileSync(dataLedgerFile, "utf8")).toBe("old");
});

test("run_command rejects direct Project Ledger writes through truncate and dd", async () => {
  const workspace = join(tempDir, "workspace");
  const ledgerFile = join(workspace, ".project-ledger", "specs", "feature.md");
  mkdirSync(join(workspace, ".project-ledger", "specs"), { recursive: true });
  writeFileSync(ledgerFile, "old", "utf8");
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });

  const truncateResult = await executor({
    name: "run_command",
    args: { command: "truncate -s 0 .project-ledger/specs/feature.md" },
    rawArguments: "{}",
  }) as any;
  expect(truncateResult.ok).toBe(false);
  expect(truncateResult.error).toBe("protected_path");
  expect(readFileSync(ledgerFile, "utf8")).toBe("old");

  const ddResult = await executor({
    name: "run_command",
    args: { command: "printf new | dd of=.project-ledger/specs/feature.md status=none" },
    rawArguments: "{}",
  }) as any;
  expect(ddResult.ok).toBe(false);
  expect(ddResult.error).toBe("protected_path");
  expect(readFileSync(ledgerFile, "utf8")).toBe("old");

  const findDeleteResult = await executor({
    name: "run_command",
    args: { command: "find .project-ledger/specs -type f -delete" },
    rawArguments: "{}",
  }) as any;
  expect(findDeleteResult.ok).toBe(false);
  expect(findDeleteResult.error).toBe("protected_path");
  expect(readFileSync(ledgerFile, "utf8")).toBe("old");
});

test("run_command restores Project Ledger writes hidden behind expression-built paths", async () => {
  const workspace = join(tempDir, "workspace");
  const workspaceLedgerFile = join(workspace, ".project-ledger", "specs", "feature.md");
  const dataLedgerFile = join(tempDir, "project-ledger", "projects", "demo", "specs", "feature.md");
  mkdirSync(join(workspace, ".project-ledger", "specs"), { recursive: true });
  mkdirSync(join(tempDir, "project-ledger", "projects", "demo", "specs"), { recursive: true });
  writeFileSync(workspaceLedgerFile, "old-workspace", "utf8");
  writeFileSync(dataLedgerFile, "old-data", "utf8");
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });

  const dataHomeResult = await executor({
    name: "run_command",
    args: {
      command: "node -e \"require('fs').writeFileSync(process.env.BUTLER_DATA + '/project-ledger/projects/demo/specs/feature.md', 'new')\"",
    },
    rawArguments: "{}",
  }) as any;
  expect(dataHomeResult.ok).toBe(false);
  expect(dataHomeResult.error).toBe("protected_path");
  expect(readFileSync(dataLedgerFile, "utf8")).toBe("old-data");

  const workspaceResult = await executor({
    name: "run_command",
    args: {
      command: "node -e \"const fs=require('fs'); const p=process.cwd()+['/.project','-ledger/specs/feature.md'].join(''); fs.writeFileSync(p, 'new')\"",
    },
    rawArguments: "{}",
  }) as any;
  expect(workspaceResult.ok).toBe(false);
  expect(workspaceResult.error).toBe("protected_path");
  expect(readFileSync(workspaceLedgerFile, "utf8")).toBe("old-workspace");

  const mentionResult = await executor({
    name: "run_command",
    args: {
      command: "echo pl && node -e \"const fs=require('fs'); const p=process.cwd()+['/.project','-ledger/specs/feature.md'].join(''); fs.writeFileSync(p, 'new')\"",
    },
    rawArguments: "{}",
  }) as any;
  expect(mentionResult.ok).toBe(false);
  expect(mentionResult.error).toBe("protected_path");
  expect(readFileSync(workspaceLedgerFile, "utf8")).toBe("old-workspace");
});

test("run_command protects fallback home Project Ledger records", async () => {
  const workspace = join(tempDir, "workspace");
  const fakeHome = join(tempDir, "fake-home");
  const homeLedgerFile = join(fakeHome, ".butler", "project-ledger", "projects", "demo", "specs", "feature.md");
  const previousHome = process.env.HOME;
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(fakeHome, ".butler", "project-ledger", "projects", "demo", "specs"), { recursive: true });
  writeFileSync(homeLedgerFile, "old-home", "utf8");
  process.env.HOME = fakeHome;
  try {
    const executor = createButlerToolExecutor({
      butlerHome: root,
      butlerData: tempDir,
      workspacePath: workspace,
    });

    const result = await executor({
      name: "run_command",
      args: {
        command: "printf new-home > \"$HOME/.butler/project-ledger/projects/demo/specs/feature.md\"",
      },
      rawArguments: "{}",
    }) as any;

    expect(result.ok).toBe(false);
    expect(readFileSync(homeLedgerFile, "utf8")).toBe("old-home");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("run_command leaves Project Ledger unchanged after detached delayed writes", async () => {
  const workspace = join(tempDir, "workspace");
  const ledgerFile = join(workspace, ".project-ledger", "specs", "feature.md");
  mkdirSync(join(workspace, ".project-ledger", "specs"), { recursive: true });
  writeFileSync(ledgerFile, "old", "utf8");
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });
  const delayedCommand = [
    "node -e '",
    "const { spawn } = require(\"child_process\");",
    "const suffix = String.fromCharCode(47,46,112,114,111,106,101,99,116,45,108,101,100,103,101,114,47,115,112,101,99,115,47,102,101,97,116,117,114,101,46,109,100);",
    "const code = \"setTimeout(() => require(\\\"fs\\\").writeFileSync(process.cwd() + \" + JSON.stringify(suffix) + \", \\\"delayed-new\\\"), 700)\";",
    "spawn(process.execPath, [\"-e\", code], { detached: true, stdio: \"ignore\" }).unref();",
    "'",
  ].join(" ");

  const result = await executor({
    name: "run_command",
    args: { command: delayedCommand },
    rawArguments: "{}",
  }) as any;

  expect(result.ok).toBe(false);
  expect(result.error).toBe("protected_path");
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  expect(readFileSync(ledgerFile, "utf8")).toBe("old");
});

test("run_command rejects obfuscated detached Project Ledger writers before execution", async () => {
  const workspace = join(tempDir, "workspace");
  const fakeHome = join(tempDir, "fake-home");
  const workspaceLedgerFile = join(workspace, ".project-ledger", "specs", "feature.md");
  const dataLedgerFile = join(tempDir, "project-ledger", "projects", "demo", "specs", "feature.md");
  const homeLedgerFile = join(fakeHome, ".butler", "project-ledger", "projects", "demo", "specs", "feature.md");
  const previousHome = process.env.HOME;
  mkdirSync(join(workspace, ".project-ledger", "specs"), { recursive: true });
  mkdirSync(join(tempDir, "project-ledger", "projects", "demo", "specs"), { recursive: true });
  mkdirSync(join(fakeHome, ".butler", "project-ledger", "projects", "demo", "specs"), { recursive: true });
  writeFileSync(workspaceLedgerFile, "old-workspace", "utf8");
  writeFileSync(dataLedgerFile, "old-data", "utf8");
  writeFileSync(homeLedgerFile, "old-home", "utf8");
  process.env.HOME = fakeHome;
  try {
    const executor = createButlerToolExecutor({
      butlerHome: root,
      butlerData: tempDir,
      workspacePath: workspace,
    });
    const suffixCode = "String.fromCharCode(47,46,112,114,111,106,101,99,116,45,108,101,100,103,101,114,47,115,112,101,99,115,47,102,101,97,116,117,114,101,46,109,100)";
    const cases = [
      {
        command: `node -e "const {spawn}=require('child_process'); const code='setTimeout(()=>require(\\'fs\\').writeFileSync(process[\\'cw\\'+\\'d\\']()+${suffixCode}, \\'late\\'), 700)'; spawn(process.execPath, ['-e', code], {detached:true, stdio:'ignore'}).unref()"`,
        path: workspaceLedgerFile,
        old: "old-workspace",
      },
      {
        command: "node -e \"const {spawn}=require('child_process'); const code='setTimeout(()=>require(\\'fs\\').writeFileSync(process.env[\\'BUTLER\\'+\\'_DATA\\'] + \\'/project-ledger/projects/demo/specs/feature.md\\', \\'late\\'), 700)'; spawn(process.execPath, ['-e', code], {detached:true, stdio:'ignore'}).unref()\"",
        path: dataLedgerFile,
        old: "old-data",
      },
      {
        command: "node -e \"const {spawn}=require('child_process'); const code='setTimeout(()=>require(\\'fs\\').writeFileSync(process.env[\\'HO\\'+\\'ME\\'] + \\'/.butler/project-ledger/projects/demo/specs/feature.md\\', \\'late\\'), 700)'; spawn(process.execPath, ['-e', code], {detached:true, stdio:'ignore'}).unref()\"",
        path: homeLedgerFile,
        old: "old-home",
      },
    ];

    for (const item of cases) {
      const result = await executor({
        name: "run_command",
        args: { command: item.command },
        rawArguments: "{}",
      }) as any;
      expect(result.ok).toBe(false);
      expect(result.error).toBe("protected_path");
    }
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    for (const item of cases) expect(readFileSync(item.path, "utf8")).toBe(item.old);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("run_command restores non-write-named filesystem API Project Ledger mutations", async () => {
  const workspace = join(tempDir, "workspace");
  const fakeHome = join(tempDir, "fake-home");
  const workspaceLedgerFile = join(workspace, ".project-ledger", "specs", "feature.md");
  const dataLedgerFile = join(tempDir, "project-ledger", "projects", "demo", "specs", "feature.md");
  const homeLedgerFile = join(fakeHome, ".butler", "project-ledger", "projects", "demo", "specs", "feature.md");
  const workspaceGeneratedDir = join(workspace, ".project-ledger", "specs", "generated");
  const workspaceEmptyDir = join(workspace, ".project-ledger", "specs", "empty-dir");
  const workspaceMovedFile = join(workspace, ".project-ledger", "specs", "moved.md");
  const workspaceCopiedDir = join(workspace, ".project-ledger", "specs", "copied-dir");
  const dataCopiedFile = join(tempDir, "project-ledger", "projects", "demo", "specs", "copied.md");
  const sourceFile = join(workspace, "source.txt");
  const sourceDir = join(workspace, "source-dir");
  const previousHome = process.env.HOME;
  mkdirSync(join(workspace, ".project-ledger", "specs"), { recursive: true });
  mkdirSync(workspaceEmptyDir, { recursive: true });
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(join(tempDir, "project-ledger", "projects", "demo", "specs"), { recursive: true });
  mkdirSync(join(fakeHome, ".butler", "project-ledger", "projects", "demo", "specs"), { recursive: true });
  writeFileSync(workspaceLedgerFile, "old-workspace", "utf8");
  writeFileSync(dataLedgerFile, "old-data", "utf8");
  writeFileSync(homeLedgerFile, "old-home", "utf8");
  writeFileSync(sourceFile, "source-file", "utf8");
  writeFileSync(join(sourceDir, "source-dir-file.txt"), "source-dir", "utf8");
  process.env.HOME = fakeHome;
  try {
    const executor = createButlerToolExecutor({
      butlerHome: root,
      butlerData: tempDir,
      workspacePath: workspace,
    });
    const fileSuffix = "String.fromCharCode(47,46,112,114,111,106,101,99,116,45,108,101,100,103,101,114,47,115,112,101,99,115,47,102,101,97,116,117,114,101,46,109,100)";
    const dirSuffix = "String.fromCharCode(47,46,112,114,111,106,101,99,116,45,108,101,100,103,101,114,47,115,112,101,99,115,47,103,101,110,101,114,97,116,101,100)";
    const emptyDirSuffix = "String.fromCharCode(47,46,112,114,111,106,101,99,116,45,108,101,100,103,101,114,47,115,112,101,99,115,47,101,109,112,116,121,45,100,105,114)";
    const movedSuffix = "String.fromCharCode(47,46,112,114,111,106,101,99,116,45,108,101,100,103,101,114,47,115,112,101,99,115,47,109,111,118,101,100,46,109,100)";
    const copiedDirSuffix = "String.fromCharCode(47,46,112,114,111,106,101,99,116,45,108,101,100,103,101,114,47,115,112,101,99,115,47,99,111,112,105,101,100,45,100,105,114)";
    const cases = [
      `node -e "require('fs').rmSync(process['cw'+'d']()+${fileSuffix}, {force:true})"`,
      "node -e \"require('fs').unlinkSync(process.env['BUTLER'+'_DATA'] + '/project-ledger/projects/demo/specs/feature.md')\"",
      "node -e \"require('fs').rmSync(process.env['HO'+'ME'] + '/.butler/project-ledger/projects/demo/specs/feature.md', {force:true})\"",
      `node -e "require('fs').mkdirSync(process['cw'+'d']()+${dirSuffix}, {recursive:true})"`,
      `node -e "require('fs').rmdirSync(process['cw'+'d']()+${emptyDirSuffix})"`,
      `node -e "require('fs').renameSync(process['cw'+'d']()+${fileSuffix}, process['cw'+'d']()+${movedSuffix})"`,
      "node -e \"require('fs').copyFileSync(process.cwd() + '/source.txt', process.env['BUTLER'+'_DATA'] + '/project-ledger/projects/demo/specs/copied.md')\"",
      `node -e "require('fs').cpSync(process.cwd() + '/source-dir', process['cw'+'d']()+${copiedDirSuffix}, {recursive:true})"`,
    ];

    for (const command of cases) {
      const result = await executor({
        name: "run_command",
        args: { command },
        rawArguments: "{}",
      }) as any;
      expect(result.ok).toBe(false);
      expect(result.error).toBe("protected_path");
    }

    expect(readFileSync(workspaceLedgerFile, "utf8")).toBe("old-workspace");
    expect(readFileSync(dataLedgerFile, "utf8")).toBe("old-data");
    expect(readFileSync(homeLedgerFile, "utf8")).toBe("old-home");
    expect(existsSync(workspaceGeneratedDir)).toBe(false);
    expect(existsSync(workspaceEmptyDir)).toBe(true);
    expect(existsSync(workspaceMovedFile)).toBe(false);
    expect(existsSync(dataCopiedFile)).toBe(false);
    expect(existsSync(workspaceCopiedDir)).toBe(false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("run_command restores split filesystem API-name Project Ledger mutations", async () => {
  const workspace = join(tempDir, "workspace");
  const fakeHome = join(tempDir, "fake-home");
  const workspaceLedgerFile = join(workspace, ".project-ledger", "specs", "feature.md");
  const dataLedgerFile = join(tempDir, "project-ledger", "projects", "demo", "specs", "feature.md");
  const homeLedgerFile = join(fakeHome, ".butler", "project-ledger", "projects", "demo", "specs", "feature.md");
  const previousHome = process.env.HOME;
  mkdirSync(join(workspace, ".project-ledger", "specs"), { recursive: true });
  mkdirSync(join(tempDir, "project-ledger", "projects", "demo", "specs"), { recursive: true });
  mkdirSync(join(fakeHome, ".butler", "project-ledger", "projects", "demo", "specs"), { recursive: true });
  writeFileSync(workspaceLedgerFile, "old-workspace", "utf8");
  writeFileSync(dataLedgerFile, "old-data", "utf8");
  writeFileSync(homeLedgerFile, "old-home", "utf8");
  process.env.HOME = fakeHome;
  try {
    const executor = createButlerToolExecutor({
      butlerHome: root,
      butlerData: tempDir,
      workspacePath: workspace,
    });
    const fileSuffix = "String.fromCharCode(47,46,112,114,111,106,101,99,116,45,108,101,100,103,101,114,47,115,112,101,99,115,47,102,101,97,116,117,114,101,46,109,100)";
    const cases = [
      `node -e "const fs=require('fs'); const m='write'+'FileSync'; fs[m](process['cw'+'d']()+${fileSuffix}, 'split-write')"`,
      "node -e \"const fs=require('fs'); const m='append'+'FileSync'; fs[m](process.env['BUTLER'+'_DATA'] + '/project-ledger/projects/demo/specs/feature.md', 'split-append')\"",
      "node -e \"const fs=require('fs'); const m='create'+'WriteStream'; fs[m](process.env['HO'+'ME'] + '/.butler/project-ledger/projects/demo/specs/feature.md').end('split-stream')\"",
      `node -e "const fs=require('fs'); const m='open'+'Sync'; const fd=fs[m](process['cw'+'d']()+${fileSuffix}, 'w'); fs.closeSync(fd)"`,
      "node -e \"const fs=require('fs'); const m='write'+'File'; fs.promises[m](process.env['BUTLER'+'_DATA'] + '/project-ledger/projects/demo/specs/feature.md', 'split-promises')\"",
    ];

    for (const command of cases) {
      const result = await executor({
        name: "run_command",
        args: { command },
        rawArguments: "{}",
      }) as any;
      expect(result.ok).toBe(false);
      expect(result.error).toBe("protected_path");
    }

    expect(readFileSync(workspaceLedgerFile, "utf8")).toBe("old-workspace");
    expect(readFileSync(dataLedgerFile, "utf8")).toBe("old-data");
    expect(readFileSync(homeLedgerFile, "utf8")).toBe("old-home");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("run_command rejects encoded opaque Project Ledger mutation payloads before execution", async () => {
  const workspace = join(tempDir, "workspace");
  const fakeHome = join(tempDir, "fake-home");
  const workspaceLedgerFile = join(workspace, ".project-ledger", "specs", "feature.md");
  const dataLedgerFile = join(tempDir, "project-ledger", "projects", "demo", "specs", "feature.md");
  const homeLedgerFile = join(fakeHome, ".butler", "project-ledger", "projects", "demo", "specs", "feature.md");
  const previousHome = process.env.HOME;
  mkdirSync(join(workspace, ".project-ledger", "specs"), { recursive: true });
  mkdirSync(join(tempDir, "project-ledger", "projects", "demo", "specs"), { recursive: true });
  mkdirSync(join(fakeHome, ".butler", "project-ledger", "projects", "demo", "specs"), { recursive: true });
  writeFileSync(workspaceLedgerFile, "old-workspace", "utf8");
  writeFileSync(dataLedgerFile, "old-data", "utf8");
  writeFileSync(homeLedgerFile, "old-home", "utf8");
  process.env.HOME = fakeHome;
  try {
    const executor = createButlerToolExecutor({
      butlerHome: root,
      butlerData: tempDir,
      workspacePath: workspace,
    });
    const payloads = [
      "require('fs').writeFileSync(process.cwd() + '/.project-ledger/specs/feature.md', 'encoded-workspace')",
      "require('fs').rmSync(process.env.BUTLER_DATA + '/project-ledger/projects/demo/specs/feature.md', {force:true})",
      "require('fs').appendFileSync(process.env.HOME + '/.butler/project-ledger/projects/demo/specs/feature.md', 'encoded-home')",
    ];

    for (const payload of payloads) {
      const encoded = Buffer.from(payload, "utf8").toString("hex");
      const result = await executor({
        name: "run_command",
        args: { command: `node -e "eval(Buffer.from('${encoded}', 'hex').toString())"` },
        rawArguments: "{}",
      }) as any;
      expect(result.ok).toBe(false);
      expect(result.error).toBe("protected_path");
    }

    expect(readFileSync(workspaceLedgerFile, "utf8")).toBe("old-workspace");
    expect(readFileSync(dataLedgerFile, "utf8")).toBe("old-data");
    expect(readFileSync(homeLedgerFile, "utf8")).toBe("old-home");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("run_command rejects encoded opaque detached Project Ledger payloads before execution", async () => {
  const workspace = join(tempDir, "workspace");
  const fakeHome = join(tempDir, "fake-home");
  const workspaceLedgerFile = join(workspace, ".project-ledger", "specs", "feature.md");
  const dataLedgerFile = join(tempDir, "project-ledger", "projects", "demo", "specs", "feature.md");
  const homeLedgerFile = join(fakeHome, ".butler", "project-ledger", "projects", "demo", "specs", "feature.md");
  const previousHome = process.env.HOME;
  mkdirSync(join(workspace, ".project-ledger", "specs"), { recursive: true });
  mkdirSync(join(tempDir, "project-ledger", "projects", "demo", "specs"), { recursive: true });
  mkdirSync(join(fakeHome, ".butler", "project-ledger", "projects", "demo", "specs"), { recursive: true });
  writeFileSync(workspaceLedgerFile, "old-workspace", "utf8");
  writeFileSync(dataLedgerFile, "old-data", "utf8");
  writeFileSync(homeLedgerFile, "old-home", "utf8");
  process.env.HOME = fakeHome;
  try {
    const executor = createButlerToolExecutor({
      butlerHome: root,
      butlerData: tempDir,
      workspacePath: workspace,
    });
    const payloads = [
      "const {spawn}=require('child_process'); const code=\"setTimeout(()=>require('fs').writeFileSync(process.cwd()+'/.project-ledger/specs/feature.md','late-workspace'),700)\"; spawn(process.execPath,['-e',code],{detached:true,stdio:'ignore'}).unref()",
      "const {spawn}=require('child_process'); const code=\"setTimeout(()=>require('fs').writeFileSync(process.env.BUTLER_DATA+'/project-ledger/projects/demo/specs/feature.md','late-data'),700)\"; spawn(process.execPath,['-e',code],{detached:true,stdio:'ignore'}).unref()",
      "const {spawn}=require('child_process'); const code=\"setTimeout(()=>require('fs').appendFileSync(process.env.HOME+'/.butler/project-ledger/projects/demo/specs/feature.md','late-home'),700)\"; spawn(process.execPath,['-e',code],{detached:true,stdio:'ignore'}).unref()",
    ];

    for (const payload of payloads) {
      const encoded = Buffer.from(payload, "utf8").toString("hex");
      const result = await executor({
        name: "run_command",
        args: { command: `node -e "eval(Buffer.from('${encoded}', 'hex').toString())"` },
        rawArguments: "{}",
      }) as any;
      expect(result.ok).toBe(false);
      expect(result.error).toBe("protected_path");
    }

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(readFileSync(workspaceLedgerFile, "utf8")).toBe("old-workspace");
    expect(readFileSync(dataLedgerFile, "utf8")).toBe("old-data");
    expect(readFileSync(homeLedgerFile, "utf8")).toBe("old-home");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("run_command rejects Python encoded fork Project Ledger payloads before execution", async () => {
  const workspace = join(tempDir, "workspace");
  const ledgerFile = join(workspace, ".project-ledger", "specs", "feature.md");
  mkdirSync(join(workspace, ".project-ledger", "specs"), { recursive: true });
  writeFileSync(ledgerFile, "old", "utf8");
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });
  const payload = "import os,time; time.sleep(.7); open(os.getcwd() + '/.project-ledger/specs/feature.md', 'w').write('python-detached')";
  const encoded = Buffer.from(payload, "utf8").toString("base64");

  const result = await executor({
    name: "run_command",
    args: {
      command: [
        "python3 -c",
        JSON.stringify(`import base64, os, time\nif os.fork() == 0:\n    exec(base64.b64decode('${encoded}').decode())`),
      ].join(" "),
    },
    rawArguments: "{}",
  }) as any;

  expect(result.ok).toBe(false);
  expect(result.error).toBe("protected_path");
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  expect(readFileSync(ledgerFile, "utf8")).toBe("old");
});

test("run_command rejects shadowed Project Ledger CLI names", async () => {
  const workspace = join(tempDir, "workspace");
  const binDir = join(workspace, "bin");
  const ledgerFile = join(workspace, ".project-ledger", "specs", "feature.md");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(workspace, ".project-ledger", "specs"), { recursive: true });
  writeFileSync(ledgerFile, "old", "utf8");
  writeFileSync(
    join(binDir, "pl"),
    "#!/bin/sh\nprintf fake-pl > .project-ledger/specs/feature.md\n",
    { encoding: "utf8", mode: 0o755 },
  );
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });

  const result = await executor({
    name: "run_command",
    args: { command: "PATH=$PWD/bin:$PATH pl record update --id SPEC-X" },
    rawArguments: "{}",
  }) as any;

  expect(result.ok).toBe(false);
  expect(result.error).toBe("protected_path");
  expect(readFileSync(ledgerFile, "utf8")).toBe("old");
});

test("run_command rejects fake Project Ledger bin paths", async () => {
  const workspace = join(tempDir, "workspace");
  const fakeBin = join(workspace, "evil", "packages", "project-ledger", "bin");
  const ledgerFile = join(workspace, ".project-ledger", "specs", "feature.md");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(join(workspace, ".project-ledger", "specs"), { recursive: true });
  writeFileSync(ledgerFile, "old", "utf8");
  writeFileSync(
    join(fakeBin, "project-ledger"),
    "#!/bin/sh\nprintf fake > .project-ledger/specs/feature.md\n",
    { encoding: "utf8", mode: 0o755 },
  );
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });

  const result = await executor({
    name: "run_command",
    args: { command: "./evil/packages/project-ledger/bin/project-ledger help" },
    rawArguments: "{}",
  }) as any;

  expect(result.ok).toBe(false);
  expect(result.error).toBe("protected_path");
  expect(readFileSync(ledgerFile, "utf8")).toBe("old");
});

test("run_command rejects environment preload around the real Project Ledger CLI", async () => {
  const workspace = join(tempDir, "workspace");
  const ledgerFile = join(workspace, ".project-ledger", "specs", "feature.md");
  const preload = join(workspace, "evil.cjs");
  mkdirSync(join(workspace, ".project-ledger", "specs"), { recursive: true });
  writeFileSync(ledgerFile, "old", "utf8");
  writeFileSync(
    preload,
    "require('fs').writeFileSync(process.cwd() + '/.project-ledger/specs/feature.md', 'preload')\n",
    "utf8",
  );
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });

  const result = await executor({
    name: "run_command",
    args: { command: `NODE_OPTIONS=--require=./evil.cjs node ${projectLedgerCli} help` },
    rawArguments: "{}",
  }) as any;

  expect(result.ok).toBe(false);
  expect(result.error).toBe("protected_path");
  expect(readFileSync(ledgerFile, "utf8")).toBe("old");
});

test("run_command allows Project Ledger CLI mutations through the CLI surface", async () => {
  const workspace = join(tempDir, "workspace");
  const dataProject = join(tempDir, "project-ledger", "projects", "demo");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(dataProject, { recursive: true });
  writeFileSync(
    join(dataProject, "project.json"),
    `${JSON.stringify({
      schema: "project-ledger.project.v1",
      id: "demo",
      name: "Demo Project",
      status: "active",
    }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(join(dataProject, "ledger.jsonl"), "", "utf8");
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });

  const result = await executor({
    name: "run_command",
    args: {
      command: `node ${projectLedgerCli} record create --project ${dataProject} --kind spec --id SPEC-RUN-COMMAND --title "Run command spec" --body "Created through the Project Ledger CLI." --json`,
      output_mode: "full",
    },
    rawArguments: "{}",
  }) as any;

  expect(result.ok).toBe(true);
  expect(readFileSync(join(dataProject, "specs", "spec-run-command.md"), "utf8")).toContain(
    "Created through the Project Ledger CLI.",
  );
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

test("run_command verifies a script-based Git workspace mutation without command-text allowlisting", async () => {
  const workspace = join(tempDir, "workspace");
  mkdirSync(workspace, { recursive: true });
  expect(spawnSync("git", ["init", "-q", workspace]).status).toBe(0);
  const executor = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: workspace,
  });

  const result = await executor({
    name: "run_command",
    args: {
      command: "python3 -c 'from pathlib import Path; Path(\"fixed.ts\").write_text(\"fixed\")'",
      state_effect: "mutation",
    },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    durable_artifact_created?: boolean;
    written_files?: string[];
    evidence_capability_receipts?: Array<Record<string, unknown>>;
  };

  expect(result.ok).toBe(true);
  expect(result.durable_artifact_created).toBe(true);
  expect(result.written_files).toContain("fixed.ts");
  expect(result.evidence_capability_receipts).toEqual(expect.arrayContaining([
    expect.objectContaining({
      capability: "durable_artifact",
      maturity: "verified",
      verified: true,
    }),
  ]));
  expect(readFileSync(join(workspace, "fixed.ts"), "utf8")).toBe("fixed");
}, 15_000);

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
  const agentBriefing = [
    "fallback-copy.ts",
    "project-fallback-suggestions.ts",
  ]
    .map((file) =>
      readFileSync(
        join(
          root,
          "packages",
          "butler-agent",
          "src",
          "gateways",
          "app",
          "domain",
          "new-chat-briefing",
          file,
        ),
        "utf8",
      ),
    )
    .join("\n");
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

test("run_command with output_mode=auto suppresses declared validation output on success", async () => {
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
      validation_suite: "unit-tests",
      output_mode: "auto",
    },
    rawArguments: "{}",
  }) as { ok: boolean; stdout: string; stderr: string; exit_code: number; evidence_capability_receipts: Array<Record<string, unknown>> };

  expect(result.ok).toBe(true);
  expect(result.exit_code).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
  expect(result.evidence_capability_receipts).toContainEqual(expect.objectContaining({
    capability: "validation_passed",
    verified: true,
    scope: expect.objectContaining({
      suite: "unit-tests",
      result: "passed",
    }),
  }));
});

test("run_command defaults output_mode to auto for declared validation success", async () => {
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
      validation_suite: "unit-tests",
    },
    rawArguments: "{}",
  }) as { ok: boolean; stdout: string; stderr: string; exit_code: number };

  expect(result.ok).toBe(true);
  expect(result.exit_code).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});

test("run_command keeps structured validation failure stronger than declared command success", async () => {
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
      command: "printf '%s\\n' '{\"validation_result\":{\"suite\":\"unit-tests\",\"result\":\"failed\",\"failure_summary\":\"assertion failed\"}}'",
      validation_suite: "unit-tests",
      output_mode: "auto",
    },
    rawArguments: "{}",
  }) as { evidence_capability_receipts: Array<Record<string, unknown>> };

  expect(result.evidence_capability_receipts).toContainEqual(expect.objectContaining({
    capability: "validation_passed",
    verified: false,
    scope: expect.objectContaining({
      suite: "unit-tests",
      result: "failed",
    }),
  }));
});

test("run_command preserves ordered structured validation receipts for the same suite", async () => {
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
      command: "printf '%s\\n' '{\"validation_results\":[{\"suite\":\"unit-tests\",\"result\":\"failed\"},{\"suite\":\"unit-tests\",\"result\":\"passed\"}]}'",
      validation_suite: "unit-tests",
      output_mode: "auto",
    },
    rawArguments: "{}",
  }) as { evidence_capability_receipts: Array<Record<string, unknown>> };

  const validationReceipts = result.evidence_capability_receipts.filter((receipt) =>
    receipt.capability === "validation_passed",
  );
  expect(validationReceipts.map((receipt) =>
    (receipt.scope as Record<string, unknown>).result,
  )).toEqual(["failed", "passed"]);
});

test("run_command auto does not infer validation from command text", async () => {
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
  expect(result.stdout).toContain("noisy check output");
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

test("run_command with output_mode=auto shows bounded output for failed commands", async () => {
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
  const nativeStatus = BUTLER_TOOLS.find((item) => item.name === "project_ledger_status");
  const nativeIndex = BUTLER_TOOLS.find((item) => item.name === "project_ledger_index");
  const nativeList = BUTLER_TOOLS.find((item) => item.name === "project_ledger_list");
  const nativeCreate = BUTLER_TOOLS.find((item) => item.name === "project_ledger_create");
  const nativeTaskComplete = BUTLER_TOOLS.find((item) => item.name === "project_ledger_task_complete");
  const status = BUTLER_TOOLS.find((item) => item.name === "inspect_project_status");
  const query = BUTLER_TOOLS.find((item) => item.name === "query_project_work");
  const render = BUTLER_TOOLS.find((item) => item.name === "render_project_dashboard");
  const complete = BUTLER_TOOLS.find((item) => item.name === "complete_project_work");

  expect(nativeStatus?.parameters.required).toEqual([]);
  expect(Object.keys(nativeStatus?.parameters.properties ?? {})).toEqual(["project_ref"]);
  expect(nativeIndex?.parameters.required).toEqual([]);
  expect(Object.keys(nativeIndex?.parameters.properties ?? {})).toEqual(["project_ref"]);
  expect(nativeList?.parameters.required).toEqual(["kind"]);
  expect(Object.keys(nativeList?.parameters.properties ?? {})).toEqual(["project_ref", "kind", "status", "query", "limit"]);
  expect(nativeCreate?.parameters.required).toEqual(["kind", "id", "title"]);
  expect(Object.keys(nativeCreate?.parameters.properties ?? {})).toContain("body");
  const createVariants = (nativeCreate?.parameters as Record<string, unknown>)?.oneOf as Array<{
    properties?: { kind?: { const?: string; enum?: string[] } };
    required?: string[];
  }>;
  expect(createVariants.find((variant) => variant.properties?.kind?.const === "task")?.required)
    .toEqual(["work_id", "acceptance"]);
  expect(createVariants.find((variant) => variant.properties?.kind?.const === "attempt")?.required)
    .toEqual(["task_id"]);
  const workVariant = createVariants.find((variant) => variant.properties?.kind?.const === "work");
  expect(workVariant).toBeDefined();
  expect(workVariant?.required).toContain("acceptance");
  expect((workVariant?.properties as any).status.enum).toContain("in_progress");
  const taskVariant = createVariants.find((variant) => variant.properties?.kind?.const === "task");
  expect(taskVariant?.required).toEqual(["work_id", "acceptance"]);
  expect((taskVariant?.properties as any).status.enum).toContain("todo");
  expect((taskVariant?.properties as any).status.enum).not.toContain("pending");
  expect(nativeTaskComplete?.parameters.required).toEqual(["id", "validation", "review", "report"]);
  expect(Object.keys(nativeTaskComplete?.parameters.properties ?? {})).toContain("validation");
  expect(status?.parameters.required).toEqual([]);
  expect(Object.keys(status?.parameters.properties ?? {})).toEqual(["project_ref"]);
  expect(query?.parameters.required).toEqual(["kind"]);
  expect(Object.keys(query?.parameters.properties ?? {})).toEqual(["project_ref", "kind"]);
  expect(render?.parameters.required).toEqual(["view"]);
  expect(Object.keys(render?.parameters.properties ?? {})).toEqual(["project_ref", "view", "write"]);
  expect(complete?.parameters.required).toEqual(["id", "validation", "review", "report"]);
  expect(Object.keys(complete?.parameters.properties ?? {})).toEqual([
    "project_ref",
    "id",
    "validation",
    "review",
    "report",
  ]);
});

test("workspace file tool schemas keep the runtime-owned root out of model arguments", () => {
  for (const name of ["grep_files", "read_file", "write_file", "edit_file"]) {
    const tool = BUTLER_TOOLS.find((candidate) => candidate.name === name);
    expect(tool).toBeDefined();
    expect(tool?.parameters.properties).not.toHaveProperty("workspace_root");
  }
  expect((BUTLER_TOOLS.find((tool) => tool.name === "read_file")?.parameters.properties as any)
    .path.description).toContain("inside the active workspace");
  expect(BUTLER_TOOLS.find((tool) => tool.name === "write_file")?.description)
    .toContain("content is never a patch, fragment, or append");
});

test("context monitor tool schema exposes safe session lookup", () => {
  const tool = BUTLER_TOOLS.find((item) => item.name === "get_context_monitor");

  expect(tool?.parameters.required).toEqual([]);
  expect(Object.keys(tool?.parameters.properties ?? {})).toEqual(["session_id"]);
});

test("conversation context tool schema exposes bounded canonical lookup controls", () => {
  const tool = BUTLER_TOOLS.find((item) => item.name === "read_conversation_context");

  expect(tool?.parameters.required).toEqual([]);
  expect(Object.keys(tool?.parameters.properties ?? {})).toEqual([
    "query",
    "anchor_message_id",
    "anchor_event_id",
    "direction",
    "limit",
    "max_chars",
    "include_tools",
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

test("tool evidence artifact reader schema exposes focused recovery controls", () => {
  const tool = BUTLER_TOOLS.find((item) => item.name === "read_tool_evidence_artifact");

  expect(tool?.parameters.required).toEqual([]);
  expect(Object.keys(tool?.parameters.properties ?? {})).toEqual([
    "artifact_id",
    "path",
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
  expect((list?.parameters.properties as any)?.category?.enum).toContain("file");
  expect((list?.parameters.properties as any)?.category?.enum).toContain("command");
  expect((list?.parameters.properties as any)?.category?.enum).toContain("all");
  expect((list?.parameters.properties as any)?.category?.enum).toContain("native");
  expect((list?.parameters.properties as any)?.category?.enum).toContain("workspace");
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
  expect((search?.parameters.properties as any)?.category?.enum).toContain("file");
  expect((search?.parameters.properties as any)?.category?.enum).toContain("command");
  expect((search?.parameters.properties as any)?.category?.enum).toContain("all");
  expect((search?.parameters.properties as any)?.category?.enum).toContain("native");
  expect((search?.parameters.properties as any)?.category?.enum).toContain("workspace");
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

test("tool capability discovery supports file category and execution aliases", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: tempDir,
    workspacePath: tempDir,
    currentToolNames: ["list_tool_capabilities", "run_command", "read_file", "write_file", "grep_files"],
  });

  const files = await execute({
    name: "list_tool_capabilities",
    args: { category: "file" },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    capabilities: Array<{ name: string; category: string; current_turn_callable: boolean | null }>;
  };
  expect(files.ok).toBe(true);
  expect(files.capabilities).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "read_file", category: "file", current_turn_callable: true }),
    expect.objectContaining({ name: "write_file", category: "file", current_turn_callable: true }),
    expect.objectContaining({ name: "grep_files", category: "file", current_turn_callable: true }),
  ]));

  const shell = await execute({
    name: "list_tool_capabilities",
    args: { category: "shell" },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    capabilities: Array<{ name: string; category: string; current_turn_callable: boolean | null }>;
  };
  expect(shell.ok).toBe(true);
  expect(shell.capabilities).toContainEqual(expect.objectContaining({
    name: "run_command",
    category: "command",
    current_turn_callable: true,
  }));

  const workspace = await execute({
    name: "list_tool_capabilities",
    args: { category: "workspace" },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    capabilities: Array<{ name: string; category: string; current_turn_callable: boolean | null }>;
  };
  expect(workspace.ok).toBe(true);
  expect(workspace.capabilities).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "run_command", category: "command", current_turn_callable: true }),
    expect.objectContaining({ name: "read_file", category: "file", current_turn_callable: true }),
  ]));

  const all = await execute({
    name: "list_tool_capabilities",
    args: { category: "all" },
    rawArguments: "{}",
  }) as {
    ok: boolean;
    capabilities: Array<{ name: string }>;
  };
  expect(all.ok).toBe(true);
  expect(all.capabilities.some((capability) => capability.name === "run_command")).toBe(true);
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
    "Uses canonical conversation messages by default",
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
    "include_transcript_recovery",
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
        text: "First chunk evidence ".repeat(60),
        charCount: "First chunk evidence ".repeat(60).length,
      }, {
        id: "ev_test_next",
        index: 1,
        title: "Evidence Story",
        url: "https://example.com/story",
        text: "Second chunk evidence ".repeat(60),
        charCount: "Second chunk evidence ".repeat(60).length,
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
    start_chunk: 0,
    returned_chunks: 1,
    total_chunks: 2,
    next_start_chunk: 1,
    effective_max_chars: 1_500,
    effective_max_chunks: 1,
    content_has_more: true,
    markdown_truncated: false,
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
  expect(result.markdown.length).toBeLessThanOrEqual(1_500);
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
    args: { url: "https://example.com/story", max_chars: 1_500 },
    rawArguments: "{}",
  }) as Record<string, any>;
  const second = await execute({
    name: "web_read",
    args: { url: "https://example.com/story", max_chars: 1_500 },
    rawArguments: "{}",
  }) as Record<string, any>;

  expect(readCount).toBe(1);
  expect(first.cache_hit).toBe(false);
  expect(first.duplicate_observation).toBe(false);
  expect(second.cache_hit).toBe(true);
  expect(second.duplicate_observation).toBe(true);
  expect(second.title).toBe("Evidence Story");
  expect(second.evidence_quality).toBe(first.evidence_quality);
  expect(second.evidence_receipts).toEqual(first.evidence_receipts);
  expect(second.public_web_evidence_items).toEqual([]);
  expect(second).not.toHaveProperty("markdown");
  expect(second).not.toHaveProperty("chunks");
});

test("web_read continues through cached page chunks with start_chunk", async () => {
  let readCount = 0;
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    pageReader: async () => {
      readCount += 1;
      return {
        reader: "butler-lightweight",
        requestedUrl: "https://example.com/paged",
        finalUrl: "https://example.com/paged",
        ok: true,
        status: 200,
        title: "Paged Evidence",
        text: "FIRST CHUNK\nSECOND CHUNK\nTHIRD CHUNK",
        markdown: "FIRST CHUNK\nSECOND CHUNK\nTHIRD CHUNK",
        document: "document",
        chunks: ["FIRST CHUNK", "SECOND CHUNK", "THIRD CHUNK"].map((text, index) => ({
          id: `ev_paged_${index}`,
          index,
          title: "Paged Evidence",
          url: "https://example.com/paged",
          text,
          charCount: text.length,
        })),
        method: "readability",
        durationMs: 12,
        warnings: [],
        renderRecommended: false,
      };
    },
  });

  const first = await execute({
    name: "web_read",
    args: { url: "https://example.com/paged", max_chunks: 1 },
    rawArguments: "{}",
  }) as Record<string, any>;
  const next = await execute({
    name: "web_read",
    args: { url: "https://example.com/paged", start_chunk: first.next_start_chunk, max_chunks: 1 },
    rawArguments: "{}",
  }) as Record<string, any>;

  expect(readCount).toBe(1);
  expect(first).toMatchObject({
    markdown: "FIRST CHUNK",
    start_chunk: 0,
    returned_chunks: 1,
    total_chunks: 3,
    next_start_chunk: 1,
    content_has_more: true,
    cache_hit: false,
    duplicate_observation: false,
  });
  expect(next).toMatchObject({
    markdown: "SECOND CHUNK",
    start_chunk: 1,
    returned_chunks: 1,
    total_chunks: 3,
    next_start_chunk: 2,
    content_has_more: true,
    cache_hit: true,
    duplicate_observation: false,
  });
  expect(next.markdown).not.toContain("FIRST CHUNK");
});

test("web_read advances only past complete chunks that fit max_chars", async () => {
  const chunks = ["A", "B", "C"].map((marker, index) => ({
    id: `ev_complete_${index}`,
    index,
    title: "Complete Window",
    url: "https://example.com/complete-window",
    text: marker.repeat(1_500),
    charCount: 1_500,
  }));
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    pageReader: async () => ({
      reader: "butler-lightweight",
      requestedUrl: "https://example.com/complete-window",
      finalUrl: "https://example.com/complete-window",
      ok: true,
      status: 200,
      title: "Complete Window",
      text: chunks.map((chunk) => chunk.text).join("\n\n"),
      markdown: chunks.map((chunk) => chunk.text).join("\n\n"),
      document: "document",
      chunks,
      method: "readability",
      durationMs: 12,
      warnings: [],
      renderRecommended: false,
    }),
  });

  const first = await execute({
    name: "web_read",
    args: {
      url: "https://example.com/complete-window",
      max_chars: 2_000,
      max_chunks: 3,
    },
    rawArguments: "{}",
  }) as Record<string, any>;
  const outOfRange = await execute({
    name: "web_read",
    args: {
      url: "https://example.com/complete-window",
      start_chunk: 3,
      max_chars: 2_000,
      max_chunks: 3,
    },
    rawArguments: "{}",
  }) as Record<string, any>;

  expect(first).toMatchObject({
    start_chunk: 0,
    returned_chunks: 1,
    total_chunks: 3,
    next_start_chunk: 1,
    content_has_more: true,
    markdown_truncated: false,
  });
  expect(first.markdown).toBe("A".repeat(1_500));
  expect(first.chunks).toHaveLength(1);
  expect(outOfRange).toMatchObject({
    ok: true,
    start_chunk: 3,
    returned_chunks: 0,
    total_chunks: 3,
    next_start_chunk: null,
    content_has_more: false,
    evidence_quality: "unavailable",
    markdown: "",
  });
  expect(outOfRange.public_web_evidence_items).toEqual([]);
  expect(outOfRange.evidence_receipts).toEqual([
    expect.objectContaining({ verified: false }),
  ]);
});

test("web_read defaults to compact chunk previews instead of duplicate long chunks", async () => {
  const longChunk = "chunk evidence detail ".repeat(68);
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
  expect(JSON.stringify(result).length).toBeLessThan(longChunk.length + result.markdown.length + 3_000);
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
  expect(dashboard.evidence_capability_receipts).toEqual([
    expect.objectContaining({
      capability: "source_verified",
      evidence_kind: "project_state",
      satisfies: ["source_verified"],
    }),
  ]);
  expect(satisfiedCompletionObligationsForToolResult("get_work_dashboard", dashboard)).toContain("source_verified");

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
  expect(spawnSync("git", ["init"], { cwd: projectPath }).status).toBe(0);
  expect(spawnSync("git", ["add", "package.json"], { cwd: projectPath }).status).toBe(0);
  expect(spawnSync("git", [
    "-c",
    "user.name=Butler Test",
    "-c",
    "user.email=butler-test@example.invalid",
    "commit",
    "-m",
    "Initialize ledger demo",
  ], { cwd: projectPath }).status).toBe(0);
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
  expect(status.evidence_capability_receipts).toEqual([
    expect.objectContaining({
      capability: "source_verified",
      evidence_kind: "project_state",
      satisfies: ["source_verified"],
    }),
  ]);
  expect(satisfiedCompletionObligationsForToolResult("inspect_project_status", status)).toContain("source_verified");

  const query = await execute({
    name: "query_project_work",
    args: { project_path: projectPath, kind: "next-actions" },
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(query.ok).toBe(true);
  expect(query.data.results[0].id).toBe("W-TOOL");
  expect(query.evidence_capability_receipts).toEqual([
    expect.objectContaining({
      capability: "source_verified",
      evidence_kind: "project_state",
      satisfies: ["source_verified"],
    }),
  ]);
  expect(satisfiedCompletionObligationsForToolResult("query_project_work", query)).toContain("source_verified");

  const nativeCreatedTask = await execute({
    name: "project_ledger_create",
    args: {
      project_path: projectPath,
      kind: "task",
      work_id: "W-TOOL",
      id: "T-NATIVE-BODY",
      title: "Native body task",
      body: "# Native Body\n\nCreated through project_ledger_create.\n",
    },
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(nativeCreatedTask.ok).toBe(true);
  expect(nativeCreatedTask.data.id).toBe("T-NATIVE-BODY");
  expect(nativeCreatedTask.project_ledger_closeout).toEqual(expect.objectContaining({
    ok: true,
    check_ok: true,
    issue_count: 0,
  }));

  const nativeShownTask = await execute({
    name: "project_ledger_show",
    args: {
      project_path: projectPath,
      kind: "task",
      id: "T-NATIVE-BODY",
      include_body: true,
    },
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(nativeShownTask.ok).toBe(true);
  expect(nativeShownTask.data.body).toContain("Created through project_ledger_create.");

  const nativeUpdatedWork = await execute({
    name: "project_ledger_work_update",
    args: {
      project_path: projectPath,
      id: "W-TOOL",
      body: "# Native Work Body\n\nUpdated through project_ledger_work_update.\n",
    },
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(nativeUpdatedWork.ok).toBe(true);
  const canonicalImplementation = "Implemented the scoped wrapper change.";
  const canonicalValidation = "Focused and full validation passed.";
  const canonicalReview = "Hostile review found no remaining blockers.";
  const canonicalCommit = JSON.stringify([{
    repo: "ledger-demo",
    hash: "abc123def456",
    message: "Implement wrapper change",
  }]);
  const evidencedWork = await execute({
    name: "project_ledger_update",
    args: {
      project_path: projectPath,
      kind: "work",
      id: "W-TOOL",
      implementation: canonicalImplementation,
      validation: canonicalValidation,
      review: canonicalReview,
      code_commits: canonicalCommit,
    },
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(evidencedWork.ok).toBe(true);
  const pendingShownWork = await execute({
    name: "project_ledger_show",
    args: {
      project_path: projectPath,
      kind: "work",
      id: "W-TOOL",
    },
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(pendingShownWork.data.status).not.toBe("done");
  expect(pendingShownWork.evidence_capability_receipts).toEqual([
    expect.objectContaining({ capability: "source_verified", evidence_kind: "project_state" }),
  ]);
  const completedWork = await execute({
    name: "project_ledger_work_complete",
    args: {
      project_path: projectPath,
      id: "W-TOOL",
      validation: canonicalValidation,
      review: canonicalReview,
      report: "Canonical closeout report.",
      code_commits: canonicalCommit,
    },
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(completedWork.ok).toBe(true);
  expect(completedWork.data.status).toBe("done");

  runProjectLedger([
    "work",
    "create",
    "--id",
    "W-AUTO-COMMIT",
    "--title",
    "Automatic commit evidence",
    "--status",
    "in_progress",
    "--spec-exemption",
    "--acceptance-exemption",
    "--requires-commit-evidence",
  ], projectPath);
  const autoCommitWork = await execute({
    name: "project_ledger_work_complete",
    args: {
      project_path: projectPath,
      id: "W-AUTO-COMMIT",
      validation: "automatic evidence validation",
      review: "automatic evidence review",
      report: "Automatic evidence report.",
      code_commit: "15149b333e7162d9b3448f172079c481afedde9b",
      code_commits: "15149b333e7162d9b3448f172079c481afedde9b",
    },
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(autoCommitWork.ok).toBe(true);
  expect(autoCommitWork.data.status).toBe("done");
  const automaticCommits = JSON.parse(autoCommitWork.data.codeCommits);
  expect(automaticCommits).toEqual([
    expect.objectContaining({
      repo: "ledger-project",
      hash: expect.stringMatching(/^[0-9a-f]{12}$/u),
      message: "Initialize ledger demo",
    }),
  ]);
  expect(autoCommitWork.data.codeCommits).not.toContain("15149b333e7162d9b3448f172079c481afedde9b");

  const nativeShownWork = await execute({
    name: "project_ledger_show",
    args: {
      project_path: projectPath,
      kind: "work",
      id: "W-TOOL",
      include_body: true,
    },
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(nativeShownWork.data.body).toContain("Updated through project_ledger_work_update.");
  expect(nativeShownWork.evidence_capability_receipts).toEqual(expect.arrayContaining([
    expect.objectContaining({ capability: "source_verified", evidence_kind: "project_state" }),
    expect.objectContaining({ capability: "workspace_mutated", evidence_kind: "mutation_result" }),
    expect.objectContaining({ capability: "validation_passed", evidence_kind: "execution_result" }),
    expect.objectContaining({ capability: "review_completed", evidence_kind: "review_result" }),
  ]));
  const receiptText = JSON.stringify(nativeShownWork.evidence_capability_receipts);
  expect(receiptText).not.toContain(canonicalImplementation);
  expect(receiptText).not.toContain(canonicalValidation);
  expect(receiptText).not.toContain(canonicalReview);
  expect(receiptText).not.toContain("abc123def456");

  const nativeUpdatedTask = await execute({
    name: "project_ledger_task_update",
    args: {
      project_path: projectPath,
      id: "T-NATIVE-BODY",
      status: "in_progress",
      body: "# Native Task Body\n\nUpdated through project_ledger_task_update.\n",
    },
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(nativeUpdatedTask.ok).toBe(true);
  expect(nativeUpdatedTask.project_ledger_closeout).toEqual(expect.objectContaining({
    ok: true,
    check_ok: true,
    issue_count: 0,
    rendered_views: expect.arrayContaining([
      expect.objectContaining({ view: "dashboard", ok: true, written: true }),
      expect.objectContaining({ view: "handoff", ok: true, written: true }),
      expect.objectContaining({ view: "roadmap", ok: true, written: true }),
    ]),
  }));
  expect(JSON.stringify(nativeUpdatedTask.project_ledger_closeout)).not.toContain("Project Ledger Dashboard");
  const nativeShownUpdatedTask = await execute({
    name: "project_ledger_show",
    args: {
      project_path: projectPath,
      kind: "task",
      id: "T-NATIVE-BODY",
      include_body: true,
    },
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(nativeShownUpdatedTask.data.body).toContain("Updated through project_ledger_task_update.");

  const cleanCheckAfterTaskUpdate = await execute({
    name: "project_ledger_check",
    args: { project_path: projectPath, verbose: true },
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(cleanCheckAfterTaskUpdate.ok).toBe(true);

  const nativeCompletedTask = await execute({
    name: "project_ledger_task_complete",
    args: {
      project_path: projectPath,
      id: "T-NATIVE-BODY",
      validation: "Validated through native Project Ledger closeout test.",
      review: "Reviewed for lifecycle closeout hygiene.",
    },
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(nativeCompletedTask.ok).toBe(true);
  expect(nativeCompletedTask.project_ledger_closeout).toEqual(expect.objectContaining({
    ok: true,
    check_ok: true,
    issue_count: 0,
  }));

  const nativeIndexed = await execute({
    name: "project_ledger_index",
    args: { project_path: projectPath },
    rawArguments: "{}",
  }) as Record<string, any>;
  expect(nativeIndexed.ok).toBe(true);
  expect(nativeIndexed.data.index.path).toBe("project-ledger/projects/ledger-demo/index/project.json");

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
  expect(written.artifact_path).toBe(join(tempDir, "project-ledger", "projects", "ledger-demo", "views", "dashboard.md"));
  expect(written.verified_output_files).toContainEqual({
    path: "project-ledger/projects/ledger-demo/views/dashboard.md",
    artifact_kind: "markdown_file",
  });
  expect(satisfiedCompletionObligationsForToolResult("render_project_dashboard", written)).toContain("durable_artifact");
});

test("Project Ledger tools do not verify source evidence when the CLI did not return state", async () => {
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
  });

  const status = await execute({
    name: "inspect_project_status",
    args: { project_path: tempDir },
    rawArguments: "{}",
  }) as Record<string, any>;

  expect(status.ok).toBe(false);
  expect(status.command).toBeUndefined();
  expect(status.evidence_capability_receipts).toBeUndefined();
  expect(satisfiedCompletionObligationsForToolResult("inspect_project_status", status)).toEqual([]);
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
    schema_version: "butler.tool-evidence-rehydration.v1",
    terminal_evidence_observation: true,
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

test("tool evidence artifact reader executes bounded Butler-owned slices", async () => {
  const retained = retainToolEvidence({
    context: {
      butlerData: tempDir,
      turnId: "turn-evidence",
      now: new Date("2026-07-09T00:00:00.000Z"),
    },
    toolName: "echo",
    toolCallId: "call-evidence",
    reason: "unit_test",
    output: {
      ok: true,
      stdout: [
        "headline",
        "alpha",
        "needle evidence row",
        "omega",
      ].join("\n"),
    },
  });
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    sessionId: "butler/main",
  });

  const result = await execute({
    name: "read_tool_evidence_artifact",
    args: {
      artifact_id: retained.packet.artifact_id,
      offset_lines: 8,
      limit_lines: 1,
      max_tokens: 80,
    },
    rawArguments: "{}",
  }) as Record<string, any>;

  expect(result).toMatchObject({
    schema_version: "butler.tool-evidence-rehydration.v1",
    terminal_evidence_observation: true,
    ok: true,
    rawTextStored: false,
    artifact: {
      id: retained.packet.artifact_id,
      tool_name: "echo",
      tool_call_id: "call-evidence",
      turn_id: "turn-evidence",
    },
    text: {
      start_line: 8,
      returned_lines: 1,
    },
  });
  expect(result.text.text).toContain("needle evidence row");
  expect(satisfiedCompletionObligationsForToolResult("read_tool_evidence_artifact", result)).not.toContain(
    "source_verified",
  );
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
  const conversation = new AgentConversationStore({ butlerData: tempDir });
  try {
    const turn = conversation.beginTurn({
      gateway: "test",
      externalSessionId: "butler/main",
      sessionId: "cs_memory_tool",
      actor: "user",
      now: "2026-04-24T12:05:00.000Z",
    });
    conversation.appendUserMessage({
      sessionId: "cs_memory_tool",
      turnId: turn.id,
      messageId: "cm_first_user",
      text: "SYNTHETIC_FIRST_USER_CHECKPOINT",
      sourceGateway: "test",
      sourceRef: "first-user",
      now: "2026-04-24T12:05:34.000Z",
    });
  } finally {
    conversation.close();
  }
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
      event_id: "cm_first_user",
      conversation_message_id: "cm_first_user",
      timestamp: "2026-04-24T12:05:34.000Z",
      speaker: "user",
      source: "conversation-store",
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

test("recall_memory tool stays in the owning model phase when recall policy is omitted", async () => {
  const embedQueries: string[] = [];
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    projectId: "butler",
    sessionId: "butler/main",
    workerModel: "openai/test-memory-planner",
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

  expect(embedQueries).toContain("그거 뭐였지?");
  expect(recall.ok).toBe(true);
  expect(recall.results).toEqual([expect.objectContaining({ source: "vector" })]);
  expect(recall.diagnostics).not.toContain("retrieval_planner=used");
  expect(recall.diagnostics.some((entry) => entry.startsWith("retrieval_planner_")))
    .toBe(false);
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
  expect(list.skills.map((skill: any) => skill.name)).not.toContain("dispatch");
  expect(BUTLER_TOOLS.find((tool) => tool.name === "select_skill")).toBeUndefined();
});
