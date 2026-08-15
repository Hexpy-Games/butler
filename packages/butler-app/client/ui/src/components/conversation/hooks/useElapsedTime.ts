import { useEffect, useState } from "react";

export function useElapsedTime(startedAt?: string): string {
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
