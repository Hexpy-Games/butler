import type { SessionView } from "@/app/types.ts";
import { projectTurnActivity, type PhaseActivity } from "@/app/conversation-progress";
import { Stack } from "@/butler-ds";
import { TurnActivityTimeline } from "@/components/conversation/TurnActivityTimeline.tsx";
import { CurrentTurnStatus } from "@/components/conversation/CurrentTurnStatus.tsx";

export type ObserverPhaseActivity = PhaseActivity & { turnId: string };

// Internal Turns retain tool ownership, but are not conversation boundaries.
export function SessionObserverActivityGroup({ activities, active }: {
  activities: ObserverPhaseActivity[];
  active?: SessionView["active_turn"];
}) {
  const current = active
    ? projectTurnActivity(active.progress.safe_progress_rows, active.id)
    : undefined;
  return (
    <Stack gap="md">
      {activities.length > 0 ? <TurnActivityTimeline activities={activities} live={Boolean(active)}
        currentState={current?.semanticState} turnId={activities[0]?.turnId} /> : null}
      {active && current ? <CurrentTurnStatus state={active.state}
        modelRoundWait={current.modelRoundWait} operation={current.operation}
        publicActivity={current.publicActivity}
        phaseLabel={current.phaseActivities.at(-1)?.summary}
        startedAt={active.created_at} /> : null}
    </Stack>
  );
}
