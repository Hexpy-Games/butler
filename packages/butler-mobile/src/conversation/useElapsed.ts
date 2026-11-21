import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { useAppLocale } from "@/i18n";
import { useEffect, useState } from "react";

export function useElapsed(startedAt?: string): string {
  const appCopy = getAppCopy(useAppLocale());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (!startedAt) return "";
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return "";
  const totalSeconds = Math.max(0, Math.floor((now - started) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  return appCopy.interfaceTemplates.elapsed(minutes, totalSeconds % 60);
}
