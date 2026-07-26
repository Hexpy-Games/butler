import { useState } from "react";
import { Button, ListChecks, Stack, Typo, WorkActivityBlock } from "@/butler-ds";
import type { PhaseActivity } from "./turnActivityRows";
import { phaseLabel } from "./phaseLabel";
import { appCopy } from "@/app/copy.ts";
import { workActivityToolsFromRows } from "./toolchainUtils";

const metaStyle = { color: "var(--text-secondary)" } as const;

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

  return (
    <section
      aria-label={live ? "현재 작업" : "이 턴의 활동"}
      data-test-class="turn-current-phase-activity"
    >
      <Stack gap="xs" aria-live={live ? "polite" : undefined}>
        <Typo.Caption as="p" style={metaStyle}>
          {live ? "현재" : "활동"} · {currentPhase} · {activities.length}개 기록
        </Typo.Caption>
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
        ) : (
          <ActivityBlock activity={latest} rolling={live} turnId={turnId} />
        )}
        {activities.length > 1 ? (
          <Button
            aria-expanded={expanded}
            data-test-class="toggle-turn-activity-history"
            iconStart={<ListChecks size={14} />}
            onClick={() => setExpanded((value) => !value)}
            size="xs"
            text={
              expanded
                ? workCopy.collapseLabel
                : workCopy.viewAllLabel(activities.length)
            }
            type="button"
            variant="borderless"
          />
        ) : null}
      </Stack>
    </section>
  );
}

function ActivityBlock({
  activity,
  rolling = false,
  connected = false,
  turnId,
}: {
  activity: PhaseActivity;
  rolling?: boolean;
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
      rolling={rolling}
      title={activity.summary}
      description={
        <Stack as="span" gap="xs">
          <Typo.Caption as="span">{meta}</Typo.Caption>
          <Typo.Caption as="span">의도: {activity.rationale}</Typo.Caption>
          <Typo.Caption as="span">다음: {activity.nextStep}</Typo.Caption>
        </Stack>
      }
      tools={workActivityToolsFromRows(activity.operations, turnId)}
    />
  );
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
