import { useState } from "react";
import { DisclosureRow, ListChecks, Stack, Typo } from "@/butler-ds";
import type { ProgressRow } from "@/app/types.ts";
import type { PhaseActivity } from "./turnActivityRows";
import styles from "./PhaseActivityLog.module.css";

export function CurrentPhaseActivity({ row }: { row: ProgressRow }) {
  return (
    <Typo.Body
      as="p"
      data-test-class="turn-phase-activity"
      data-turn-state={row.state}
      className={styles.secondary}
    >
      {row.safe_label}
    </Typo.Body>
  );
}

export function PhaseActivityLog({
  activities,
}: {
  activities: PhaseActivity[];
}) {
  const [expanded, setExpanded] = useState(true);
  const latest = activities.at(-1);
  if (!latest) return null;

  return (
    <section
      data-test-class="turn-phase-activity-log"
      aria-label="작업 진행 로그"
    >
      <DisclosureRow
        icon={<ListChecks size={15} />}
        open={expanded}
        surface="plain"
        title="작업 진행 로그"
        description={latest.summary}
        meta={`${activities.length}개 기록`}
        onToggle={() => setExpanded((value) => !value)}
      >
        <Stack gap="md" role="log" aria-live="polite">
          {activities.map((activity, index) => (
            <Stack
              as="article"
              gap="xs"
              className={styles.activity}
              data-test-class="turn-phase-activity"
              key={activity.id}
            >
              <Typo.Caption as="p" className={styles.secondary}>
                {phaseLabel(activity.phase)} · {index + 1}
              </Typo.Caption>
              <Typo.Body as="p" className={styles.secondary}>
                {activity.summary}
              </Typo.Body>
              <Typo.Caption as="p" className={styles.secondary}>
                {activity.rationale}
              </Typo.Caption>
              <Typo.Caption as="p" className={styles.secondary}>
                다음: {activity.nextStep}
              </Typo.Caption>
            </Stack>
          ))}
        </Stack>
      </DisclosureRow>
    </section>
  );
}

function phaseLabel(phase?: string): string {
  if (!phase) return "진행";
  if (phase.startsWith("conception")) return "구상";
  if (phase === "contract_review") return "구상 검토";
  if (phase === "planning") return "계획";
  if (phase === "planning_review") return "계획 검토";
  if (phase === "task_execution") return "실행";
  if (phase === "task_review") return "작업 리뷰";
  if (phase.startsWith("feedback_")) return "피드백 반영";
  if (phase === "consolidation") return "통합 점검";
  if (phase === "reporting") return "보고";
  return "진행";
}
