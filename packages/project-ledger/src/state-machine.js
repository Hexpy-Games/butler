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

export function assertValidState(kind, status) {
  if (!validStates(kind).has(status)) {
    throw new CliError(`Invalid ${kind} state: ${status}`, "invalid_state");
  }
}

export function assertTransition(kind, from, to) {
  assertValidState(kind, to);
  if (!from || from === "unknown" || from === to) return;
  const allowed = transitionMap(kind)[from] ?? [];
  if (!allowed.includes(to)) {
    throw new CliError(`Invalid ${kind} transition: ${from} -> ${to}`, "invalid_transition");
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
  }));
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
