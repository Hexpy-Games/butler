import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { onMemoryEvent } from "@/app/memoryEvents.ts";
import { notifyStatus } from "@/app/notifications.ts";
import type { ConsolidationReceipt, ConsolidationStatus } from "../memoryTypes";

/** Event-driven status, with notifications restricted to operation ids we created. */
export function useConsolidation() {
  const [status, setStatus] = useState<ConsolidationStatus>();
  const [active, setActive] = useState<ConsolidationReceipt>();
  const [starting, setStarting] = useState(false);
  const [leaseBusy, setLeaseBusy] = useState(false);
  const alive = useRef(false);
  const request = useRef(0);
  const pending = useRef(false);
  const current = useRef<ConsolidationReceipt | undefined>(undefined);
  const owned = useRef(new Set<string>());
  const seen = useRef(new Map<string, number>());
  const accept = useCallback((next: ConsolidationReceipt) => {
    if ((seen.current.get(next.operation_id) ?? -1) >= next.sequence) return;
    seen.current.set(next.operation_id, next.sequence);
    current.current = next.phase === "running" ? next : undefined;
    if (alive.current) setActive(current.current);
    if (next.phase !== "running" && owned.current.delete(next.operation_id)) {
      const copy = appCopy.settings.memory;
      notifyStatus(next.phase === "complete" ? copy.consolidationDone : copy.consolidationFailed,
        { id: "memory-consolidation", tone: next.phase === "complete" ? "ok" : "error" });
    }
  }, []);
  const reload = useCallback(async () => {
    const version = ++request.current;
    try {
      const next = await api<ConsolidationStatus>("/memory/consolidation");
      if (!alive.current || version !== request.current) return;
      setStatus(next);
      if (next.active) accept(next.active);
      else { current.current = undefined; setActive(undefined); }
    } catch { /* Keep the last known state until the next event or page open. */ }
  }, [accept]);
  useEffect(() => {
    alive.current = true;
    void reload();
    const off = onMemoryEvent((event) => {
      if (event.type === "memory.operation") {
        setLeaseBusy(false);
        if (event.payload.kind !== "consolidation") return;
        ++request.current;
        accept(event.payload as unknown as ConsolidationReceipt);
        void reload();
      }
      if (event.type === "stream.reconcile_required") { setLeaseBusy(false); void reload(); }
    });
    return () => { alive.current = false; ++request.current; off(); };
  }, [accept, reload]);
  const start = async () => {
    if (pending.current || current.current || leaseBusy) return;
    pending.current = true;
    setStarting(true);
    const id = crypto.randomUUID();
    owned.current.add(id);
    try {
      const next = await api<ConsolidationReceipt>("/memory/consolidation", { method: "POST", body: JSON.stringify({ operation_id: id }) });
      if (next.operation_id !== id) owned.current.delete(id);
      accept(next);
      void reload();
    } catch (error) {
      owned.current.delete(id);
      if ((error as { status?: number }).status === 409) setLeaseBusy(true);
      else notifyStatus(appCopy.settings.memory.consolidationFailed, { id: "memory-consolidation", tone: "error" });
    } finally { pending.current = false; if (alive.current) setStarting(false); }
  };
  return { status, running: starting || active?.phase === "running", leaseBusy, start };
}
