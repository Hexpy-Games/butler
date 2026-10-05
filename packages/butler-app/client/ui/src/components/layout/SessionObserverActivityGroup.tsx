import type { SessionView } from "@/app/types.ts";
import { projectTurnActivity, type PhaseActivity } from "@/app/conversation-progress";
import { Stack } from "@/butler-ds";
import { TurnActivityTimeline } from "@/components/conversation/TurnActivityTimeline.tsx";
import { TurnActivityPanel } from "@/components/conversation/TurnActivityPanel";
import { CurrentTurnStatus } from "@/components/conversation/CurrentTurnStatus.tsx";

export type ObserverPhaseActivity = PhaseActivity & { turnId: string };

// Internal Turns retain tool ownership, but are not conversation boundaries.
export function SessionObserverActivityGroup({ activities, active, state, delegatedGoal }: {
  activities: ObserverPhaseActivity[];
  delegatedGoal?: string;
  active?: SessionView["active_turn"];
  state?: string;
}) {
  const current = active
    ? projectTurnActivity(active.progress?.safe_progress_rows ?? [], active.id)
    : undefined;
  return (
    <Stack gap="md">
      {activities.length > 0 ? <TurnActivityTimeline delegatedGoal={delegatedGoal} activities={activities} live={Boolean(active)}
        currentState={current?.semanticState ?? state} turnId={activities[0]?.turnId} /> : null}
      {active && activities.length === 0 && current?.phaseActivities.length === 0 ? <TurnActivityPanel
        rows={active.progress?.safe_progress_rows ?? []} state={active.state}
        turnId={active.id} startedAt={active.created_at} /> : active && current ? <CurrentTurnStatus state={active.state}
        modelRoundWait={current.modelRoundWait} operation={current.operation}
        publicActivity={current.publicActivity}
        phaseLabel={current.phaseActivities.at(-1)?.summary}
        startedAt={active.created_at} /> : null}
    </Stack>
  );
}
