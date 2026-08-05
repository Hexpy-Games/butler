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
  if (row.safe_tool_name === "read_file") return <FileText size={15} />;
  if (row.safe_tool_name === "edit_file" || row.safe_tool_name === "write_file") {
    return <Pencil size={15} />;
  }
  if (row.safe_tool_name === "run_command") return <Terminal size={15} />;
  if (row.bridge_phase === "btcc_operation") return <Wrench size={15} />;
  const label = row.safe_label.toLowerCase();
  if (row.kind === "searched" || label.includes("search")) {
    return <Search size={15} />;
  }
  if (row.kind === "read" || label.includes("read")) {
    return <FileText size={15} />;
  }
  if (row.kind === "ran_command") return <Terminal size={15} />;
  if (row.kind === "edited") return <Pencil size={15} />;
  if (row.kind === "dispatch") return <Rocket size={15} />;
  if (row.kind === "used_tool") return <Wrench size={15} />;
  return <ListChecks size={15} />;
}
