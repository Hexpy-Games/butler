import { memo } from "react";
import { useAppLocale } from "@/app/copy.ts";
import type { ProgressRow } from "@/app/types.ts";
import { projectTurnActivity } from "@/app/conversation-progress";
import { TurnActivityTimeline } from "./TurnActivityTimeline";

export const CompletedTurnActivity = memo(function CompletedTurnActivity({
  rows,
  turnId,
  turnState,
}: {
  rows?: ProgressRow[];
  turnId?: string;
  turnState?: string;
}) {
  useAppLocale();
  const activities = projectTurnActivity(rows ?? [], turnId).phaseActivities;
  if (activities.length === 0) return null;
  return (
    <TurnActivityTimeline
      activities={activities}
      currentState={turnState}
      turnId={turnId}
    />
  );
});
