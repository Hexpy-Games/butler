import { CliError } from "./errors.js";
import { recordReference } from "./records.js";

export function sortRecords(records) {
  return [...records].sort((a, b) => {
    const priority = (a.priority ?? 100) - (b.priority ?? 100);
    if (priority !== 0) return priority;
    return String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")) || a.id.localeCompare(b.id);
  });
}

export function queryIndex(index, kind, options = {}) {
  const records = index.records.filter((record) => record.kind !== "project");
  const status = typeof options.status === "string" && options.status.trim() ? options.status.trim() : null;
  const recordKinds = new Set([
    "all",
    "initiative",
    "decision",
    "risk",
    "spec",
    "report",
    "plan",
    "handoff",
    "reference",
    "roadmap",
    "work",
    "task",
    "attempt",
  ]);
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
      path: index.index?.path ?? "index/project.json",
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
  if (recordKinds.has(kind)) {
    return sortRecords(records.filter((record) =>
      (kind === "all" || record.kind === kind) &&
      (status === null || record.status === status),
    )).map((record) => recordReference(record));
  }
  throw new CliError(`Unsupported query kind: ${kind}`, "invalid_query_kind");
}
