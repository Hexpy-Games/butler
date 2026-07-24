import { useEffect, useState } from "react";
import { Stack, Typo } from "@/butler-ds";
import type { ProgressRow } from "@/app/types.ts";
import type { PhaseActivity } from "./turnActivityRows";
import { ViewTurnActivityButton } from "./ViewTurnActivityButton";
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

export function CurrentModelPhaseActivity({
  activities,
  currentState,
}: {
  activities: PhaseActivity[];
  currentState?: string;
}) {
  const latest = activities.at(-1);
  if (!latest) return null;

  return (
    <section
      data-test-class="turn-current-phase-activity"
      aria-label="현재 작업"
    >
      <Stack gap="xs" aria-live="polite">
        <Typo.Caption as="p" className={styles.secondary}>
          현재 · {phaseLabel(currentState ?? latest.phase)} · 전체 {activities.length}개 기록
        </Typo.Caption>
        <Typo.Body as="p" className={styles.secondary}>
          {latest.summary}
        </Typo.Body>
        <Typo.Caption as="p" className={styles.secondary}>
          {latest.rationale}
        </Typo.Caption>
        <Typo.Caption as="p" className={styles.secondary}>
          다음: {latest.nextStep}
        </Typo.Caption>
        <ViewTurnActivityButton count={activities.length} />
      </Stack>
    </section>
  );
}

export function CurrentModelRoundWaiting({
  row,
  showLabel = true,
}: {
  row: ProgressRow;
  showLabel?: boolean;
}) {
  const elapsed = useElapsedTime(row.created_at);
  return (
    <section
      data-test-class="turn-model-round-waiting"
      aria-label="모델 응답 대기"
    >
      <Stack gap="xs" aria-live="polite">
        <Typo.Body as="p" className={styles.secondary}>
          {showLabel ? row.safe_label : "응답 생성 중"}
          {elapsed ? ` · ${elapsed}` : ""}
        </Typo.Body>
        <Typo.Caption as="p" className={styles.secondary}>
          마지막으로 공개한 작업 의도를 이어서 응답을 생성 중입니다.
        </Typo.Caption>
      </Stack>
    </section>
  );
}

export function phaseLabel(phase?: string): string {
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

function useElapsedTime(startedAt?: string): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  if (!startedAt) return "";
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return "";
  const totalSeconds = Math.max(0, Math.floor((now - started) / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}초 경과`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}분 ${seconds}초 경과`;
}
