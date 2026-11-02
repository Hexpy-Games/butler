import { Fragment, useState } from "react";
import { projectTurnActivity } from "@/app/conversation-progress";
import type { SessionView } from "@/app/types";
import { DisclosureRow, Separator, Stack, Typo } from "@/butler-ds";
import { CurrentTurnStatus } from "@/components/conversation/CurrentTurnStatus";
import { TurnActivityPanel } from "@/components/conversation/TurnActivityPanel";
import { TurnActivityTimeline } from "@/components/conversation/TurnActivityTimeline";
import { observerActivitySources } from "@/components/layout/observerActivitySources";
import type { ObserverPhaseActivity } from "@/components/layout/SessionObserverActivityGroup";
import type { ActionRow, StepAction, StepPlan } from "./stepCardFixture";

export type BoundaryVariant = "a" | "b";
const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

const time = (value: string) => timeFormatter.format(new Date(value));

function timeRange(start: string, end: string) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const startParts = timeFormatter.formatToParts(startDate);
  const endParts = timeFormatter.formatToParts(endDate);
  const startPeriod = startParts.find(part => part.type === "dayPeriod")?.value;
  const endPeriod = endParts.find(part => part.type === "dayPeriod")?.value;
  const endPeriodIndex = endParts.findIndex(part => part.type === "dayPeriod");
  if (startPeriod && startPeriod === endPeriod && endParts.slice(0, endPeriodIndex).every(part => part.type === "literal")) {
    endParts.splice(0, endPeriodIndex + 1);
    if (endParts[0]?.type === "literal") endParts.shift();
  }
  return `${timeFormatter.format(startDate)}–${endParts.map(part => part.value).join("")}`;
}

function statusTime(action: StepAction) {
  const status = { done: "완료", running: "진행 중", pending: "대기 중", failed: "실패" }[action.status];
  const period = action.started_at ? action.finished_at
    ? timeRange(action.started_at, action.finished_at) : `${time(action.started_at)}부터` : "";
  return [status, period].filter(Boolean).join(" · ");
}

function LabelBoundary({ title, description, meta }: { title: string; description: string; meta: string }) {
  return <Stack gap="xs">
    <Separator />
    <Typo.Caption>{title} · {meta}</Typo.Caption>
    <Typo.Caption tone="tertiary" truncate title={description}>{description}</Typo.Caption>
  </Stack>;
}

function StepGroup({ action, activities, variant, fold, live }: {
  action: StepAction; activities: ObserverPhaseActivity[]; variant: BoundaryVariant; fold: boolean; live: boolean;
}) {
  const [open, setOpen] = useState(!(fold && action.status === "done"));
  return <Stack gap="sm" data-step-key={action.action_key}>
    {variant === "a" ? <DisclosureRow surface="plain" affordance="trailing" reveals
      title={`${action.order}. ${action.title}`} meta={statusTime(action)}
      description={<Typo.Caption as="span" truncate title={action.purpose}>{action.purpose}</Typo.Caption>}
      open={open} onToggle={() => setOpen(value => !value)} />
      : <LabelBoundary title={`${action.order}단계 · ${action.title}`} meta={statusTime(action)} description={action.purpose} />}
    {variant === "b" || open ? <TurnActivityTimeline activities={activities} expandAll live={live} pulseLatest={live} /> : null}
  </Stack>;
}

function projected(view: SessionView) {
  const sources = observerActivitySources(view.messages, view.activity_history ?? [], view.active_turn, view.latest_turn);
  return [...sources.values()].flatMap(source => {
    const actions = new Map(source.rows.map(row => [row.id, (row as ActionRow).action_key]));
    return projectTurnActivity(source.rows, source.turn_id).phaseActivities.map(activity => ({
      ...activity, turnId: source.turn_id, actionKey: actions.get(activity.id), createdAt: activity.createdAt ?? source.created_at,
    }));
  }).sort((left, right) => (left.createdAt ?? "").localeCompare(right.createdAt ?? ""));
}

export function StepTimeline({ view, plan, variant, fold, live }: {
  view: SessionView; plan: StepPlan; variant: BoundaryVariant; fold: boolean; live: boolean;
}) {
  const activities = projected(view);
  const actions = [...plan.actions].sort((left, right) => left.order - right.order);
  const firstStart = actions[0]?.started_at;
  const unassigned = activities.filter(activity => !activity.actionKey);
  const before = unassigned.filter(activity => !firstStart || (activity.createdAt ?? "") < firstStart);
  const after = unassigned.filter(activity => firstStart && (activity.createdAt ?? "") >= firstStart);
  const newest = activities.at(-1);
  const active = view.active_turn;
  const current = active
    ? projectTurnActivity(active.progress?.safe_progress_rows ?? [], active.id)
    : undefined;
  return <Stack gap="md">
    <TurnActivityTimeline activities={before} expandAll live={live && before.includes(newest!)} pulseLatest={live && before.includes(newest!)} />
    {actions.map(action => {
      const group = activities.filter(activity => activity.actionKey === action.action_key);
      const revision = plan.revisions.find(entry => entry.revision === action.added_in_revision && entry.added.includes(action.action_key));
      const revisionTitle = revision ? `계획 수정 · 단계 ${revision.added.length}개 추가` : "";
      return <Fragment key={action.action_key}>
        {revision ? variant === "a" ? <DisclosureRow surface="plain" title={revisionTitle} meta={time(revision.at)} description={revision.reason} />
          : <LabelBoundary title={revisionTitle} meta={time(revision.at)} description={revision.reason} /> : null}
        <StepGroup action={action} activities={group} variant={variant} fold={fold} live={live && group.includes(newest!)} />
      </Fragment>;
    })}
    {after.length > 0 ? <Separator /> : null}
    <TurnActivityTimeline activities={after} expandAll live={live && after.includes(newest!)} pulseLatest={live && after.includes(newest!)} />
    {active && activities.length === 0 && current?.phaseActivities.length === 0 ? <TurnActivityPanel
      rows={active.progress?.safe_progress_rows ?? []} state={active.state}
      turnId={active.id} startedAt={active.created_at} /> : active && current ? <CurrentTurnStatus state={active.state}
      modelRoundWait={current.modelRoundWait} operation={current.operation}
      publicActivity={current.publicActivity}
      phaseLabel={current.phaseActivities.at(-1)?.summary}
      startedAt={active.created_at} /> : null}
  </Stack>;
}
