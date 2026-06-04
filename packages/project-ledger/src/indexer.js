import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { COUNTED_KINDS, INDEX_PATH, LEDGER_DIR, VIEW_NAMES } from "./constants.js";
import { CliError, nowIso } from "./errors.js";
import {
  appendLedgerEvent,
  ensureDir,
  ledgerRoot,
  projectPath,
  projectRelative,
  requireLedger,
  safeReadJson,
  safeWriteJson,
} from "./fs.js";
import {
  issue,
  readRecord,
  recordFiles,
  recordReference,
  scanPrivacy,
  sourceMaxMtimeMs,
  validateRecord,
} from "./records.js";

export function countRecords(records) {
  const counts = Object.fromEntries(COUNTED_KINDS.map((kind) => [kind, 0]));
  counts.records = records.length;
  for (const record of records) {
    if (Object.prototype.hasOwnProperty.call(counts, record.kind)) counts[record.kind] += 1;
  }
  return counts;
}

export function viewStatuses(project, maxSourceMtimeMs) {
  return VIEW_NAMES.map((view) => {
    const relPath = `${LEDGER_DIR}/views/${view}.md`;
    const path = projectPath(project, relPath);
    const displayPath = projectRelative(project, path);
    if (!existsSync(path)) return { name: view, path: displayPath, exists: false, stale: true };
    const mtimeMs = statSync(path).mtimeMs;
    return {
      name: view,
      path: displayPath,
      exists: true,
      stale: mtimeMs < maxSourceMtimeMs,
      updatedAt: new Date(mtimeMs).toISOString(),
    };
  });
}

export function indexFreshness(project) {
  const path = projectPath(project, INDEX_PATH);
  const displayPath = projectRelative(project, path);
  if (!existsSync(path)) {
    return { available: false, stale: true, generatedAt: null, path: displayPath };
  }
  const indexMtimeMs = statSync(path).mtimeMs;
  return {
    available: true,
    stale: indexMtimeMs < sourceMaxMtimeMs(project),
    generatedAt: new Date(indexMtimeMs).toISOString(),
    path: displayPath,
  };
}

export function buildIndex(project) {
  requireLedger(project);
  const projectFile = join(ledgerRoot(project), "project.json");
  if (!existsSync(projectFile)) throw new CliError("project.json is missing", "missing_project", 1);

  const records = [];
  const parseIssues = [];
  for (const file of recordFiles(project)) {
    try {
      const record = readRecord(project, file);
      if (record) records.push(record);
    } catch (error) {
      parseIssues.push(issue(
        "invalid_schema",
        "error",
        `Cannot parse record: ${error instanceof Error ? error.message : "unknown error"}`,
        file,
      ));
    }
  }

  const recordsById = new Map(records.map((record) => [record.id, record]));
  const validationIssues = records.flatMap((record) => validateRecord(record, recordsById));
  const maxSourceMtimeMs = records.reduce((max, record) => Math.max(max, record.sourceMtimeMs), 0);
  const projectRecord = records.find((record) => record.kind === "project");

  return {
    schema: "project-ledger.index.v1",
    generatedAt: nowIso(),
    project: projectRecord
      ? {
          id: projectRecord.id,
          name: projectRecord.title,
          status: projectRecord.status,
          path: projectRecord.path,
        }
      : safeReadJson(projectFile),
    counts: countRecords(records),
    records: records.map(({ sourceMtimeMs: _sourceMtimeMs, ...record }) => record),
    issues: [...parseIssues, ...validationIssues],
    views: viewStatuses(project, maxSourceMtimeMs),
    index: indexFreshness(project),
    privacy: {
      rawTextIncluded: false,
      secretsIncluded: false,
    },
  };
}

export function writeIndex(project) {
  const index = buildIndex(project);
  const path = projectPath(project, INDEX_PATH);
  ensureDir(dirname(path));
  const displayPath = projectRelative(project, path);
  safeWriteJson(path, {
    ...index,
    index: { available: true, stale: false, generatedAt: nowIso(), path: displayPath },
  });
  appendLedgerEvent(project, {
    type: "index_written",
    records: index.counts.records,
    issues: index.issues.length,
    source: "project-ledger",
  });
  return readIndex(project);
}

export function readIndex(project) {
  const path = projectPath(project, INDEX_PATH);
  if (!existsSync(path)) return null;
  const index = safeReadJson(path);
  return { ...normalizeIndexPaths(project, index), index: indexFreshness(project) };
}

export function loadIndex(project) {
  return readIndex(project) ?? buildIndex(project);
}

export function sortRecords(records) {
  return [...records].sort((a, b) => {
    const priority = (a.priority ?? 100) - (b.priority ?? 100);
    if (priority !== 0) return priority;
    return String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")) || a.id.localeCompare(b.id);
  });
}

export function queryIndex(index, kind) {
  const records = index.records.filter((record) => record.kind !== "project");
  if (kind === "next-actions") {
    return sortRecords(records.filter((record) =>
      ["work", "task"].includes(record.kind) &&
      ["proposed", "scoped", "specified", "in_progress", "todo"].includes(record.status),
    )).map((record) => recordReference(record, "active_next_action"));
  }
  if (kind === "blocked") {
    return sortRecords(records.filter((record) => record.status === "blocked"))
      .map((record) => recordReference(record, "blocked"));
  }
  if (kind === "review") {
    return sortRecords(records.filter((record) => record.status === "review"))
      .map((record) => recordReference(record, "review_ready"));
  }
  if (kind === "missing-spec") {
    return index.issues
      .filter((item) => item.code === "missing_spec" && item.record)
      .map((item) => ({ ...item.record, reason: item.message }));
  }
  if (kind === "completion-gaps") {
    return index.issues
      .filter((item) => item.code === "completion_gate" && item.record)
      .map((item) => ({ ...item.record, reason: item.message }));
  }
  if (kind === "stale-view") {
    return index.views
      .filter((view) => view.stale)
      .map((view) => ({
        id: view.name,
        kind: "view",
        title: `${view.name} view`,
        status: view.exists ? "stale" : "missing",
        path: view.path,
        reason: view.exists ? "generated_view_stale" : "generated_view_missing",
      }));
  }
  if (kind === "stale-index") {
    return index.index?.stale ? [{
      id: "project-index",
      kind: "index",
      title: "Project Ledger compact index",
      status: index.index.available ? "stale" : "missing",
      path: index.index?.path ?? INDEX_PATH,
      reason: index.index.available ? "compact_index_stale" : "compact_index_missing",
    }] : [];
  }
  if (kind === "decision-without-implementation") {
    return sortRecords(records.filter((record) => record.kind === "decision" && !record.implementation))
      .map((record) => recordReference(record, "decision_without_implementation"));
  }
  if (kind === "risk-without-mitigation") {
    return sortRecords(records.filter((record) => record.kind === "risk" && record.status !== "closed" && !record.mitigation))
      .map((record) => recordReference(record, "risk_without_mitigation"));
  }
  if (kind === "recent-completed") {
    return sortRecords(records.filter((record) => record.status === "done"))
      .map((record) => recordReference(record, "recent_completed"));
  }
  throw new CliError(`Unsupported query kind: ${kind}`, "invalid_query_kind");
}

export function projectStatus(project) {
  const index = loadIndex(project);
  return {
    project: index.project,
    index: index.index,
    counts: index.counts,
    issueCount: index.issues.length,
    staleViews: queryIndex(index, "stale-view"),
    nextActions: queryIndex(index, "next-actions").slice(0, 5),
  };
}

export function doctor(project) {
  const indexAvailable = existsSync(projectPath(project, INDEX_PATH));
  const index = buildIndex(project);
  const issues = [...index.issues];
  if (!indexAvailable) {
    issues.unshift(issue("missing_index", "warning", "Index has not been written yet", INDEX_PATH));
  } else if (indexFreshness(project).stale) {
    issues.unshift(issue("stale_index", "warning", "Index is older than source records", INDEX_PATH));
  }
  for (const view of index.views) {
    if (view.stale) {
      issues.push(issue(
        "stale_view",
        "warning",
        view.exists ? "Generated view is older than source records" : "Generated view is missing",
        view.path,
      ));
    }
  }
  issues.push(...scanPrivacy(project));
  return {
    ok: !issues.some((item) => item.severity === "error"),
    issueCount: issues.length,
    issues,
    counts: index.counts,
  };
}

export function check(project) {
  const result = doctor(project);
  return {
    ...result,
    ok: result.issues.length === 0,
  };
}

function normalizeIndexPaths(project, index) {
  return {
    ...index,
    project: index.project ? normalizeRecordPath(project, index.project) : index.project,
    records: Array.isArray(index.records)
      ? index.records.map((record) => normalizeRecordPath(project, record))
      : index.records,
    issues: Array.isArray(index.issues)
      ? index.issues.map((item) => ({
        ...item,
        path: normalizeLedgerDisplayPath(project, item.path),
        record: item.record ? normalizeRecordPath(project, item.record) : item.record,
      }))
      : index.issues,
    views: Array.isArray(index.views)
      ? index.views.map((view) => ({
        ...view,
        path: normalizeLedgerDisplayPath(project, view.path),
      }))
      : index.views,
  };
}

function normalizeRecordPath(project, record) {
  return {
    ...record,
    path: normalizeLedgerDisplayPath(project, record.path),
  };
}

function normalizeLedgerDisplayPath(project, path) {
  if (typeof path !== "string" || !path.trim()) return path;
  const normalized = path.split("\\").join("/");
  if (
    normalized === LEDGER_DIR ||
    normalized.startsWith(`${LEDGER_DIR}/`) ||
    normalized.startsWith("project-ledger/projects/")
  ) {
    return projectRelative(project, projectPath(project, normalized));
  }
  return normalized;
}
