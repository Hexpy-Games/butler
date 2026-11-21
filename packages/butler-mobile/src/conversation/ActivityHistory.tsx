import { useEffect, useRef, useState } from "react";
import { Animated, LayoutAnimation, View } from "react-native";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import type { ConversationMessage, WorkerActivityWorkBlock } from "../../../butler-protocol/src/index.ts";
import { Button, Icon, icons, Text, useTokens, WorkActivityBlock } from "@/ds";
import { run, useReducedMotion } from "@/ds/internal/motion";
import { AnimatedPressable, usePress } from "@/ds/internal/press";
import { useAppLocale } from "@/i18n";
import { activityDisplayTitle, delegatedRequestGoal, projectActivities, type Activity } from "./activityProjection";
import { phaseLabel, toolItems, workBlockToolItems } from "./workStatus";
import { ImageToolStill } from "./ImageToolStill";
import { useWorkExpanded } from "./workExpansion";

export function ActivityTimeline({ activities, currentState, live = false, pulseLatest = false, expandAll = false, goal, storeKey }: {
  activities: Activity[]; currentState?: string; live?: boolean; pulseLatest?: boolean; expandAll?: boolean; goal?: string; storeKey?: string;
}) {
  const t = useTokens();
  const locale = useAppLocale();
  const copy = getAppCopy(locale);
  const reduced = useReducedMotion();
  const [local, setLocal] = useState(false);
  const [stored, toggleStored] = useWorkExpanded(storeKey);
  const expanded = storeKey ? stored : local;
  const toggle = () => {
    if (!reduced) LayoutAnimation.configureNext({ duration: t.duration("--motion-base"), update: { type: "easeInEaseOut" },
      create: { type: "easeInEaseOut", property: "opacity" }, delete: { type: "easeInEaseOut", property: "opacity" } });
    if (storeKey) toggleStored(); else setLocal(value => !value);
  };
  const wasSettled = useRef(!live && ["delivered", "completed", "failed", "cancelled"].includes(currentState ?? ""));
  useEffect(() => {
    const settled = !live && ["delivered", "completed", "failed", "cancelled"].includes(currentState ?? "");
    if (settled && !wasSettled.current) {
      if (!reduced) LayoutAnimation.configureNext({ duration: t.duration("--motion-base"), update: { type: "easeInEaseOut" },
        create: { type: "easeInEaseOut", property: "opacity" }, delete: { type: "easeInEaseOut", property: "opacity" } });
      if (storeKey && stored) toggleStored();
      else setLocal(false);
    }
    wasSettled.current = settled;
  }, [live, currentState, storeKey, stored, toggleStored, reduced, t]);
  const latest = activities.at(-1);
  if (!latest) return null;
  return <View style={{ gap: t.length("--space-xs") }}>
    {expandAll ? null : <HistoryHeader expanded={expanded} onToggle={toggle}
      label={copy.interfaceTemplates.activityHistory(live, phaseLabel(currentState ?? latest.phase, copy), activities.length)} />}
    <View style={{ gap: t.length("--space-sm") }}>
      {expanded || expandAll ? activities.map((activity, index) => <ActivityRow key={activity.id} activity={activity}
        connected={index < activities.length - 1} last={index === activities.length - 1}
        live={pulseLatest && index === activities.length - 1} goal={index === 0 ? goal : undefined} />)
        : live ? <LiveActivity key={latest.id} activity={latest} pulseLatest={pulseLatest} goal={activities.length === 1 ? goal : undefined} /> : null}
      {expanded && !expandAll ? <View style={{ alignItems: "flex-start" }}>
        <Button variant="ghost" size="sm" iconStart={icons.ListChecks} label={copy.conversation.work.collapseLabel} onPress={toggle} />
      </View> : null}
    </View>
  </View>;
}

function HistoryHeader({ label, expanded, onToggle }: { label: string; expanded: boolean; onToggle: () => void }) {
  const t = useTokens();
  const press = usePress({ scale: false });
  return <AnimatedPressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={onToggle} {...press.handlers}
    hitSlop={Math.max(0, (44 - t.length("--typo-body-line-height")) / 2)}
    style={{ flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: t.length("--space-1"),
      boxShadow: press.focused ? t.shadow("--focus-ring") : undefined }}>
    <View style={{ flexShrink: 1 }}><Text variant="body" tone="secondary">{label}</Text></View>
    <Icon glyph={expanded ? icons.ChevronDown : icons.ChevronRight} size="sm" tone="secondary" />
  </AnimatedPressable>;
}

function LiveActivity({ activity, pulseLatest, goal }: { activity: Activity; pulseLatest: boolean; goal?: string }) {
  const t = useTokens();
  const reduced = useReducedMotion();
  const enter = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    enter.setValue(reduced ? 1 : 0);
    if (reduced) return;
    const animation = run(t, enter, 1, "--motion-base", "--motion-ease-standard");
    animation.start();
    return () => animation.stop();
  }, [activity.id, reduced, t, enter]);
  return <Animated.View style={{ opacity: enter, transform: reduced ? undefined : [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [t.length("--motion-distance-md"), 0] }) }] }}>
    <ActivityRow activity={activity} live={pulseLatest} goal={goal} last />
  </Animated.View>;
}

export function ActivityRow({ activity, connected, last, live, goal }: { activity: Activity; connected?: boolean; last?: boolean; live?: boolean; goal?: string }) {
  const locale = useAppLocale();
  const copy = getAppCopy(locale);
  const date = activity.createdAt ? new Date(activity.createdAt) : undefined;
  const time = date ? Number.isNaN(date.getTime()) ? activity.createdAt : new Intl.DateTimeFormat(locale, {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(date) : undefined;
  const summary = delegatedRequestGoal(activity, goal, copy);
  const normalize = (value: string) => value.trim().replace(/\s+/gu, " ");
  const description = [
    [phaseLabel(activity.phase, copy), time].filter(Boolean).join(" · "),
    normalize(activity.title) === normalize(summary) ? undefined : <View style={{ opacity: 0.78 }}>
      <Text variant="caption" tone="tertiary" lines={summary !== activity.summary ? 1 : undefined}>{copy.interfaceDetails.contentLabel} {summary}</Text>
    </View>,
    activity.rationale ? `${copy.interfaceDetails.intentLabel} ${activity.rationale}` : undefined,
    activity.nextStep ? `${copy.interfaceDetails.nextLabel} ${activity.nextStep}` : undefined,
  ].filter((line): line is string | React.ReactElement => Boolean(line));
  return <WorkActivityBlock renderAfter={tool => tool.images ? <ImageToolStill tool={tool} /> : null} density="compact" title={activityDisplayTitle(activity, copy)} description={description}
    connected={connected} last={last} live={live} tools={toolItems(activity.operations.map(row => ({ ...row, turn_id: activity.turnId ?? row.turn_id })), locale)} />;
}

export function MessageActivity({ message }: { message: ConversationMessage }) {
  const locale = useAppLocale();
  const { activities, semanticState } = projectActivities(message.turn_activity_rows ?? [], message.turn_id, locale);
  const live = message.status === "streaming";
  if (activities.length) return <ActivityTimeline activities={activities} currentState={live ? semanticState : message.status} live={live} storeKey={message.id} />;
  return !live && message.work_blocks?.length ? <CompletedWork blocks={message.work_blocks} message={message} /> : null;
}

function CompletedWork({ blocks, message }: { blocks: WorkerActivityWorkBlock[]; message: ConversationMessage }) {
  const locale = useAppLocale();
  const copy = getAppCopy(locale);
  const t = useTokens();
  const reduced = useReducedMotion();
  const [expanded, toggleExpanded] = useWorkExpanded(message.id);
  const latest = blocks[blocks.length - 1];
  const toggle = () => {
    if (!reduced) LayoutAnimation.configureNext({ duration: t.duration("--motion-base"), update: { type: "easeInEaseOut" },
      create: { type: "easeInEaseOut", property: "opacity" }, delete: { type: "easeInEaseOut", property: "opacity" } });
    toggleExpanded();
  };
  return <View style={{ gap: t.length("--space-md") }}>
    <HistoryHeader label={copy.interfaceTemplates.activityHistory(false, copy.guided.tools[latest.label] ?? latest.label, blocks.length)} expanded={expanded} onToggle={toggle} />
    {expanded ? <>
      {blocks.map((block, index) => <WorkActivityBlock renderAfter={tool => tool.images ? <ImageToolStill tool={tool} /> : null} key={block.id} density="normal" title={copy.guided.tools[block.label] ?? block.label}
        description={[block.decision_rationale, block.decision_next_step].filter((line): line is string => Boolean(line))}
        last={index === blocks.length - 1} live={false} tools={workBlockToolItems(block, message.turn_id, locale)} />)}
      <View style={{ alignItems: "flex-start" }}><Button variant="ghost" size="sm" iconStart={icons.ListChecks} label={copy.conversation.work.collapseLabel} onPress={toggle} /></View>
    </> : null}
  </View>;
}
