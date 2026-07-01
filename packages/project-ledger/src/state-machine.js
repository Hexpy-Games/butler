import { VALID_ATTEMPT_STATES, VALID_TASK_STATES, VALID_WORK_STATES } from "./constants.js";
import { CliError } from "./errors.js";

const WORK_TRANSITIONS = {
  proposed: ["scoped", "blocked", "cancelled"],
  scoped: ["specified", "in_progress", "blocked", "cancelled"],
  specified: ["in_progress", "review", "blocked", "cancelled"],
  in_progress: ["review", "blocked", "cancelled"],
  review: ["done", "in_progress", "blocked", "cancelled"],
  blocked: ["in_progress", "cancelled"],
  done: [],
  cancelled: [],
};

const TASK_TRANSITIONS = {
  todo: ["in_progress", "blocked", "cancelled"],
  in_progress: ["done", "failed", "blocked", "cancelled"],
  blocked: ["in_progress", "cancelled"],
  failed: ["in_progress", "cancelled"],
  done: [],
  cancelled: [],
};

const ATTEMPT_TRANSITIONS = {
  started: ["succeeded", "failed", "interrupted"],
  succeeded: [],
  failed: [],
  interrupted: [],
};

function validStates(kind) {
  if (kind === "work") return VALID_WORK_STATES;
  if (kind === "task") return VALID_TASK_STATES;
  if (kind === "attempt") return VALID_ATTEMPT_STATES;
  return new Set(["unknown"]);
}

function transitionMap(kind) {
  if (kind === "work") return WORK_TRANSITIONS;
  if (kind === "task") return TASK_TRANSITIONS;
  if (kind === "attempt") return ATTEMPT_TRANSITIONS;
  return {};
}

function lifecycleCommand(kind, id, status, context = {}) {
  const target = id ?? "<id>";
  if (context.action === "create") {
    if (kind === "work") return `project-ledger work create --id ${target} --status ${status}`;
    if (kind === "task") {
      return `project-ledger task create --work ${context.workId ?? "<work-id>"} --id ${target} --status ${status}`;
    }
  }
  if (kind === "work" && status === "done") return `project-ledger work complete --id ${target}`;
  if (kind === "task" && status === "done") return `project-ledger task complete --id ${target}`;
  if (kind === "attempt" && status === "succeeded") return `project-ledger attempt succeed --id ${target}`;
  if (kind === "attempt" && status === "failed") return `project-ledger attempt fail --id ${target}`;
  if (kind === "attempt" && status === "started") {
    return `project-ledger attempt start --task ${context.taskId ?? "<task-id>"} --id ${target}`;
  }
  return `project-ledger ${kind} update --id ${target} --status ${status}`;
}

function recordDetail(kind, status, id = null) {
  return [id ? { id, kind, status } : { kind, status }];
}

export function stateHint(kind, status, context = {}) {
  return [...validStates(kind)].map((validState) => ({
    command: lifecycleCommand(kind, context.id, validState, context),
    reason: `Use a valid ${kind} state instead of ${status}: ${validState}.`,
  }));
}

export function transitionHint(kind, from, to, context = {}) {
  const id = context.id ?? null;
  const allowed = transitionMap(kind)[from] ?? [];
  if (kind === "task" && from === "todo" && to === "done") {
    const target = id ?? "<id>";
    return [
      {
        command: `project-ledger task update --id ${target} --status in_progress`,
        reason: "Move the task to in_progress first.",
      },
      {
        command: `project-ledger task complete --id ${target}`,
        reason: "Retry completion after the task is in_progress.",
      },
    ];
  }
  if (allowed.length > 0) {
    return allowed.map((status) => ({
      command: lifecycleCommand(kind, id, status, context),
      reason: `Transition ${kind} from ${from} to ${status} before retrying ${to}.`,
    }));
  }
  return [{
    command: kind === "attempt"
      ? lifecycleCommand(kind, id ?? "<new-id>", "started", context)
      : `project-ledger ${kind} create --id ${id ?? "<new-id>"}`,
    reason: `${kind} records in ${from} cannot transition to ${to}; create or choose an active record.`,
  }];
}

export function assertValidState(kind, status, context = {}) {
  if (!validStates(kind).has(status)) {
    throw new CliError(
      `Invalid ${kind} state: ${status}`,
      "invalid_state",
      2,
      recordDetail(kind, status, context.id),
      stateHint(kind, status, context),
    );
  }
}

export function assertTransition(kind, from, to, context = {}) {
  assertValidState(kind, to, context);
  if (!from || from === "unknown" || from === to) return;
  const allowed = transitionMap(kind)[from] ?? [];
  if (!allowed.includes(to)) {
    throw new CliError(
      `Invalid ${kind} transition: ${from} -> ${to}`,
      "invalid_transition",
      2,
      recordDetail(kind, from, context.id),
      transitionHint(kind, from, to, context),
    );
  }
}

export function completionGateIssues(record) {
  if (record.kind !== "work" || record.status !== "done") return [];
  const missing = [];
  if (!record.spec && !record.specExemption) missing.push("spec");
  if (!record.acceptance && !record.acceptanceExemption) missing.push("acceptance");
  if (!record.validation) missing.push("validation");
  if (!record.review) missing.push("review");
  if (!record.report) missing.push("report");
  if (record.requiresCommitEvidence && !hasCodeCommitEvidence(record.codeCommits)) missing.push("codeCommits");
  return missing.map((field) => ({
    code: `missing_${field}`,
    field,
    message: `Completed work is missing ${field} evidence`,
    next: completionGateNext(field, record.id),
  }));
}

function completionGateNext(field, id = null) {
  const target = id ?? "<id>";
  const flag = {
    spec: "--spec SPEC-ID or --spec-exemption",
    acceptance: "--acceptance TEXT or --acceptance-exemption",
    validation: "--validation TEXT",
    review: "--review TEXT",
    report: "--report PATH",
    codeCommits: "--code-commits JSON or --code-commit auto",
  }[field] ?? `--${field} VALUE`;
  return [{
    command: `project-ledger work complete --id ${target} ${flag}`,
    reason: `Provide ${field} evidence before completing the work.`,
  }];
}

function hasCodeCommitEvidence(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const commits = JSON.parse(value);
    return Array.isArray(commits) && commits.some((commit) => (
      commit &&
      typeof commit.repo === "string" &&
      commit.repo.trim() &&
      typeof commit.hash === "string" &&
      commit.hash.trim() &&
      typeof commit.message === "string" &&
      commit.message.trim()
    ));
  } catch {
    return false;
  }
}
