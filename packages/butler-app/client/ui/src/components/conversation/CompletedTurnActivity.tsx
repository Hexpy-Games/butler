import { memo } from "react";
import type { ProgressRow } from "@/app/types.ts";
import { phaseActivityRows } from "./turnActivityRows";
import { TurnActivityTimeline } from "./TurnActivityTimeline";

export const CompletedTurnActivity = memo(function CompletedTurnActivity({
  rows,
  turnId,
}: {
  rows?: ProgressRow[];
  turnId?: string;
}) {
  const activities = phaseActivityRows(rows ?? []);
  if (activities.length === 0) return null;
  return <TurnActivityTimeline activities={activities} turnId={turnId} />;
});
