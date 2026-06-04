import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LAYOUT_DIRS } from "./constants.js";
import { CliError, nowIso } from "./errors.js";
import { optionalNumber, optionalString, projectRoot, requiredOption } from "./args.js";
import {
  appendLedgerEvent,
  ensureDir,
  ledgerRoot,
  projectPath,
  projectRelative,
  safeReadJson,
  safeWriteJson,
} from "./fs.js";
import { check, doctor, loadIndex, projectStatus, queryIndex, writeIndex } from "./indexer.js";
import {
  attemptRecordPath,
  findRecord,
  readRecord,
  taskIdFromAttemptPath,
  taskRecordPath,
  updateMarkdownRecord,
  workIdFromTaskPath,
  workRecordPath,
  writeMarkdownRecord,
} from "./records.js";
import { assertTransition, assertValidState, completionGateIssues } from "./state-machine.js";
import { render } from "./renderer.js";
import { installSkill } from "./distribution.js";
import { migrateDocs } from "./docs-migration.js";
import { gitCommitEvidence } from "./git-evidence.js";

function requireTitle(options) {
  return requiredOption(options, "title");
}

function baseRecord(kind, options, defaults = {}) {
  return {
    schema: `project-ledger.${kind}.v1`,
    kind,
    id: requiredOption(options, "id"),
    title: requireTitle(options),
    status: defaults.status,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...defaults,
  };
}

function optionUpdates(options, fields) {
  const updates = {};
  for (const field of fields) {
    const value = optionalString(options, field);
    if (value !== null) updates[field] = value;
  }
  const codeCommits = optionalString(options, "code-commits");
  if (codeCommits !== null) updates.codeCommits = codeCommits;
  const ledgerCommits = optionalString(options, "ledger-commits");
  if (ledgerCommits !== null) updates.ledgerCommits = ledgerCommits;
  if (optionalString(options, "code-commit") === "auto") {
    updates.codeCommits = JSON.stringify([gitCommitEvidence(projectRoot(options))]);
  }
  if (options["spec-exemption"]) updates.specExemption = true;
  if (options["acceptance-exemption"]) updates.acceptanceExemption = true;
  if (options["requires-commit-evidence"]) updates.requiresCommitEvidence = true;
  const priority = optionalNumber(options, "priority");
  if (priority !== null) updates.priority = priority;
  return updates;
}

function findRecordPath(project, kind, id) {
  return projectPath(project, findRecord(loadIndex(project), kind, id).path);
}

function writeAndReturn(project, filePath, data) {
  writeMarkdownRecord(filePath, data);
  const record = readRecord(project, filePath);
  appendLedgerEvent(project, {
    type: `${data.kind}_${data.status === "done" ? "completed" : "written"}`,
    id: data.id,
    kind: data.kind,
    status: data.status,
    path: projectRelative(project, filePath),
    source: "project-ledger",
  });
  return record;
}

export function initProject(options) {
  const project = projectRoot(options);
  const id = requiredOption(options, "id");
  const name = requiredOption(options, "name");

  ensureDir(ledgerRoot(project));
  for (const dir of LAYOUT_DIRS) ensureDir(join(ledgerRoot(project), dir));

  const projectFile = join(ledgerRoot(project), "project.json");
  const timestamp = nowIso();
  if (!existsSync(projectFile)) {
    safeWriteJson(projectFile, {
      schema: "project-ledger.project.v1",
      id,
      name,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  const ledgerFile = join(ledgerRoot(project), "ledger.jsonl");
  if (!existsSync(ledgerFile)) writeFileSync(ledgerFile, "", "utf8");
  appendLedgerEvent(project, {
    type: "project_initialized",
    projectId: id,
    source: "project-ledger",
  });

  const rootLabel = projectRelative(project, ledgerRoot(project));
  return {
    project: safeReadJson(projectFile),
    root: rootLabel,
    directories: LAYOUT_DIRS.map((dir) => `${rootLabel}/${dir}`),
  };
}

export function createWork(project, options) {
  const status = optionalString(options, "status") ?? "proposed";
  assertValidState("work", status);
  const data = {
    ...baseRecord("work", options, { status }),
    ...optionUpdates(options, [
      "spec",
      "acceptance",
      "validation",
      "review",
      "report",
      "implementation",
      "mitigation",
      "codeCommits",
      "ledgerCommits",
    ]),
  };
  const filePath = workRecordPath(project, data.id);
  if (existsSync(filePath)) throw new CliError(`Work already exists: ${data.id}`, "record_exists");
  return writeAndReturn(project, filePath, data);
}

export function updateWork(project, options) {
  const id = requiredOption(options, "id");
  const filePath = findRecordPath(project, "work", id);
  const current = readRecord(project, filePath);
  const status = optionalString(options, "status");
  const updates = {
    ...optionUpdates(options, [
      "title",
      "spec",
      "acceptance",
      "validation",
      "review",
      "report",
      "implementation",
      "mitigation",
      "codeCommits",
      "ledgerCommits",
    ]),
  };
  if (status) {
    assertTransition("work", current.status, status);
    updates.status = status;
  }
  updateMarkdownRecord(filePath, updates);
  appendLedgerEvent(project, { type: "work_updated", id, source: "project-ledger" });
  return readRecord(project, filePath);
}

export function completeWork(project, options) {
  const id = requiredOption(options, "id");
  const filePath = findRecordPath(project, "work", id);
  const current = readRecord(project, filePath);
  if (current.status === "done") {
    throw new CliError(`Work is already completed: ${id}`, "invalid_transition", 2);
  }
  assertTransition("work", current.status, "done");
  const updates = {
    status: "done",
    ...optionUpdates(options, ["spec", "acceptance", "validation", "review", "report", "codeCommits", "ledgerCommits"]),
  };
  const candidate = {
    ...current,
    ...updates,
    specExemption: updates.specExemption ?? current.specExemption,
    acceptanceExemption: updates.acceptanceExemption ?? current.acceptanceExemption,
  };
  const gaps = completionGateIssues(candidate);
  if (gaps.length > 0) {
    throw new CliError(
      `Work completion gate failed: ${gaps.map((gap) => gap.field).join(", ")}`,
      "completion_gate_failed",
      1,
      gaps,
    );
  }
  updateMarkdownRecord(filePath, updates);
  appendLedgerEvent(project, {
    type: "work_completed",
    id,
    report: candidate.report,
    source: "project-ledger",
  });
  return readRecord(project, filePath);
}

export function createTask(project, options) {
  const workId = requiredOption(options, "work");
  findRecord(loadIndex(project), "work", workId);
  const status = optionalString(options, "status") ?? "todo";
  assertValidState("task", status);
  const data = {
    ...baseRecord("task", options, { status, parentId: workId }),
    ...optionUpdates(options, ["validation", "review", "report"]),
  };
  const filePath = taskRecordPath(project, workId, data.id);
  if (existsSync(filePath)) throw new CliError(`Task already exists: ${data.id}`, "record_exists");
  return writeAndReturn(project, filePath, data);
}

export function updateTask(project, options, forcedStatus = null) {
  const id = requiredOption(options, "id");
  const record = findRecord(loadIndex(project), "task", id);
  const filePath = projectPath(project, record.path);
  const current = readRecord(project, filePath);
  const status = forcedStatus ?? optionalString(options, "status");
  const updates = optionUpdates(options, ["title", "validation", "review", "report"]);
  if (status) {
    assertTransition("task", current.status, status);
    updates.status = status;
  }
  updateMarkdownRecord(filePath, updates);
  appendLedgerEvent(project, { type: "task_updated", id, source: "project-ledger" });
  return readRecord(project, filePath);
}

export function createAttempt(project, options) {
  const taskId = requiredOption(options, "task");
  const task = findRecord(loadIndex(project), "task", taskId);
  const workId = workIdFromTaskPath(task.path);
  if (!workId) throw new CliError(`Cannot infer work id for task: ${taskId}`, "invalid_record_path", 1);
  const id = optionalString(options, "id") ?? `A-${Date.now()}`;
  const data = {
    schema: "project-ledger.attempt.v1",
    kind: "attempt",
    id,
    title: optionalString(options, "title") ?? `Attempt ${id}`,
    parentId: taskId,
    status: "started",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...optionUpdates(options, ["validation", "review", "report"]),
  };
  const filePath = attemptRecordPath(project, workId, taskId, id);
  if (existsSync(filePath)) throw new CliError(`Attempt already exists: ${id}`, "record_exists");
  return writeAndReturn(project, filePath, data);
}

export function updateAttempt(project, options, forcedStatus) {
  const id = requiredOption(options, "id");
  const record = findRecord(loadIndex(project), "attempt", id);
  const loc = taskIdFromAttemptPath(record.path);
  if (!loc) throw new CliError(`Cannot infer task id for attempt: ${id}`, "invalid_record_path", 1);
  const filePath = projectPath(project, record.path);
  const current = readRecord(project, filePath);
  assertTransition("attempt", current.status, forcedStatus);
  updateMarkdownRecord(filePath, {
    status: forcedStatus,
    ...optionUpdates(options, ["validation", "review", "report"]),
  });
  appendLedgerEvent(project, { type: `attempt_${forcedStatus}`, id, source: "project-ledger" });
  return readRecord(project, filePath);
}

export function handleNestedCommand(command, subcommand, project, options) {
  if (command === "work") {
    if (subcommand === "create") return createWork(project, options);
    if (subcommand === "update") return updateWork(project, options);
    if (subcommand === "complete") return completeWork(project, options);
  }
  if (command === "task") {
    if (subcommand === "create") return createTask(project, options);
    if (subcommand === "update") return updateTask(project, options);
    if (subcommand === "complete") return updateTask(project, options, "done");
  }
  if (command === "attempt") {
    if (subcommand === "start") return createAttempt(project, options);
    if (subcommand === "succeed") return updateAttempt(project, options, "succeeded");
    if (subcommand === "fail") return updateAttempt(project, options, "failed");
  }
  throw new CliError(`Unknown command: ${command} ${subcommand ?? ""}`.trim(), "unknown_command", 2);
}

export function help() {
  return [
    "Project Ledger CLI",
    "",
    "Commands:",
    "  project-ledger init --project PATH --id ID --name NAME [--json]",
    "  project-ledger index --project PATH [--json]",
    "  project-ledger status --project PATH [--json]",
    "  project-ledger query --project PATH --kind KIND [--json]",
    "  project-ledger render --project PATH dashboard|handoff|roadmap [--write] [--json]",
    "  project-ledger doctor --project PATH [--json] [--fail-on-error] [--silent] [--verbose]",
    "  project-ledger check --project PATH [--json] [--silent] [--verbose]",
    "  project-ledger work create|update|complete --project PATH --id ID ...",
    "  project-ledger task create|update|complete --project PATH --id ID ...",
    "  project-ledger attempt start|succeed|fail --project PATH --id ID ...",
    "  project-ledger install-skill --target PATH [--mode symlink|copy]",
    "  project-ledger migrate-docs --project PATH [--write] [--json]",
    "",
    "Output Flags:",
    "  --silent   Suppress output on success (human mode only)",
    "  --verbose  Show detailed output (human mode only)",
    "  --json     Output structured JSON envelope (preserves full data)",
  ].join("\n");
}

export function handle(command, positionals, options) {
  const project = projectRoot(options);
  if (command === "init") return initProject(options);
  if (command === "index") return writeIndex(project);
  if (command === "status") return projectStatus(project);
  if (command === "query") {
    const kind = requiredOption(options, "kind");
    return { kind, results: queryIndex(loadIndex(project), kind) };
  }
  if (command === "render") {
    const viewName = positionals[0];
    if (!viewName) throw new CliError("render requires dashboard, handoff, or roadmap");
    return render(project, viewName, options);
  }
  if (command === "doctor") return doctor(project);
  if (command === "check") return check(project);
  if (command === "install-skill") return installSkill(options);
  if (command === "migrate-docs") return migrateDocs(project, options);
  if (command === "work" || command === "task" || command === "attempt") {
    return handleNestedCommand(command, positionals[0], project, options);
  }
  if (!command || command === "help") return help();
  throw new CliError(`Unknown command: ${command}`, "unknown_command", 2);
}

export function commandShouldFail(command, options, data) {
  if (command === "check") return data?.ok === false;
  if (command === "doctor" && options["fail-on-error"]) return data?.ok === false;
  if (command === "doctor" && options["fail-on-warning"]) return data?.issues?.length > 0;
  return false;
}
