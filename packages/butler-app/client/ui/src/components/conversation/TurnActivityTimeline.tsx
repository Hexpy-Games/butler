import { useAppLocale } from "@/app/copy.ts";
import { useEffect, useState } from "react";
import {
  Button,
  ChevronDown,
  ChevronRight,
  ListChecks,
  RollingSwap,
  Stack,
} from "@/butler-ds";
import type { PhaseActivity } from "@/app/conversation-progress";
import { phaseLabel } from "./phaseLabel";
import { appCopy } from "@/app/copy.ts";
import { ActivityBlock } from "./TurnActivityBlock";
import { BrowserTimelineStill } from "../browser/BrowserTimelineStill";

export function TurnActivityTimeline({
  activities,
  currentState,
  live = false,
  turnId,
  delegatedGoal,
  expandAll = false,
  pulseLatest = false,
}: {
  /** The newest activity belongs to running work: its timeline dot pulses. */
  pulseLatest?: boolean;
  delegatedGoal?: string;
  /** Always list every activity, without this timeline's own disclosure (its owner already opened it). */
  expandAll?: boolean;
  activities: Array<PhaseActivity & { turnId?: string }>;
  currentState?: string;
  live?: boolean;
  turnId?: string;
}) {
  useAppLocale();
  const [expandedState, setExpanded] = useState(false);
  const expanded = expandAll || expandedState;
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
        {expandAll ? null : <Stack cross="start">
          <Button
            aria-expanded={expanded}
            data-test-class="toggle-turn-activity-disclosure"
            iconEnd={expanded ? <ChevronDown size="sm" /> : <ChevronRight size="sm" />}
            onClick={() => setExpanded((value) => !value)}
            text={headerLabel}
            type="button"
            variant="inline"
          />
        </Stack>}
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
                    live={pulseLatest && index === activities.length - 1}
                    turnId={activity.turnId ?? turnId}
                  />
                </li>
              ))}
            </Stack>
          ) : live ? (
            <RollingSwap itemKey={latest.id} motion={live}>
              <ActivityBlock activity={latest} delegatedGoal={activities.length === 1 ? delegatedGoal : undefined} live={pulseLatest} turnId={latest.turnId ?? turnId} />
            </RollingSwap>
          ) : null}
          {expanded && !expandAll ? (
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
