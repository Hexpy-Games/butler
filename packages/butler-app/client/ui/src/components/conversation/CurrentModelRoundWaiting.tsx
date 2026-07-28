import { useEffect, useState } from "react";
import type { ProgressRow } from "@/app/types.ts";
import { Typo } from "@/butler-ds";

const secondaryText = {
  color: "var(--text-secondary)",
  minWidth: 0,
  overflowWrap: "anywhere",
} as const;

export function CurrentModelRoundWaiting({ row }: { row: ProgressRow }) {
  const elapsed = useElapsedTime(row.created_at);
  return (
    <section
      data-test-class="turn-model-round-waiting"
      aria-label="모델 응답 대기"
    >
      <Typo.Body as="p" style={secondaryText}>
        응답 생성 중
        {elapsed ? ` · ${elapsed}` : ""}
      </Typo.Body>
    </section>
  );
}

function useElapsedTime(startedAt?: string): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  if (!startedAt) return "";
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return "";
  const totalSeconds = Math.max(0, Math.floor((now - started) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}분 ${totalSeconds % 60}초`;
}
