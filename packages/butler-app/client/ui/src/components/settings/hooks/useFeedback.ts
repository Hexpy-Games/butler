import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { confirmAction } from "@/app/confirmation.ts";
import { onMemoryEvent } from "@/app/memoryEvents.ts";
import { notifyStatus } from "@/app/notifications.ts";
import type { SettingsSectionState } from "@/butler-ds";
import { feedbackScope, type FeedbackEntry } from "../feedbackTypes";
import type { MemoryProject } from "../memoryTypes";
export function useFeedback(projects: MemoryProject[]) {
  const [rows, setRows] = useState<FeedbackEntry[]>([]);
  const [updated, setUpdated] = useState<string>();
  const [state, setState] = useState<SettingsSectionState>("loading");
  const [busy, setBusy] = useState<string>();
  const locked = useRef(false);
  const alive = useRef(false);
  const flight = useRef<Promise<void> | undefined>(undefined);
  const pending = useRef(false);
  const reload = useCallback(() => {
    if (flight.current) { pending.current = true; return flight.current; }
    flight.current = (async () => {
      do {
        pending.current = false;
        try {
          const result = await api<{ entries: FeedbackEntry[] }>("/memory/feedback");
          if (alive.current) {
            const active = result.entries.filter((item) => ["active", "pending", "needs_clarification"].includes(item.state));
            setRows(active);
            setUpdated(result.entries.map((item) => item.updated_at).sort().at(-1));
            setState(active.length ? "ready" : "empty");
          }
        } catch { if (alive.current) setState("error"); }
      } while (pending.current && alive.current);
    })().finally(() => { flight.current = undefined; });
    return flight.current;
  }, []);
  useEffect(() => {
    alive.current = true;
    void reload();
    const off = onMemoryEvent(() => { void reload(); });
    return () => { alive.current = false; off(); };
  }, [reload]);
  const change = async (item?: FeedbackEntry) => {
    if (locked.current) return;
    locked.current = true;
    const copy = appCopy.settings.memory;
    const accepted = await confirmAction(item ? copy.chatsKept : copy.feedback.resetDetail, {
      title: item ? copy.feedback.deleteTitle : copy.feedback.resetTitle,
      confirmLabel: item ? appCopy.common.delete : copy.feedback.reset, destructive: true,
      details: item ? [{ text: item.text, caption: feedbackScope(item, projects) }] : undefined,
    });
    if (!accepted) { locked.current = false; return; }
    setBusy(item?.feedback_id ?? "reset");
    try {
      await api(item ? `/memory/feedback/${encodeURIComponent(item.feedback_id)}` : "/memory/feedback/reset", { method: item ? "DELETE" : "POST" });
      await reload();
      notifyStatus(item ? copy.feedback.deleted : copy.feedback.resetDone, { id: "feedback", tone: "ok" });
    } catch { notifyStatus(copy.feedback.changeFailed, { id: "feedback", tone: "error" }); }
    finally { if (alive.current) setBusy(undefined); locked.current = false; }
  };
  return { rows, updated, state, busy, reload, change };
}
