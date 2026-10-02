import { HARNESS_SS03_OBSERVER_VIEW, HARNESS_SS03_STEWARD_STATES, HARNESS_SS03_SUMMARY } from "@/app/fixtures.ts";
import type { SessionSummaryView } from "@/app/types.ts";

/** Native observer states selected by the same visual harness used by smokes. */
export function stewardHarnessSummary(state: string): SessionSummaryView {
  const child = HARNESS_SS03_SUMMARY.steward_children![0]!;
  const latest = child.latest_turn!;
  if (state === "recoverable") {
    return {
      ...HARNESS_SS03_SUMMARY,
      steward_children: [{
        ...child,
        status: "failed",
        active_turn: null,
        latest_turn: { ...latest, state: "runtime_fault", retryable: true, cancellable: false,
          progress: { ...latest.progress, safe_progress_rows: latest.progress?.safe_progress_rows ?? [], state: "runtime_fault", summary: "Interrupted" } },
      }],
    };
  }
  if (state === "waiting") {
    return {
      ...HARNESS_SS03_SUMMARY,
      steward_children: [{ ...child, active_turn: null, waiting_for_children: true }],
    };
  }
  return HARNESS_SS03_STEWARD_STATES[state] ?? HARNESS_SS03_SUMMARY;
}

/** Keep the opened observer consistent with the selected parent-card state. */
export function stewardHarnessView(state: string) {
  const child = stewardHarnessSummary(state).steward_children![0]!;
  return {
    ...HARNESS_SS03_OBSERVER_VIEW,
    status: child.status,
    active_turn: child.active_turn,
    latest_turn: child.latest_turn,
    waiting_for_children: child.waiting_for_children,
  };
}
