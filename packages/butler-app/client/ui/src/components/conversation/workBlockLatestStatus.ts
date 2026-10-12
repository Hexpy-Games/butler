import { projectTurnActivity } from "@/app/conversation-progress";
import type { ProgressRow } from "@/app/types.ts";
import { phaseLabel } from "./phaseLabel";
import { activityDisplayTitle } from "./TurnActivityBlock.tsx";
import { toolchainGroupLabel } from "./toolchainUtils.tsx";

/**
 * A work block's one-line status: only the latest activity, never a tally of
 * the whole run. While live it names that activity and the kind of its latest
 * step; once settled, that activity and how the run ended.
 */
export function workBlockLatestStatus(
  rows: ProgressRow[],
  turnId: string | undefined,
  live: boolean,
  settledState: string,
): string | null {
  const latest = projectTurnActivity(rows, turnId).phaseActivities.at(-1);
  if (!latest) return null;
  const step = latest.operations.at(-1);
  const kind = live
    ? step ? toolchainGroupLabel(step) : phaseLabel(latest.phase)
    : phaseLabel(settledState);
  return [activityDisplayTitle(latest), kind].filter(Boolean).join(" · ");
}
