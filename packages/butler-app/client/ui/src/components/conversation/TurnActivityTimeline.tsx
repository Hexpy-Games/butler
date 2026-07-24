import { useState } from "react";
import { Button, ListChecks, Stack, Typo } from "@/butler-ds";
import type { PhaseActivity } from "./turnActivityRows";
import { phaseLabel } from "./PhaseActivityLog";
import styles from "./TurnActivityTimeline.module.css";
import { appCopy } from "@/app/copy.ts";

export function TurnActivityTimeline({
  activities,
  currentState,
  live = false,
}: {
  activities: PhaseActivity[];
  currentState?: string;
  live?: boolean;
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
        <Typo.Caption as="p" className={styles.meta}>
          {live ? "현재" : "활동"} · {currentPhase} · {activities.length}개 기록
        </Typo.Caption>
        {expanded ? (
          <ol className={styles.history}>
            {activities.map((activity) => (
              <li className={styles.historyItem} key={activity.id}>
                <Typo.Caption as="p" className={styles.itemMeta}>
                  {phaseLabel(activity.phase)}
                  {activity.createdAt
                    ? ` · ${formatActivityTime(activity.createdAt)}`
                    : ""}
                </Typo.Caption>
                <Typo.Body as="p" className={styles.summary}>
                  {activity.summary}
                </Typo.Body>
                <Typo.Caption as="p" className={styles.detail}>
                  의도: {activity.rationale}
                </Typo.Caption>
                <Typo.Caption as="p" className={styles.detail}>
                  다음: {activity.nextStep}
                </Typo.Caption>
              </li>
            ))}
          </ol>
        ) : (
          <div
            className={live ? styles.rolling : styles.current}
            key={latest.id}
          >
            <Typo.Body as="p" className={styles.summary}>
              {latest.summary}
            </Typo.Body>
            <Typo.Caption as="p" className={styles.detail}>
              의도: {latest.rationale}
            </Typo.Caption>
            <Typo.Caption as="p" className={styles.detail}>
              다음: {latest.nextStep}
            </Typo.Caption>
          </div>
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

function formatActivityTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}
