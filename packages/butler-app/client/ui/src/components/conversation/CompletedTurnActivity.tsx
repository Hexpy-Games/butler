import { memo } from "react";
import type { ProgressRow } from "@/app/types.ts";
import { projectTurnActivity } from "@/app/conversation-progress";
import { TurnActivityTimeline } from "./TurnActivityTimeline";

export const CompletedTurnActivity = memo(function CompletedTurnActivity({
  rows,
  turnId,
}: {
  rows?: ProgressRow[];
  turnId?: string;
  turnState?: string;
}) {
  const activities = projectTurnActivity(rows ?? [], turnId).phaseActivities;
  if (activities.length === 0) return null;
  return <TurnActivityTimeline activities={activities} turnId={turnId} />;
});
