import { useCallback, useEffect, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { confirmAction } from "@/app/confirmation.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import { formatBytes } from "./logFormat";
import { LOG_PRESETS, readLogConfig, writeLogConfig, type LogConfigView, type LogPreset } from "./logsApi";

export interface LogConfigState {
  config: LogConfigView | null;
  failed: boolean;
  saving: boolean;
  minutesLeft: number | null;
  reload: () => void;
  setLevel: (level: LogPreset) => Promise<void>;
  setCategoryLevel: (category: string, level: string | null) => Promise<void>;
}

/** Whole minutes left in the full-logging lease, rounded up; null without a lease. */
function minutesUntil(expiresAt: string | null | undefined, now: number): number | null {
  if (!expiresAt) return null;
  const ms = Date.parse(expiresAt) - now;
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 60_000)) : null;
}

export function useLogConfig(): LogConfigState {
  const [config, setConfig] = useState<LogConfigView | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    readLogConfig().then((next) => { if (!cancelled) setConfig(next); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [attempt]);

  const expiresAt = config?.full_expires_at;
  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  const minutesLeft = minutesUntil(expiresAt, now);
  // The agent ends the lease itself; read the level it fell back to.
  useEffect(() => {
    if (minutesLeft === 0) setAttempt((value) => value + 1);
  }, [minutesLeft]);

  const save = useCallback(async (level: LogPreset, categories: Record<string, string>) => {
    const previous = config?.effective.level;
    setSaving(true);
    try {
      const next = await writeLogConfig(level, categories);
      setConfig(next);
      setNow(Date.now());
      const lowered = previous !== undefined && LOG_PRESETS.indexOf(level) < LOG_PRESETS.indexOf(previous);
      if (lowered || next.freed_bytes > 0) {
        notifyStatus(next.freed_bytes > 0 ? appCopy.settings.logs.freed(formatBytes(next.freed_bytes)) : appCopy.settings.saved,
          { id: "logs-level", tone: "ok" });
      }
    } catch (error) {
      notifyError(error, appCopy.settings.errors.saveFailed, { id: "logs-level" });
    } finally {
      setSaving(false);
    }
  }, [config]);

  const setLevel = useCallback(async (level: LogPreset) => {
    if (!config || level === config.effective.level) return;
    const copy = appCopy.settings.logs;
    if (level === "full" && !await confirmAction(copy.fullConfirmBody, {
      title: copy.fullConfirmTitle, confirmLabel: copy.fullConfirm,
    })) return;
    await save(level, config.effective.category_levels);
  }, [config, save]);

  const setCategoryLevel = useCallback(async (category: string, level: string | null) => {
    if (!config) return;
    const categories = { ...config.effective.category_levels };
    if (level) categories[category] = level;
    else delete categories[category];
    await save(config.effective.level, categories);
  }, [config, save]);

  return {
    config, failed, saving, minutesLeft,
    reload: () => setAttempt((value) => value + 1),
    setLevel, setCategoryLevel,
  };
}
