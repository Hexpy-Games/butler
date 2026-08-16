import { join } from "node:path";

export const INDEX_PATH = join("index", "project.json");
export const VIEW_NAMES = ["dashboard", "handoff", "roadmap"];
export const LAYOUT_DIRS = [
  "initiatives",
  "work",
  "decisions",
  "risks",
  "specs",
  "reports",
  "plans",
  "handoffs",
  "references",
  "roadmaps",
  "index",
  "views",
];

export const COUNTED_KINDS = [
  "records",
  "initiative",
  "work",
  "task",
  "attempt",
  "decision",
  "risk",
  "spec",
  "report",
  "plan",
  "handoff",
  "reference",
  "roadmap",
];

export const VALID_WORK_STATES = new Set([
  "proposed",
  "scoped",
  "specified",
  "in_progress",
  "review",
  "done",
  "blocked",
  "cancelled",
]);
export const VALID_TASK_STATES = new Set([
  "todo",
  "in_progress",
  "done",
  "blocked",
  "failed",
  "cancelled",
]);
export const VALID_ATTEMPT_STATES = new Set(["started", "succeeded", "failed", "interrupted"]);

export const BOOLEAN_FLAGS = new Set([
  "json",
  "write",
  "help",
  "body",
  "fail-on-error",
  "fail-on-warning",
  "spec-exemption",
  "acceptance-exemption",
  "requires-commit-evidence",
  "silent",
  "verbose",
]);

export const PRIVATE_CONTENT_PATTERNS = [
  /OPENAI_API_KEY\s*=/i,
  /BEGIN PRIVATE TRANSCRIPT/i,
  /rawTranscript\s*[:=]/i,
  /private transcript\s*[:=]/i,
  /authorization:\s*bearer/i,
  /AWS_SECRET_ACCESS_KEY\s*=/i,
  /BEGIN RSA PRIVATE KEY/i,
];
