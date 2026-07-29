import type { ProgressRow } from "../types.ts";
import { semanticProgressRows } from "./progress-rows.ts";

export interface ComposerTaskItem {
  id: string;
  label: string;
  fullLabel?: string;
  state:
    | "pending"
    | "running"
    | "reviewing"
    | "completed"
    | "correction-required"
    | "stopped";
}

export function projectComposerTasks(
  rows: ProgressRow[],
  turnState?: string,
): ComposerTaskItem[] {
  return semanticProgressRows(rows).flatMap((row): ComposerTaskItem[] => {
    if (row.kind !== "todo") return [];
    const label = row.safe_label.trim();
    const id = row.safe_input_label?.trim() || row.id;
    if (!label || !id) return [];
    const fullLabel = row.safe_detail_rows?.find((detail) =>
      detail.kind === "task_outcome",
    )?.safe_value?.trim();
    return [{
      id,
      label,
      ...(fullLabel ? { fullLabel } : {}),
      state: taskState(
        row.state,
        turnState,
        row.bridge_phase === "btcc_work_ledger",
      ),
    }];
  });
}

function taskState(
  state?: string,
  turnState?: string,
  canonicalWorkLedger = false,
): ComposerTaskItem["state"] {
  if (
    canonicalWorkLedger &&
    turnState === "cancelled" &&
    ["active", "running", "streaming", "reviewing", "correction_required"]
      .includes(state ?? "")
  ) return "stopped";
  if (
    !canonicalWorkLedger &&
    turnState === "cancelled" &&
    state !== "completed" &&
    state !== "delivered"
  ) return "stopped";
  if (["delivered", "complete", "completed"].includes(state ?? ""))
    return "completed";
  if (state === "reviewing") return "reviewing";
  if (state === "failed" || state === "correction_required")
    return "correction-required";
  if (state === "cancelled" || state === "stopped") return "stopped";
  if (["running", "streaming", "active"].includes(state ?? "")) return "running";
  return "pending";
}
