import { useAppLocale } from "@/app/copy.ts";
import { useEffect, useState } from "react";
import {
  Button,
  ChevronDown,
  ChevronRight,
  ListChecks,
  RollingSwap,
  Stack,
  Typo,
  WorkActivityBlock,
} from "@/butler-ds";
import type { PhaseActivity } from "@/app/conversation-progress";
import { delegatedRequestGoal } from "./delegatedRequestGoal";
import { phaseLabel } from "./phaseLabel";
import { appCopy } from "@/app/copy.ts";
import { workActivityToolsFromRows } from "./toolchainUtils";
import { BrowserTimelineStill } from "../browser/BrowserTimelineStill";

export function TurnActivityTimeline({
  activities,
  currentState,
  live = false,
  turnId,
  delegatedGoal,
}: {
  delegatedGoal?: string;
  activities: Array<PhaseActivity & { turnId?: string }>;
  currentState?: string;
  live?: boolean;
  turnId?: string;
}) {
  useAppLocale();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!live && ["delivered", "completed", "failed", "cancelled"].includes(currentState ?? "")) setExpanded(false);
  }, [live, currentState]);
  const workCopy = appCopy.conversation.work;
  const latest = activities.at(-1);
  if (!latest) return null;
  const currentPhase = phaseLabel(currentState ?? latest.phase);
  const headerLabel = appCopy.interfaceTemplates.activityHistory(live, currentPhase, activities.length);

  return (
    <section
      aria-label={live ? appCopy.interfaceDetails.currentWork : appCopy.interfaceDetails.turnActivities}
      data-test-class="turn-current-phase-activity"
      data-turn-id={turnId}
      data-turn-ids={[...new Set(activities.map((activity) => activity.turnId ?? turnId).filter(Boolean))].join(" ")}
    >
      <Stack gap="xs" aria-live={live ? "polite" : undefined}>
        <Stack cross="start">
          <Button
            aria-expanded={expanded}
            data-test-class="toggle-turn-activity-disclosure"
            iconEnd={expanded ? <ChevronDown size="sm" /> : <ChevronRight size="sm" />}
            onClick={() => setExpanded((value) => !value)}
            text={headerLabel}
            type="button"
            variant="inline"
          />
        </Stack>
        <Stack gap="sm">
          {!expanded && <BrowserTimelineStill activities={activities} turnId={turnId} live={live} />}
          {expanded ? (
            <Stack as="ol" gap="sm">
              {activities.map((activity, index) => (
                <li key={activity.id} data-turn-id={activity.turnId ?? turnId}>
                  <ActivityBlock
                    activity={activity}
                    delegatedGoal={index === 0 ? delegatedGoal : undefined}
                    connected={index < activities.length - 1}
                    turnId={activity.turnId ?? turnId}
                  />
                </li>
              ))}
            </Stack>
          ) : live ? (
            <RollingSwap itemKey={latest.id} motion={live}>
              <ActivityBlock activity={latest} delegatedGoal={activities.length === 1 ? delegatedGoal : undefined} turnId={latest.turnId ?? turnId} />
            </RollingSwap>
          ) : null}
          {expanded ? (
            <Stack as="footer" cross="start">
              <Button
                data-test-class="collapse-turn-activity-history"
                iconStart={<ListChecks size="sm" />}
                onClick={() => setExpanded(false)}
                size="xs"
                text={workCopy.collapseLabel}
                type="button"
                variant="borderless"
              />
            </Stack>
          ) : null}
        </Stack>
      </Stack>
    </section>
  );
}

function ActivityBlock({
  activity,
  connected = false,
  delegatedGoal,
  turnId,
}: {
  activity: PhaseActivity;
  delegatedGoal?: string;
  connected?: boolean;
  turnId?: string;
}) {
  useAppLocale();
  const meta = activity.createdAt
    ? `${phaseLabel(activity.phase)} · ${formatActivityTime(activity.createdAt)}`
    : phaseLabel(activity.phase);
  const summary = delegatedRequestGoal(activity, delegatedGoal);
  return (
    <WorkActivityBlock
      density="compact"
      connected={connected}
      data-work-stage={activity.phase}
      title={/(?:사용자 요청|User request):/iu.test(activity.title) ? appCopy.guided.tools.start_work : activity.title}
      description={
        <Stack as="span" gap="xs">
          <Typo.Caption as="span">{meta}</Typo.Caption>
          {sameActivityText(activity.title, summary) ? null : (
            <Typo.Caption as="span" truncate={summary !== activity.summary}>{appCopy.interfaceDetails.contentLabel} {summary}</Typo.Caption>
          )}
          {activity.rationale ? (
            <Typo.Caption as="span">{appCopy.interfaceDetails.intentLabel} {activity.rationale}</Typo.Caption>
          ) : null}
          {activity.nextStep ? (
            <Typo.Caption as="span">{appCopy.interfaceDetails.nextLabel} {activity.nextStep}</Typo.Caption>
          ) : null}
        </Stack>
      }
      tools={workActivityToolsFromRows(activity.operations, turnId)}
    />
  );
}

function sameActivityText(left: string, right: string): boolean {
  const normalize = (value: string) => value.trim().replace(/\s+/gu, " ");
  return normalize(left) === normalize(right);
}

function formatActivityTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}
