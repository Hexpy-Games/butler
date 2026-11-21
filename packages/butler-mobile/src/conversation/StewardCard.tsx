import { Fragment, useState } from "react";
import { LayoutAnimation, View } from "react-native";
import { useRouter } from "expo-router";
import { getAppCopy, type AppCopy } from "../../../butler-i18n/src/index.ts";
import type { SessionView, StewardChild, WorkPlan, WorkPlanAction, WorkPlanRevision } from "../../../butler-protocol/src/index.ts";
import { Button, IconButton, icons, ListRow, showToast, StatusLine, Surface, Text, useTokens, WorkActivityDisclosure } from "@/ds";
import { useReducedMotion } from "@/ds/internal/motion";
import { useAppLocale } from "@/i18n";
import { ActivityTimeline } from "./ActivityHistory";
import { activityTail, observerActivities, projectActivities, type Activity } from "./activityProjection";
import { useConversation } from "./live";
import { stepTimeline, workPlanStatusTime, workPlanTime } from "./stepTimeline";
import { useSessionViewData } from "./useSessionView";
import { useWorkExpanded } from "./workExpansion";
import { effectiveStewardStatus, latestStatus, stewardCardStatus, stewardCurrentActivityTitle, stewardPlanProgress, stewardProgressStatus, turnStatusLabel, workerActivityTitle } from "./workStatus";

export function StewardCard({ child }: { child: StewardChild }) {
  const t = useTokens();
  const router = useRouter();
  const locale = useAppLocale();
  const appCopy = getAppCopy(locale);
  const { client } = useConversation();
  const [narrow, setNarrow] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [expanded, toggle] = useWorkExpanded(child.session_id);
  const { view: childView } = useSessionViewData(expanded ? child.session_id : undefined);
  const turn = child.active_turn ?? child.latest_turn;
  const rows = turn?.progress?.safe_progress_rows ?? [];
  const live = !!(child.active_turn || child.waiting_for_children);
  const status = stewardCardStatus(child, narrow, appCopy);
  const latest = latestStatus(rows, turn?.id, live, effectiveStewardStatus(child), locale)
    ?? workerActivityTitle(stewardCurrentActivityTitle(child, locale), child.title, appCopy);
  const tail = activityTail(expanded && childView ? observerActivities(childView, locale) : projectActivities(rows, turn?.id, locale).activities, appCopy);
  const resume = async () => {
    if (!client) return;
    setResuming(true);
    try {
      await client.request(`/steward-relations/${encodeURIComponent(child.relation.relation_id)}/resume`, { body: { parent_session_id: child.relation.parent_session_id } });
    } catch { showToast({ message: appCopy.interfaceFeedback.stewardResumeFailed, tone: "error" }); }
    finally { setResuming(false); }
  };
  return <View onLayout={event => setNarrow(event.nativeEvent.layout.width < 480)}><Surface variant="card" padding="lg">
    <View style={{ gap: t.length("--space-sm") }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: t.length("--space-sm") }}>
        <View style={{ flex: 1 }}><Text variant="label" lines={1}>{child.title}</Text></View>
        <View style={{ flexDirection: "row", gap: t.length("--space-1") }}>
          {turn?.retryable && !child.active_turn && !child.result ? <IconButton size="sm" variant="ghost" icon={icons.Play}
            label={appCopy.conversation.work.resumeInterrupted} onPress={resume} disabled={resuming} /> : null}
          <IconButton size="sm" variant="ghost" icon={icons.Eye} label={appCopy.interfaceDetails.progressDetails}
            onPress={() => router.push({ pathname: "/chat/[id]", params: { id: child.session_id, title: child.title } })} />
        </View>
      </View>
      <WorkActivityDisclosure status={status} latest={latest} previous={tail.previous} hiddenCount={tail.earlier} live={live} expanded={expanded} onToggle={toggle}
        label={appCopy.conversation.work.disclosureLabel(status, latest, tail.earlier)} detailsLabel={appCopy.conversation.work.detailsRegionLabel(child.title)}>
        {expanded ? <StewardDetails view={childView} /> : null}
      </WorkActivityDisclosure>
    </View>
  </Surface></View>;
}

function StewardDetails({ view }: { view: SessionView | null }) {
  const locale = useAppLocale();
  const copy = getAppCopy(locale);
  const t = useTokens();
  return <View style={{ gap: t.length("--space-md") }}>
    {view?.plan ? <StepTimeline view={view} plan={view.plan} /> : view ? <ActivityTimeline activities={observerActivities(view, locale)}
      expandAll live={!!view.active_turn} pulseLatest={!!view.active_turn} goal={view.relation?.safe_title} /> : null}
    {view?.waiting_for_children && !view.active_turn ? <StatusLine label={copy.conversation.work.pendingStateLabels.waiting_for_children} active /> : null}
    {view?.active_turn ? <StatusLine label={turnStatusLabel(view.active_turn, locale)} active /> : null}
    {!view?.messages.length && !view?.active_turn && !view?.waiting_for_children ? <Text variant="caption">{emptyObserverLabel(view?.status, copy)}</Text> : null}
  </View>;
}

function emptyObserverLabel(status: SessionView["status"] | undefined, copy: AppCopy): string {
  switch (status) {
    case "delivered": return copy.interfaceStatus.delivered;
    case "failed": return copy.interfaceStatus.failedPast;
    case "cancelled": return copy.interfaceStatus.cancelled;
    default: return copy.conversation.work.pendingLabel;
  }
}

function StepTimeline({ view, plan }: { view: SessionView; plan: WorkPlan }) {
  const locale = useAppLocale();
  const t = useTokens();
  const activities = observerActivities(view, locale);
  const groups = stepTimeline(activities, plan, view.workers);
  const newest = activities.at(-1);
  const live = !!view.active_turn;
  return <View style={{ paddingHorizontal: t.length("--space-md"), gap: t.length("--space-md") }}>
    <ActivityTimeline activities={groups.before} expandAll live={live && newest !== undefined && groups.before.includes(newest)}
      pulseLatest={live && newest !== undefined && groups.before.includes(newest)} />
    {groups.steps.map(step => <Fragment key={step.action.action_key}>
      {step.revision ? <RevisionRow revision={step.revision} /> : null}
      <StepGroup action={step.action} activities={step.activities} workers={step.workers} newest={newest} live={live} />
    </Fragment>)}
    {groups.trailingRevisions.map(revision => <RevisionRow key={revision.revision} revision={revision} />)}
    {groups.after.length ? <View style={{ height: 1, backgroundColor: t.color("--line") }} /> : null}
    <ActivityTimeline activities={groups.after} expandAll live={live && newest !== undefined && groups.after.includes(newest)}
      pulseLatest={live && newest !== undefined && groups.after.includes(newest)} />
  </View>;
}

function StepGroup({ action, activities, workers, newest, live }: {
  action: WorkPlanAction; activities: Activity[]; workers: StewardChild[]; newest?: Activity; live: boolean;
}) {
  const t = useTokens();
  const locale = useAppLocale();
  const copy = getAppCopy(locale);
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(true);
  const toggle = () => {
    if (!reduced) LayoutAnimation.configureNext({ duration: t.duration("--motion-base"), update: { type: "easeInEaseOut" },
      create: { type: "easeInEaseOut", property: "opacity" }, delete: { type: "easeInEaseOut", property: "opacity" } });
    setOpen(value => !value);
  };
  return <View style={{ gap: t.length("--space-sm") }}>
    <ListRow title={copy.conversation.work.planSteps.title(action.order, action.title)} meta={workPlanStatusTime(action, copy, locale)}
      description={action.purpose} descriptionLines={1} disclosure={{ expanded: open }} onPress={toggle} />
    {open ? <>
      <ActivityTimeline activities={activities} expandAll live={live && newest !== undefined && activities.includes(newest)}
        pulseLatest={live && newest !== undefined && activities.includes(newest)} />
      {workers.length ? <View style={{ gap: t.length("--space-xs") }}>{workers.map(worker => <StepWorkerCapsule key={worker.session_id} worker={worker} />)}</View> : null}
    </> : null}
  </View>;
}

function RevisionRow({ revision }: { revision: WorkPlanRevision }) {
  const locale = useAppLocale();
  const copy = getAppCopy(locale);
  return <ListRow title={copy.conversation.work.planSteps.revised(revision.added.length, revision.removed.length)}
    meta={workPlanTime(revision.at, locale)} description={revision.reason} />;
}

function StepWorkerCapsule({ worker }: { worker: StewardChild }) {
  const router = useRouter();
  const locale = useAppLocale();
  const copy = getAppCopy(locale);
  const { view } = useSessionViewData(worker.session_id);
  const child = view ? { ...worker, status: view.status, active_turn: view.active_turn, waiting_for_children: view.waiting_for_children,
    approved_plan_total: view.approved_plan_total ?? worker.approved_plan_total,
    approved_plan_completed: view.approved_plan_completed ?? worker.approved_plan_completed } : worker;
  const live = !!(child.active_turn || child.waiting_for_children);
  const activity = live ? workerActivityTitle(stewardCurrentActivityTitle(child, locale), child.title, copy) : stewardProgressStatus(child, copy);
  const label = [child.title, live ? stewardPlanProgress(child) : null, activity].filter(Boolean).join(" · ");
  return <View style={{ alignItems: "flex-start" }}><Button variant="outline" size="sm" label={label}
    accessibilityLabel={copy.interfaceTemplates.viewActivity(label)}
    onPress={() => router.push({ pathname: "/chat/[id]", params: { id: child.session_id, title: child.title } })} /></View>;
}
