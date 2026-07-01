import { existsSync } from "node:fs";
import { CliError, nowIso } from "./errors.js";
import { optionalString, requiredOption } from "./args.js";
import { appendLedgerEvent } from "./fs.js";
import {
  attemptRecordPath,
  readRecord,
  taskIdFromAttemptPath,
  taskRecordPath,
  updateMarkdownRecord,
  workIdFromTaskPath,
  workRecordPath,
} from "./records.js";
import {
  createRecord,
  optionUpdates,
  readBodyInput,
  resolveRecord,
  showRecord,
  updateRecord,
  writeAndReturn,
} from "./record-commands.js";
import { assertTransition, assertValidState, completionGateIssues } from "./state-machine.js";
import { refreshDerivedIndexAfterMutation } from "./indexer.js";

function baseRecord(kind, options, defaults = {}) {
  return {
    schema: `project-ledger.${kind}.v1`,
    kind,
    id: requiredOption(options, "id"),
    title: requiredOption(options, "title"),
    status: defaults.status,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...defaults,
  };
}

function findRecordPath(project, kind, id) {
  return resolveRecord(project, { kind, id }).filePath;
}

export function createWork(project, options) {
  const status = optionalString(options, "status") ?? "proposed";
  assertValidState("work", status, { action: "create", id: optionalString(options, "id") });
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
  return writeAndReturn(project, filePath, data, readBodyInput(options), "work_created");
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
      "reason",
    ]),
  };
  if (status) {
    assertTransition("work", current.status, status, { id });
    updates.status = status;
    if (status === "done") assertWorkCompletionGate(current, updates);
  }
  updateMarkdownRecord(filePath, updates, readBodyInput(options));
  appendLedgerEvent(project, { type: "work_updated", id, source: "project-ledger" });
  return refreshDerivedIndexAfterMutation(project, readRecord(project, filePath));
}

export function completeWork(project, options) {
  const id = requiredOption(options, "id");
  const filePath = findRecordPath(project, "work", id);
  const current = readRecord(project, filePath);
  if (current.status === "done") {
    throw new CliError(`Work is already completed: ${id}`, "invalid_transition", 2);
  }
  assertTransition("work", current.status, "done", { id });
  const updates = {
    status: "done",
    ...optionUpdates(options, ["spec", "acceptance", "validation", "review", "report", "codeCommits", "ledgerCommits"]),
  };
  const candidate = assertWorkCompletionGate(current, updates);
  updateMarkdownRecord(filePath, updates, readBodyInput(options));
  appendLedgerEvent(project, {
    type: "work_completed",
    id,
    report: candidate.report,
    source: "project-ledger",
  });
  return refreshDerivedIndexAfterMutation(project, readRecord(project, filePath));
}

function assertWorkCompletionGate(current, updates) {
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
      gaps.flatMap((gap) => gap.next ?? []),
    );
  }
  return candidate;
}

function showSpec(project, options) {
  return showRecord(project, { ...options, kind: "spec" });
}

function updateSpec(project, options) {
  return updateRecord(project, { ...options, kind: "spec" });
}

function createPlan(project, options) {
  return createRecord(project, { ...options, kind: "plan" });
}

function showPlan(project, options) {
  return showRecord(project, { ...options, kind: "plan" });
}

function updatePlan(project, options) {
  return updateRecord(project, { ...options, kind: "plan" });
}

export function createTask(project, options) {
  const workId = requiredOption(options, "work");
  resolveRecord(project, { kind: "work", id: workId });
  const status = optionalString(options, "status") ?? "todo";
  assertValidState("task", status, { action: "create", id: optionalString(options, "id"), workId });
  const data = {
    ...baseRecord("task", options, { status, parentId: workId }),
    ...optionUpdates(options, ["validation", "review", "report"]),
  };
  const filePath = taskRecordPath(project, workId, data.id);
  if (existsSync(filePath)) throw new CliError(`Task already exists: ${data.id}`, "record_exists");
  return writeAndReturn(project, filePath, data, readBodyInput(options), "task_created");
}

export function updateTask(project, options, forcedStatus = null) {
  const id = requiredOption(options, "id");
  const { filePath } = resolveRecord(project, { kind: "task", id });
  const current = readRecord(project, filePath);
  const status = forcedStatus ?? optionalString(options, "status");
  const updates = optionUpdates(options, ["title", "validation", "review", "report", "reason"]);
  if (status) {
    assertTransition("task", current.status, status, { id });
    updates.status = status;
  }
  updateMarkdownRecord(filePath, updates, readBodyInput(options));
  appendLedgerEvent(project, { type: "task_updated", id, source: "project-ledger" });
  return refreshDerivedIndexAfterMutation(project, readRecord(project, filePath));
}

export function createAttempt(project, options) {
  const taskId = requiredOption(options, "task");
  const { record: task } = resolveRecord(project, { kind: "task", id: taskId });
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
  return writeAndReturn(project, filePath, data, readBodyInput(options), "attempt_started");
}

export function updateAttempt(project, options, forcedStatus) {
  const id = requiredOption(options, "id");
  const { filePath, record } = resolveRecord(project, { kind: "attempt", id });
  const loc = taskIdFromAttemptPath(record.path);
  if (!loc) throw new CliError(`Cannot infer task id for attempt: ${id}`, "invalid_record_path", 1);
  const current = readRecord(project, filePath);
  assertTransition("attempt", current.status, forcedStatus, { id, taskId: current.parentId });
  updateMarkdownRecord(filePath, {
    status: forcedStatus,
    ...optionUpdates(options, ["validation", "review", "report"]),
  }, readBodyInput(options));
  appendLedgerEvent(project, { type: `attempt_${forcedStatus}`, id, source: "project-ledger" });
  return refreshDerivedIndexAfterMutation(project, readRecord(project, filePath));
}

function requireLifecycleKind(record, allowed, action) {
  if (allowed.includes(record.kind)) return;
  throw new CliError(
    `Cannot ${action} ${record.kind} record: ${record.id}`,
    "invalid_record_kind",
    1,
    [{ id: record.id, kind: record.kind, status: record.status }],
    allowed.map((kind) => ({
      command: `project-ledger record ${action} --kind ${kind} --id <${kind}-id>`,
      reason: `Choose a ${kind} record for ${action}.`,
    })),
  );
}

export function lifecycleRecordAction(project, options, action) {
  const { record } = resolveRecord(project, options);
  if (action === "start") {
    requireLifecycleKind(record, ["work", "task", "attempt"], action);
    if (record.kind === "work") return updateWork(project, { ...options, id: record.id, status: "in_progress" });
    if (record.kind === "task") return updateTask(project, { ...options, id: record.id, status: "in_progress" });
    return updateAttempt(project, { ...options, id: record.id }, "started");
  }
  if (action === "review") {
    requireLifecycleKind(record, ["work"], action);
    return updateWork(project, { ...options, id: record.id, status: "review" });
  }
  if (action === "complete") {
    requireLifecycleKind(record, ["work", "task", "attempt"], action);
    if (record.kind === "work") return completeWork(project, { ...options, id: record.id });
    if (record.kind === "task") return updateTask(project, { ...options, id: record.id }, "done");
    return updateAttempt(project, { ...options, id: record.id }, "succeeded");
  }
  if (action === "block" || action === "cancel") {
    requireLifecycleKind(record, ["work", "task"], action);
    const status = action === "block" ? "blocked" : "cancelled";
    if (record.kind === "work") return updateWork(project, { ...options, id: record.id, status });
    return updateTask(project, { ...options, id: record.id, status });
  }
  throw new CliError(`Unknown record lifecycle action: ${action}`, "unknown_command", 2);
}

export function handleNestedCommand(command, subcommand, project, options) {
  if (command === "work") {
    if (subcommand === "create") return createWork(project, options);
    if (subcommand === "update") return updateWork(project, options);
    if (subcommand === "complete") return completeWork(project, options);
  }
  if (command === "spec") {
    if (subcommand === "show") return showSpec(project, options);
    if (subcommand === "update") return updateSpec(project, options);
  }
  if (command === "plan") {
    if (subcommand === "create") return createPlan(project, options);
    if (subcommand === "show") return showPlan(project, options);
    if (subcommand === "update") return updatePlan(project, options);
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
  if (command === "record") {
    if (subcommand === "create") return createRecord(project, options);
    if (subcommand === "show") return showRecord(project, options);
    if (subcommand === "update") return updateRecord(project, options);
    if (["start", "review", "complete", "block", "cancel"].includes(subcommand)) {
      return lifecycleRecordAction(project, options, subcommand);
    }
  }
  throw new CliError(`Unknown command: ${command} ${subcommand ?? ""}`.trim(), "unknown_command", 2);
}
