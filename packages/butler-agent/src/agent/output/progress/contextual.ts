import type { ToolProgressSummary } from "../../tools/tool-support.ts";
import { safePathishValue, safeTextValue } from "./arguments.ts";

export function contextualToolProgressSummary(
  name: string,
  args: Record<string, unknown>,
): Omit<ToolProgressSummary, "workBlockLabel"> | null {
  if (name === "inspect_project_status") {
    return {
      kind: "read",
      toolName: "Project Ledger",
      safeLabel: "Checking local Project Ledger status",
      inputLabel: "status",
      detailRows: projectLedgerDetailRows([
        { id: "project", label: "Project", value: projectLedgerReference(args) },
      ]),
    };
  }
  if (name === "query_project_work") {
    return {
      kind: "searched",
      toolName: "Project Ledger",
      safeLabel: `Reviewing Project Ledger ${projectLedgerQueryLabel(args.kind)}`,
      inputLabel: projectLedgerQueryLabel(args.kind),
      detailRows: projectLedgerDetailRows([
        { id: "project", label: "Project", value: projectLedgerReference(args) },
        { id: "query", label: "Query", value: projectLedgerQueryLabel(args.kind) },
      ]),
    };
  }
  if (name === "web_read") {
    const source = safeUrlHostLabel(args.url);
    return {
      kind: "read",
      toolName: "Web read",
      safeLabel: source ? `Reading public source: ${source}` : "Reading public source",
      inputLabel: source,
      detailRows: source
        ? [{
          id: "web-read-source",
          kind: "source",
          safe_label: "Source",
          safe_value: source,
          state: "running",
        }]
        : [],
    };
  }
  if (name === "summarize_user_profile") {
    return {
      kind: "read",
      toolName: "Profile",
      safeLabel: "Summarizing Butler profile understanding",
      inputLabel: "profile summary",
      detailRows: [],
    };
  }
  if (name === "render_project_dashboard") {
    const view = safeTextValue(args.view, "dashboard");
    return {
      kind: args.write === true ? "edited" : "used_tool",
      toolName: "Project Ledger",
      safeLabel: `Rendering Project Ledger ${view} view`,
      inputLabel: `${view} view`,
      detailRows: projectLedgerDetailRows([
        { id: "project", label: "Project", value: projectLedgerReference(args) },
        { id: "view", label: "View", value: view },
        { id: "output", label: "Output", value: args.write === true ? "writing generated view" : "preview only" },
      ]),
    };
  }
  if (name === "transform_public_data_table") {
    const title = safeTextValue(args.title, "public data table");
    const rowCount = Array.isArray(args.rows) ? String(args.rows.length) : "";
    return {
      kind: "edited",
      toolName: "Data transform",
      safeLabel: `Transforming public data table: ${title}`,
      inputLabel: title,
      detailRows: [
        {
          id: "public-data-title",
          kind: "title",
          safe_label: "Table",
          safe_value: title,
          state: "running",
        },
        ...(rowCount
          ? [{
            id: "public-data-rows",
            kind: "rows",
            safe_label: "Rows",
            safe_value: rowCount,
            state: "running",
          }]
          : []),
      ],
    };
  }
  return null;
}

function projectLedgerQueryLabel(value: unknown): string {
  const kind = safeTextValue(value, "work").replace(/-/gu, " ");
  if (kind === "next actions") return "next actions";
  return kind;
}

function projectLedgerReference(args: Record<string, unknown>): unknown {
  if (typeof args.project_ref === "string" && args.project_ref.trim()) return args.project_ref;
  if (typeof args.project_path === "string" && args.project_path.trim()) return args.project_path;
  return "active project";
}

function safeUrlHostLabel(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value);
    return url.hostname.replace(/^www\./iu, "").slice(0, 80);
  } catch {
    return "";
  }
}

function projectLedgerDetailRows(
  rows: Array<{ id: string; label: string; value: unknown }>,
): ToolProgressSummary["detailRows"] {
  return rows
    .map((row) => {
      const safeValue = row.id === "project"
        ? safePathishValue(row.value, "active project")
        : safeTextValue(row.value, row.label);
      return {
        id: `project-ledger-${row.id}`,
        kind: row.id,
        safe_label: row.label,
        safe_value: safeValue,
        state: "running",
      };
    })
    .filter((row) => row.safe_value && row.safe_value !== "undefined")
    .slice(0, 6);
}
