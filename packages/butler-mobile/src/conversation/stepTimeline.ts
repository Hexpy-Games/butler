import type { AppCopy, AppLocale } from "../../../butler-i18n/src/index.ts";
import type { SessionView, StewardChild, WorkPlan, WorkPlanAction } from "../../../butler-protocol/src/index.ts";
import type { Activity } from "./activityProjection";

type StepActivity = Activity & { actionKey?: string | null };

/** Grouping from desktop SessionObserverStepTimeline.tsx. */
export function stepTimeline(activities: StepActivity[], plan: WorkPlan, workers: SessionView["workers"]) {
  const actions = [...plan.actions].sort((left, right) => left.order - right.order);
  const keys = new Set(actions.map(action => action.action_key));
  // Session views list Workers in the steward-child summary shape, with the plan action they were delegated for.
  const children = workers ?? [];
  const stepWorkers = new Map<string, StewardChild[]>();
  for (const worker of children) {
    if (!worker.action_key || !keys.has(worker.action_key)) continue;
    stepWorkers.set(worker.action_key, [...(stepWorkers.get(worker.action_key) ?? []), worker]);
  }
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
  const initialRevision = Math.min(...plan.revisions.map(revision => revision.revision),
    ...actions.map(action => action.added_in_revision));
  const revisions = plan.revisions.filter(revision => revision.revision > initialRevision);
  const shown = new Set<number>();
  const steps = actions.map(action => {
    const revision = revisions.find(entry => entry.revision === action.added_in_revision &&
      entry.added.includes(action.action_key) && !shown.has(entry.revision));
    if (revision) shown.add(revision.revision);
    return { action, revision, activities: grouped.get(action.action_key) ?? [], workers: stepWorkers.get(action.action_key) ?? [] };
  });
  return { before, steps, trailingRevisions: revisions.filter(revision => !shown.has(revision.revision)), after };
}

function formatter(locale: AppLocale) {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
}

export function workPlanTime(value: string, locale: AppLocale): string {
  return formatter(locale).format(new Date(value));
}

function timeRange(start: string, end: string, locale: AppLocale): string {
  const format = formatter(locale);
  const startParts = format.formatToParts(new Date(start));
  const endParts = format.formatToParts(new Date(end));
  const period = startParts.find(part => part.type === "dayPeriod")?.value;
  if (period && period === endParts.find(part => part.type === "dayPeriod")?.value) {
    const index = endParts.findIndex(part => part.type === "dayPeriod");
    endParts.splice(index, 1);
    if (endParts[0]?.type === "literal") endParts.shift();
    if (endParts.at(-1)?.type === "literal") endParts.pop();
  }
  return `${format.format(new Date(start))}–${endParts.map(part => part.value).join("")}`;
}

export function workPlanStatusTime(action: WorkPlanAction, appCopy: AppCopy, locale: AppLocale): string {
  const copy = appCopy.conversation.work.planSteps;
  const period = action.status === "done" && action.started_at && action.finished_at
    ? timeRange(action.started_at, action.finished_at, locale)
    : action.status === "active" && action.started_at ? copy.since(workPlanTime(action.started_at, locale)) : "";
  return [copy.statuses[action.status], period].filter(Boolean).join(" · ");
}
