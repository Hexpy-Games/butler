import { useEffect, useState } from "react";
import type { ProgressRow } from "@/app/types.ts";
import { Stack, Typo } from "@/butler-ds";

const secondaryText = {
  color: "var(--text-secondary)",
  minWidth: 0,
  overflowWrap: "anywhere",
} as const;

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
        <Typo.Body as="p" style={secondaryText}>
          {showLabel ? row.safe_label : "응답 생성 중"}
          {elapsed ? ` · ${elapsed}` : ""}
        </Typo.Body>
        <Typo.Caption as="p" style={secondaryText}>
          마지막으로 공개한 작업 의도를 이어서 응답을 생성 중입니다.
        </Typo.Caption>
      </Stack>
    </section>
  );
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
  return `${minutes}분 ${totalSeconds % 60}초 경과`;
}
