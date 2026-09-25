import type { ReactElement } from "react";
import {
  FileText,
  ListChecks,
  Pencil,
  Rocket,
  Search,
  Terminal,
  Wrench,
} from "@/butler-ds";
import type { ProgressRow } from "@/app/types.ts";

export function activityIcon(row: ProgressRow): ReactElement {
  if (row.safe_tool_name === "delegate_to_worker") return <Rocket size="md" />;
  if (row.safe_tool_name === "read_file") return <FileText size="md" />;
  if (row.safe_tool_name === "edit_file" || row.safe_tool_name === "write_file") {
    return <Pencil size="md" />;
  }
  if (row.safe_tool_name === "run_command") return <Terminal size="md" />;
  if (row.bridge_phase === "btcc_operation") return <Wrench size="md" />;
  const label = row.safe_label.toLowerCase();
  if (row.kind === "searched" || label.includes("search")) {
    return <Search size="md" />;
  }
  if (row.kind === "read" || label.includes("read")) {
    return <FileText size="md" />;
  }
  if (row.kind === "ran_command") return <Terminal size="md" />;
  if (row.kind === "edited") return <Pencil size="md" />;
  if (row.kind === "dispatch") return <Rocket size="md" />;
  if (row.kind === "used_tool") return <Wrench size="md" />;
  return <ListChecks size="md" />;
}
