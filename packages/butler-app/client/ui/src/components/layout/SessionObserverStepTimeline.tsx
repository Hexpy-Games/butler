import { Fragment, useId, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { projectTurnActivity } from "@/app/conversation-progress";
import type { SessionView, WorkPlan, WorkPlanAction, WorkPlanRevision } from "@/app/types.ts";
import { Box, DisclosureRow, Separator, Stack, Typo } from "@/butler-ds";
import { TurnActivityTimeline } from "@/components/conversation/TurnActivityTimeline.tsx";
import { observerActivitySources } from "./observerActivitySources.ts";
import { SessionObserverCurrentStatus, type ObserverPhaseActivity } from "./SessionObserverActivityGroup.tsx";
import { workPlanStatusTime, workPlanTime } from "./workPlanPresentation.ts";

type StepActivity = ObserverPhaseActivity & { actionKey?: string | null };

function projectActivities(view: SessionView): StepActivity[] {
  const sources = observerActivitySources(view.messages, view.activity_history ?? [], view.active_turn, view.latest_turn);
  return [...sources.values()].flatMap(source => {
    const authored = new Map(source.rows.filter(row => row.work_decision_source === "model-authored")
      .map(row => [row.id, row.action_key]));
    return projectTurnActivity(source.rows, source.turn_id).phaseActivities.map(activity => ({
      ...activity, turnId: source.turn_id, actionKey: authored.get(activity.id),
      createdAt: activity.createdAt ?? source.created_at,
    }));
  }).sort((left, right) => (left.createdAt ?? "").localeCompare(right.createdAt ?? ""));
}

function StepActivities({ activities, newest, live }: {
  activities: StepActivity[]; newest?: StepActivity; live: boolean;
}) {
  const pulse = live && newest !== undefined && activities.includes(newest);
  return <TurnActivityTimeline activities={activities} expandAll live={pulse} pulseLatest={pulse} />;
}

function StepGroup({ action, activities, newest, live }: {
  action: WorkPlanAction; activities: StepActivity[]; newest?: StepActivity; live: boolean;
}) {
  const [open, setOpen] = useState(true);
  const controlsId = useId();
  return <Stack gap="sm" data-step-key={action.action_key}>
    <DisclosureRow surface="plain" affordance="trailing" reveals
      title={appCopy.conversation.work.planSteps.title(action.order, action.title)} meta={workPlanStatusTime(action)}
      description={<Typo.Caption as="span" truncate title={action.purpose}>{action.purpose}</Typo.Caption>}
      controlsId={controlsId} open={open} onToggle={() => setOpen(value => !value)} />
    <Stack id={controlsId} gap="none" hidden={!open}>
      {open ? <StepActivities activities={activities} newest={newest} live={live} /> : null}
    </Stack>
  </Stack>;
}

function RevisionRow({ revision }: { revision: WorkPlanRevision }) {
  return <DisclosureRow surface="plain" data-plan-revision={revision.revision}
    title={appCopy.conversation.work.planSteps.revised(revision.added.length, revision.removed.length)}
    meta={workPlanTime(revision.at)} description={revision.reason} />;
}

export function SessionObserverStepTimeline({ view, plan }: { view: SessionView; plan: WorkPlan }) {
  const activities = projectActivities(view);
  const actions = [...plan.actions].sort((left, right) => left.order - right.order);
  const keys = new Set(actions.map(action => action.action_key));
  const grouped = new Map<string, StepActivity[]>();
  const before: StepActivity[] = [], after: StepActivity[] = [];
  const firstStart = actions[0]?.started_at;
  for (const activity of activities) {
    if (activity.actionKey && keys.has(activity.actionKey)) {
      const group = grouped.get(activity.actionKey) ?? [];
      group.push(activity);
      grouped.set(activity.actionKey, group);
    } else if (!firstStart || (activity.createdAt ?? "") < firstStart) before.push(activity);
    else after.push(activity);
  }
  const live = Boolean(view.active_turn);
  const newest = activities.at(-1);
  const initialRevision = Math.min(...plan.revisions.map(revision => revision.revision),
    ...actions.map(action => action.added_in_revision));
  const revisions = plan.revisions.filter(revision => revision.revision > initialRevision);
  const shown = new Set<number>();
  return <Box paddingX="md"><Stack gap="md">
    <StepActivities activities={before} newest={newest} live={live} />
    {actions.map(action => {
      const revision = revisions.find(entry => entry.revision === action.added_in_revision &&
        entry.added.includes(action.action_key) && !shown.has(entry.revision));
      if (revision) shown.add(revision.revision);
      return <Fragment key={action.action_key}>
        {revision ? <RevisionRow revision={revision} /> : null}
        <StepGroup action={action} activities={grouped.get(action.action_key) ?? []} newest={newest} live={live} />
      </Fragment>;
    })}
    {revisions.filter(revision => !shown.has(revision.revision)).map(revision =>
      <RevisionRow key={revision.revision} revision={revision} />)}
    {after.length ? <Separator /> : null}
    <StepActivities activities={after} newest={newest} live={live} />
    <SessionObserverCurrentStatus active={view.active_turn} hasActivities={activities.length > 0} />
  </Stack></Box>;
}
