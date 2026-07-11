import { runProjectLedgerTool } from "../../../integrations/project-ledger/client.ts";
import { projectLedgerNativeNextHints } from "./recovery-hints.ts";

type ProjectLedgerCloseoutInput = {
  butlerHome: string;
  butlerData?: string;
};

type ProjectLedgerToolRunner = typeof runProjectLedgerTool;
type ProjectLedgerViewName = "dashboard" | "handoff" | "roadmap";

const LIFECYCLE_CLOSEOUT_TOOLS = new Set([
  "project_ledger_create",
  "project_ledger_update",
  "project_ledger_work_update",
  "project_ledger_work_complete",
  "project_ledger_task_update",
  "project_ledger_task_complete",
]);

const GENERATED_VIEWS: readonly ProjectLedgerViewName[] = [
  "dashboard",
  "handoff",
  "roadmap",
];

export function needsProjectLedgerLifecycleCloseout(
  toolName: string,
  result: Record<string, unknown>,
): boolean {
  return LIFECYCLE_CLOSEOUT_TOOLS.has(toolName) && result.ok === true;
}

export function runProjectLedgerLifecycleCloseout(input: {
  executor: ProjectLedgerCloseoutInput;
  projectPath: string;
  runTool?: ProjectLedgerToolRunner;
  refreshedIndex?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const runTool = input.runTool ?? runProjectLedgerTool;
  const project = ["--project", input.projectPath];
  const indexResult = input.refreshedIndex ?? runTool(input.executor, ["index", ...project]);
  const indexOk = indexResult.ok === true;
  if (!indexOk) {
    return {
      ok: false,
      index_ok: false,
      index_path: stringAt(indexResult, ["data", "index", "path"]),
      index_error: projectLedgerErrorSummary(indexResult),
      rendered_views: GENERATED_VIEWS.map((view) => skippedViewSummary(view, "index_failed")),
      check_ok: false,
      check_skipped: true,
      issue_count: 0,
      issues: [],
      failed_stages: ["index"],
    };
  }
  const renderedViews = GENERATED_VIEWS.map((view) =>
    renderViewSummary(view, runTool(input.executor, [
      "render",
      ...project,
      view,
      "--write",
    ])),
  );
  const checkResult = runTool(input.executor, ["check", ...project]);
  const renderOk = renderedViews.every((view) => view.ok === true);
  const checkOk = checkResult.ok === true;
  const failedStages = closeoutFailedStages({
    indexOk,
    renderedViews,
    checkOk,
  });
  return {
    ok: failedStages.length === 0,
    index_ok: indexOk,
    index_path: stringAt(indexResult, ["data", "index", "path"]),
    rendered_views: renderedViews,
    check_ok: checkOk,
    issue_count: issueCount(checkResult),
    issues: boundedIssues(checkResult),
    failed_stages: failedStages,
    ...(renderOk ? {} : { render_error: renderErrorSummary(renderedViews) }),
    ...(checkOk ? {} : { check_error: projectLedgerErrorSummary(checkResult) }),
  };
}

export function applyProjectLedgerLifecycleCloseout(
  result: Record<string, unknown>,
  closeout: Record<string, unknown>,
): Record<string, unknown> {
  if (closeout.ok === true) {
    return {
      ...result,
      project_ledger_closeout: closeout,
    };
  }
  return {
    ok: false,
    recoverable: true,
    observation_kind: "validation_failed",
    error: projectLedgerCloseoutFailureError(closeout),
    mutation_result: result,
    project_ledger_closeout: closeout,
  };
}

function renderViewSummary(
  view: ProjectLedgerViewName,
  result: Record<string, unknown>,
): Record<string, unknown> {
  const path = stringAt(result, ["data", "path"]);
  const written = booleanAt(result, ["data", "written"]);
  const ok = result.ok === true && written && Boolean(path);
  return {
    view,
    ok,
    path,
    written,
    ...(ok ? {} : { error: renderFailureSummary(result, written, path) }),
  };
}

function renderFailureSummary(
  result: Record<string, unknown>,
  written: boolean,
  path: string | null,
): Record<string, unknown> {
  if (result.ok !== true) return projectLedgerErrorSummary(result);
  return {
    code: "project_ledger_render_not_written",
    message: !written
      ? "Project Ledger render reported success without writing the generated view."
      : "Project Ledger render reported success without a generated view path.",
    next: [],
    native_next: [{
      tool: "project_ledger_render",
      args: { write: true },
      reason: path
        ? "Rerun Project Ledger render with write enabled and verify the generated view path."
        : "Rerun Project Ledger render with write enabled so the generated view path is available.",
    }],
  };
}

function skippedViewSummary(view: ProjectLedgerViewName, reason: string): Record<string, unknown> {
  return {
    view,
    ok: false,
    path: null,
    written: false,
    skipped: true,
    reason,
  };
}

function closeoutFailedStages(input: {
  indexOk: boolean;
  renderedViews: Array<Record<string, unknown>>;
  checkOk: boolean;
}): string[] {
  const stages: string[] = [];
  if (!input.indexOk) stages.push("index");
  const renderFailed = input.renderedViews.some((view) => view.ok !== true && view.skipped !== true);
  if (renderFailed) stages.push("render");
  if (!input.checkOk) stages.push("check");
  return stages;
}

function renderErrorSummary(renderedViews: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    code: "project_ledger_render_failed",
    message: "One or more Project Ledger generated views failed to render.",
    details: renderedViews
      .filter((view) => view.ok !== true && view.skipped !== true)
      .map((view) => ({
        view: stringValue(view.view),
        error: view.error,
      })),
  };
}

function issueCount(result: Record<string, unknown>): number {
  const data = objectAt(result, ["data"]);
  const value = data?.issueCount;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : boundedIssues(result).length;
}

function boundedIssues(result: Record<string, unknown>): Array<Record<string, unknown>> {
  const data = objectAt(result, ["data"]);
  const issues = Array.isArray(data?.issues) ? data.issues : [];
  return issues.slice(0, 8).map((issue) => {
    const item = recordValue(issue);
    return {
      code: stringValue(item.code),
      severity: stringValue(item.severity),
      message: stringValue(item.message),
      path: stringValue(item.path),
      record: stringValue(item.record),
    };
  });
}

function projectLedgerErrorSummary(result: Record<string, unknown>): Record<string, unknown> {
  const error = recordValue(result.error);
  return {
    code: stringValue(error.code),
    message: stringValue(error.message),
    next: boundedNext(error.next),
    native_next: projectLedgerNativeNextHints(error),
  };
}

function projectLedgerCloseoutFailureError(closeout: Record<string, unknown>): Record<string, unknown> {
  return {
    code: "project_ledger_closeout_failed",
    message: "Project Ledger lifecycle closeout failed after a successful mutation.",
    details: closeoutFailureDetails(closeout),
    native_next: closeoutNativeNextHints(closeout),
  };
}

function closeoutFailureDetails(closeout: Record<string, unknown>): Array<Record<string, string>> {
  const details: Array<Record<string, string>> = [];
  if (closeout.index_ok !== true) {
    details.push({
      code: "index_failed",
      kind: "project_ledger_closeout",
      status: "failed",
      message: stringAt(closeout, ["index_error", "message"]) ?? "Project Ledger index failed.",
    });
  }
  const renderedViews = Array.isArray(closeout.rendered_views) ? closeout.rendered_views : [];
  for (const view of renderedViews) {
    const record = recordValue(view);
    if (record.ok === true || record.skipped === true) continue;
    details.push({
      code: "render_failed",
      kind: "project_ledger_closeout",
      id: stringValue(record.view) ?? "view",
      status: "failed",
      message: stringAt(record, ["error", "message"]) ?? "Project Ledger generated view render failed.",
    });
  }
  if (closeout.check_ok !== true && closeout.check_skipped !== true) {
    details.push({
      code: "check_failed",
      kind: "project_ledger_closeout",
      status: "failed",
      message: stringAt(closeout, ["check_error", "message"]) ?? "Project Ledger check failed.",
    });
  }
  return details;
}

function closeoutNativeNextHints(closeout: Record<string, unknown>): Array<Record<string, unknown>> {
  const hints: Array<Record<string, unknown>> = [];
  if (closeout.index_ok !== true) {
    hints.push({
      tool: "project_ledger_index",
      args: {},
      reason: "Repair Project Ledger source records if needed, then rebuild the compact index.",
    });
  }
  const renderedViews = Array.isArray(closeout.rendered_views) ? closeout.rendered_views : [];
  for (const view of renderedViews) {
    const record = recordValue(view);
    if (record.ok === true || record.skipped === true) continue;
    hints.push({
      tool: "project_ledger_render",
      args: { view: stringValue(record.view) ?? "dashboard", write: true },
      reason: "Rewrite the failed generated Project Ledger view after index succeeds.",
    });
  }
  if (closeout.check_ok !== true && closeout.check_skipped !== true) {
    hints.push({
      tool: "project_ledger_check",
      args: {},
      reason: "Review issues, repair source records, and rerun strict validation.",
    });
  }
  return hints;
}

function boundedNext(value: unknown): Array<Record<string, string>> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 5).map((item) => {
    const record = recordValue(item);
    return {
      command: stringValue(record.command) ?? "",
      reason: stringValue(record.reason) ?? "",
    };
  });
}

function objectAt(
  source: Record<string, unknown>,
  path: readonly string[],
): Record<string, unknown> | null {
  let current: unknown = source;
  for (const key of path) {
    const record = recordValue(current);
    if (!(key in record)) return null;
    current = record[key];
  }
  return recordValue(current);
}

function stringAt(source: Record<string, unknown>, path: readonly string[]): string | null {
  let current: unknown = source;
  for (const key of path) {
    const record = recordValue(current);
    if (!(key in record)) return null;
    current = record[key];
  }
  return typeof current === "string" && current.trim() ? current.trim() : null;
}

function booleanAt(source: Record<string, unknown>, path: readonly string[]): boolean {
  let current: unknown = source;
  for (const key of path) {
    const record = recordValue(current);
    if (!(key in record)) return false;
    current = record[key];
  }
  return current === true;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
