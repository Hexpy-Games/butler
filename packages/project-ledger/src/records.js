import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import {
  PRIVATE_CONTENT_PATTERNS,
  VALID_ATTEMPT_STATES,
  VALID_TASK_STATES,
  VALID_WORK_STATES,
} from "./constants.js";
import { CliError, nowIso } from "./errors.js";
import { ensureDir, ledgerRoot, listFiles, projectRelative, safeReadJson } from "./fs.js";
import { frontmatterBody, markdownWithFrontmatter, parseFrontmatter } from "./frontmatter.js";
import { completionGateIssues } from "./state-machine.js";
import { isNonAuthoritativeProjectLedgerStorage } from "./storage-authority.js";

export function issue(code, severity, message, path, record = null) {
  return {
    code,
    severity,
    message,
    path,
    record: record ? recordReference(record) : null,
  };
}

export function recordReference(record, reason = null) {
  const ref = {
    id: record.id,
    kind: record.kind,
    title: record.title,
    status: record.status,
    path: record.path,
  };
  if (reason) ref.reason = reason;
  return ref;
}

export function inferKind(relPath, data) {
  const ledgerPath = ledgerContentPath(relPath);
  if (typeof data.kind === "string" && data.kind) return data.kind;
  if (ledgerPath === "project.json") return "project";
  if (/^work\/[^/]+\/tasks\/[^/]+\/attempts\//u.test(ledgerPath)) return "attempt";
  if (/^work\/[^/]+\/tasks\//u.test(ledgerPath)) return "task";
  if (ledgerPath.startsWith("work/")) return "work";
  if (ledgerPath.startsWith("initiatives/")) return "initiative";
  if (ledgerPath.startsWith("decisions/")) return "decision";
  if (ledgerPath.startsWith("risks/")) return "risk";
  if (ledgerPath.startsWith("specs/")) return "spec";
  if (ledgerPath.startsWith("reports/")) return "report";
  if (ledgerPath.startsWith("plans/")) return "plan";
  if (ledgerPath.startsWith("handoffs/")) return "handoff";
  if (ledgerPath.startsWith("references/")) return "reference";
  if (ledgerPath.startsWith("roadmaps/")) return "roadmap";
  return "record";
}

export function readRecordData(filePath) {
  const text = readFileSync(filePath, "utf8");
  if (filePath.endsWith(".json")) return safeReadJson(filePath);
  if (filePath.endsWith(".md")) return parseFrontmatter(text) ?? {};
  return null;
}

export function readRecord(project, filePath) {
  const relPath = projectRelative(project, filePath);
  if (relPath.endsWith("ledger.jsonl")) return null;
  if (isNonAuthoritativeProjectLedgerStorage(filePath)) return null;
  const stats = statSync(filePath);
  const data = readRecordData(filePath);
  if (!data) return null;

  const semanticPath = relative(ledgerRoot(project), filePath).split("\\").join("/");
  const kind = inferKind(semanticPath, data);
  const id = typeof data.id === "string" && data.id.trim()
    ? data.id.trim()
    : basename(filePath).replace(/\.(json|md)$/u, "");
  return {
    id,
    kind,
    title: String(data.title ?? data.name ?? id),
    status: String(data.status ?? "unknown"),
    priority: typeof data.priority === "number" ? data.priority : 100,
    parentId: typeof data.parentId === "string" ? data.parentId : null,
    spec: typeof data.spec === "string" ? data.spec : null,
    specExemption: Boolean(data.specExemption),
    acceptance: typeof data.acceptance === "string" ? data.acceptance : null,
    acceptanceExemption: Boolean(data.acceptanceExemption),
    requiresCommitEvidence: Boolean(data.requiresCommitEvidence),
    codeCommits: typeof data.codeCommits === "string" ? data.codeCommits : null,
    ledgerCommits: typeof data.ledgerCommits === "string" ? data.ledgerCommits : null,
    report: typeof data.report === "string" ? data.report : null,
    review: typeof data.review === "string" ? data.review : null,
    validation: typeof data.validation === "string" ? data.validation : null,
    implementation: typeof data.implementation === "string" ? data.implementation : null,
    mitigation: typeof data.mitigation === "string" ? data.mitigation : null,
    reason: typeof data.reason === "string" ? data.reason : null,
    updatedAt: String(data.updatedAt ?? new Date(stats.mtimeMs).toISOString()),
    path: relPath,
    sourceMtimeMs: stats.mtimeMs,
  };
}

export function readRecordBody(filePath) {
  if (!filePath.endsWith(".md")) return null;
  return frontmatterBody(readFileSync(filePath, "utf8"));
}

export function recordFiles(project) {
  const root = ledgerRoot(project);
  const projectFile = join(root, "project.json");
  return [
    projectFile,
    ...listFiles(root, { skipDirs: new Set(["index", "views"]) })
      .filter((file) => file !== projectFile && !file.endsWith("ledger.jsonl") &&
        !isNonAuthoritativeProjectLedgerStorage(file)),
  ].filter((file) => existsSync(file));
}

export function sourceMaxMtimeMs(project) {
  return recordFiles(project).reduce((max, file) => Math.max(max, statSync(file).mtimeMs), 0);
}

export function validateRecord(record, recordsById) {
  const issues = [];
  if (!record.id || record.id === "work" || record.id === "project") {
    issues.push(issue("invalid_schema", "error", "Record id is missing or too generic", record.path, record));
  }
  if (record.kind === "work" && !VALID_WORK_STATES.has(record.status)) {
    issues.push(issue("invalid_state", "error", `Invalid work state: ${record.status}`, record.path, record));
  }
  if (record.kind === "task" && !VALID_TASK_STATES.has(record.status)) {
    issues.push(issue("invalid_state", "error", `Invalid task state: ${record.status}`, record.path, record));
  }
  if (record.kind === "attempt" && !VALID_ATTEMPT_STATES.has(record.status)) {
    issues.push(issue("invalid_state", "error", `Invalid attempt state: ${record.status}`, record.path, record));
  }
  if (record.kind === "task" && record.parentId && !recordsById.has(record.parentId)) {
    issues.push(issue("orphan_task", "error", `Task parent does not exist: ${record.parentId}`, record.path, record));
  }
  if (
    record.kind === "work" &&
    !["done", "cancelled"].includes(record.status) &&
    !record.spec &&
    !record.specExemption
  ) {
    issues.push(issue("missing_spec", "warning", "Active work has no linked spec or spec exemption", record.path, record));
  }
  for (const gateIssue of completionGateIssues(record)) {
    issues.push(issue("completion_gate", "error", gateIssue.message, record.path, record));
  }
  return issues;
}

export function scanPrivacy(project) {
  const findings = [];
  for (const file of listFiles(ledgerRoot(project), { skipDirs: new Set(["index", "views"]) })) {
    if (file.endsWith("ledger.jsonl")) continue;
    if (isNonAuthoritativeProjectLedgerStorage(file)) continue;
    const text = readFileSync(file, "utf8");
    if (PRIVATE_CONTENT_PATTERNS.some((pattern) => pattern.test(text))) {
      findings.push(issue(
        "possible_private_content",
        "error",
        "Record may contain private content; inspect locally without copying raw text.",
        projectRelative(project, file),
      ));
    }
  }
  return findings;
}

export function workRecordPath(project, id) {
  return join(ledgerRoot(project), "work", safeRecordId(id), "work.md");
}

export function topLevelRecordPath(project, kind, id) {
  const dir = {
    initiative: "initiatives",
    decision: "decisions",
    risk: "risks",
    spec: "specs",
    report: "reports",
    plan: "plans",
    handoff: "handoffs",
    reference: "references",
    roadmap: "roadmaps",
  }[kind];
  if (!dir) throw new CliError(`Unsupported top-level record kind: ${kind}`, "invalid_input", 1);
  return join(ledgerRoot(project), dir, `${safeRecordId(id).toLowerCase()}.md`);
}

export function taskRecordPath(project, workId, id) {
  return join(ledgerRoot(project), "work", safeRecordId(workId), "tasks", `${safeRecordId(id)}.md`);
}

export function attemptRecordPath(project, workId, taskId, id) {
  return join(
    ledgerRoot(project),
    "work",
    safeRecordId(workId),
    "tasks",
    safeRecordId(taskId),
    "attempts",
    `${safeRecordId(id)}.md`,
  );
}

export function writeMarkdownRecord(filePath, data, body = null) {
  ensureDir(dirname(filePath));
  const text = body ?? `# ${data.title ?? data.id}\n\nManaged by Project Ledger.`;
  writeFileSync(filePath, markdownWithFrontmatter({
    ...data,
    updatedAt: nowIso(),
  }, text), "utf8");
}

export function updateMarkdownRecord(filePath, updates, bodyOverride = undefined) {
  const existingText = readFileSync(filePath, "utf8");
  const existing = readRecordData(filePath) ?? {};
  const body = bodyOverride ?? (frontmatterBody(existingText) || `# ${updates.title ?? existing.title ?? existing.id}\n`);
  writeMarkdownRecord(filePath, { ...existing, ...updates }, body);
}

export function findRecord(index, kind, id) {
  const matches = index.records.filter((record) => record.kind === kind && record.id === id);
  if (matches.length === 0) throw new CliError(`${kind} not found: ${id}`, "record_not_found", 1);
  if (matches.length > 1) throw new CliError(`${kind} id is ambiguous: ${id}`, "ambiguous_record", 1);
  return matches[0];
}

export function workIdFromTaskPath(path) {
  const match = ledgerContentPath(path).match(/^work\/([^/]+)\/tasks\//u);
  return match?.[1] ?? null;
}

export function taskIdFromAttemptPath(path) {
  const match = ledgerContentPath(path).match(/^work\/([^/]+)\/tasks\/([^/]+)\/attempts\//u);
  return match ? { workId: match[1], taskId: match[2] } : null;
}

function ledgerContentPath(path) {
  const normalized = path.split("\\").join("/");
  const canonicalMatch = normalized.match(/^project-ledger\/projects\/[^/]+(?:\/(.*))?$/u);
  if (canonicalMatch) return canonicalMatch[1] ?? "";
  return normalized;
}

function safeRecordId(id) {
  const value = String(id ?? "").trim();
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    throw new CliError(`Invalid record id: ${value || "(empty)"}`, "invalid_input", 1);
  }
  return value;
}
