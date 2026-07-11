export const STATUS_REPORT_EVIDENCE_TOOL_NAMES = new Set([
  "project_ledger_status",
  "project_ledger_show",
  "inspect_project_status",
  "query_project_work",
  "get_work_dashboard",
  "get_context_monitor",
  "list_work_streams",
]);

export function isStatusReportEvidenceTool(name: string): boolean {
  return STATUS_REPORT_EVIDENCE_TOOL_NAMES.has(name);
}

export function statusReportEvidenceGuidance(): string[] {
  return [
    "status_report requires an exposed status snapshot producer such as project_ledger_status or inspect_project_status.",
    "project_ledger_check proves Ledger integrity only; it does not prove project or runtime status.",
  ];
}
