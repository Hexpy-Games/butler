import { memo } from "react";
import type { ProgressRow } from "@/app/types.ts";
import { phaseActivityRows } from "./turnActivityRows";
import { TurnActivityTimeline } from "./TurnActivityTimeline";
import { WorkProgressPanel } from "./WorkProgressPanel";
import { Stack } from "@/butler-ds";

export const CompletedTurnActivity = memo(function CompletedTurnActivity({
  rows,
  turnId,
  turnState,
}: {
  rows?: ProgressRow[];
  turnId?: string;
  turnState?: string;
}) {
  const activities = phaseActivityRows(rows ?? []);
  const todoRows = (rows ?? []).filter((row) => row.kind === "todo");
  if (activities.length === 0 && todoRows.length === 0) return null;
  return (
    <Stack gap="md">
      <WorkProgressPanel rows={todoRows} turnState={turnState} />
      {activities.length > 0 ? (
        <TurnActivityTimeline activities={activities} turnId={turnId} />
      ) : null}
    </Stack>
  );
});
