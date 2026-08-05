import { useState } from "react";
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
import { phaseLabel } from "./phaseLabel";
import { appCopy } from "@/app/copy.ts";
import { workActivityToolsFromRows } from "./toolchainUtils";

export function TurnActivityTimeline({
  activities,
  currentState,
  live = false,
  turnId,
}: {
  activities: PhaseActivity[];
  currentState?: string;
  live?: boolean;
  turnId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const workCopy = appCopy.conversation.work;
  const latest = activities.at(-1);
  if (!latest) return null;
  const currentPhase = phaseLabel(currentState ?? latest.phase);
  const headerLabel = `${live ? "현재" : "활동"} · ${currentPhase} · ${activities.length}개 기록`;

  return (
    <section
      aria-label={live ? "현재 작업" : "이 턴의 활동"}
      data-test-class="turn-current-phase-activity"
      data-turn-id={turnId}
    >
      <Stack gap="xs" aria-live={live ? "polite" : undefined}>
        <Stack cross="start">
          <Button
            aria-expanded={expanded}
            data-test-class="toggle-turn-activity-disclosure"
            iconEnd={expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            onClick={() => setExpanded((value) => !value)}
            text={headerLabel}
            type="button"
            variant="inline"
          />
        </Stack>
        <Stack gap="sm">
          {expanded ? (
            <Stack as="ol" gap="sm" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {activities.map((activity, index) => (
                <li key={activity.id}>
                  <ActivityBlock
                    activity={activity}
                    connected={index < activities.length - 1}
                    turnId={turnId}
                  />
                </li>
              ))}
            </Stack>
          ) : live ? (
            <RollingSwap itemKey={latest.id} motion={live}>
              <ActivityBlock activity={latest} turnId={turnId} />
            </RollingSwap>
          ) : null}
          {expanded ? (
            <Stack as="footer" cross="start">
              <Button
                data-test-class="collapse-turn-activity-history"
                iconStart={<ListChecks size={14} />}
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
  turnId,
}: {
  activity: PhaseActivity;
  connected?: boolean;
  turnId?: string;
}) {
  const meta = activity.createdAt
    ? `${phaseLabel(activity.phase)} · ${formatActivityTime(activity.createdAt)}`
    : phaseLabel(activity.phase);
  return (
    <WorkActivityBlock
      density="compact"
      connected={connected}
      data-work-stage={activity.phase}
      title={activity.title}
      description={
        <Stack as="span" gap="xs">
          <Typo.Caption as="span">{meta}</Typo.Caption>
          {sameActivityText(activity.title, activity.summary) ? null : (
            <Typo.Caption as="span">내용: {activity.summary}</Typo.Caption>
          )}
          {activity.rationale ? (
            <Typo.Caption as="span">의도: {activity.rationale}</Typo.Caption>
          ) : null}
          {activity.nextStep ? (
            <Typo.Caption as="span">다음: {activity.nextStep}</Typo.Caption>
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
