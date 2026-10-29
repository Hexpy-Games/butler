import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { confirmAction } from "@/app/confirmation.ts";
import { onMemoryEvent } from "@/app/memoryEvents.ts";
import { notifyStatus } from "@/app/notifications.ts";
import type { SettingsSectionState } from "@/butler-ds";

export interface NoticedPattern {
  id: string;
  title: string;
  evidence: { count: number; first_at: string; last_at: string };
}
interface PatternsView { revision: number; patterns: NoticedPattern[] }

export function patternMeta(item: NoticedPattern) {
  const copy = appCopy.settings.memory;
  const days = Math.max(1, Math.ceil((Date.now() - Date.parse(item.evidence.first_at)) / 86_400_000));
  const weeks = Math.floor(days / 7);
  const span = days < 14 ? copy.patternDays(days) : weeks < 9 ? copy.patternWeeks(weeks) : copy.patternMonths(Math.max(1, Math.floor(days / 30)));
  return `${span} · ${copy.patternCount(item.evidence.count)}`;
}

export function usePatterns() {
  const [view, setView] = useState<PatternsView>({ revision: 0, patterns: [] });
  const [state, setState] = useState<SettingsSectionState>("loading");
  const [deleting, setDeleting] = useState<string>();
  const alive = useRef(false);
  const busy = useRef(false);
  const request = useRef(0);
  const reload = useCallback(async () => {
    const version = ++request.current;
    const next = await api<PatternsView>("/memory/patterns");
    if (alive.current && version === request.current) { setView(next); setState(next.patterns.length ? "ready" : "empty"); }
    return next.patterns;
  }, []);
  const refresh = useCallback(() => {
    void reload().catch(() => { if (alive.current) setState("error"); });
  }, [reload]);
  useEffect(() => {
    alive.current = true;
    refresh();
    const off = onMemoryEvent(event => {
      if (event.type === "stream.reconcile_required" || (event.type === "memory.operation" &&
        (event.payload.kind === "patterns" || (event.payload.kind === "consolidation" && event.payload.phase === "complete")))) refresh();
    });
    return () => { alive.current = false; ++request.current; off(); };
  }, [refresh]);
  const remove = async (item: NoticedPattern) => {
    if (busy.current) return;
    busy.current = true;
    const copy = appCopy.settings.memory;
    try {
      const accepted = await confirmAction(copy.deletePatternBody, { title: copy.deletePatternTitle,
        confirmLabel: appCopy.common.delete, destructive: true, details: [{ text: item.title }] });
      if (!accepted) return;
      setDeleting(item.id);
      const index = view.patterns.findIndex(row => row.id === item.id);
      await api(`/memory/patterns/${encodeURIComponent(item.id)}`, { method: "DELETE", body: JSON.stringify({ expected_revision: view.revision }) });
      const next = await reload();
      notifyStatus(copy.patternDeleted, { id: "pattern", tone: "ok" });
      const target = next[Math.min(index, next.length - 1)];
      requestAnimationFrame(() => {
        if (!alive.current) return;
        const row = target ? document.getElementById(`pattern-${target.id}`) : document.querySelector('[data-setting-id="proactive-level"]');
        row?.querySelector<HTMLElement>("[aria-expanded], button")?.focus();
      });
    } catch (error) {
      if ((error as { status?: number }).status === 409) await reload().catch(() => { if (alive.current) setState("error"); });
      notifyStatus(copy.deleteFailed, { id: "pattern", tone: "error" });
    } finally { busy.current = false; if (alive.current) setDeleting(undefined); }
  };
  return { rows: view.patterns, state, deleting, reload: refresh, remove };
}
