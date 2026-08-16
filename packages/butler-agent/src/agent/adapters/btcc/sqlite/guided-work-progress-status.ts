import type { DurableWorkActionProgress } from "../../../btcc/work/index.ts";

export function guidedWorkStatusForProgress(
  progress: readonly DurableWorkActionProgress[],
): "open" | "blocked" {
  return progress.some((action) => action.status === "blocked") ? "blocked" : "open";
}
