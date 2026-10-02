import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { onMemoryEvent } from "@/app/memoryEvents.ts";
import { notifyStatus } from "@/app/notifications.ts";
import { formatFileSize } from "../../conversation/conversationUtils";
import type { MemoryReceipt } from "../memoryTypes";
const running = (receipt?: MemoryReceipt) => receipt?.phase === "preparing" || receipt?.phase === "removing";
export function useMemoryOperation(initial: MemoryReceipt | undefined, refresh: () => Promise<void>) {
  const [receipt, setReceipt] = useState<MemoryReceipt>();
  const [starting, setStarting] = useState(false);
  const seen = useRef(new Map<string, number>());
  const current = useRef<MemoryReceipt | undefined>(undefined);
  const accept = useCallback((next: MemoryReceipt, announce = true) => {
    if ((seen.current.get(next.operation_id) ?? -1) >= next.sequence) return;
    seen.current.set(next.operation_id, next.sequence);
    current.current = next;
    setReceipt(next);
    if (!running(next) && announce) {
      const copy = appCopy.settings.memory;
      const bytes = formatFileSize(next.bytes_reclaimed);
      const text = next.phase === "complete" ? copy.freed(bytes) : next.phase === "failed" ? copy.freeStopped(bytes) : copy.freeCancelled(bytes);
      notifyStatus(text, { id: "memory-space", tone: next.phase === "complete" ? "ok" : next.phase === "failed" ? "error" : undefined });
      void refresh();
    }
  }, [refresh]);
  useEffect(() => { if (initial) accept(initial, false); }, [initial, accept]);
  useEffect(() => onMemoryEvent((event) => {
    if (event.type === "memory.operation" && event.payload.operation_id) accept(event.payload as unknown as MemoryReceipt);
    if (event.type === "stream.reconcile_required" && current.current && running(current.current)) {
      void api<MemoryReceipt>(`/memory/cleanup/${current.current.operation_id}`).then((next) => accept(next)).catch(() => {});
    }
  }), [accept]);
  const start = async (revision: number) => {
    if (starting || running(current.current)) return;
    setStarting(true);
    try { accept(await api<MemoryReceipt>("/memory/cleanup", { method: "POST", body: JSON.stringify({ operation_id: crypto.randomUUID(), inventory_revision: revision }) })); }
    catch { notifyStatus(appCopy.settings.memory.freeStopped(formatFileSize(0)), { id: "memory-space", tone: "error" }); void refresh(); }
    finally { setStarting(false); }
  };
  const cancel = async () => {
    if (!current.current) return;
    try { await api(`/memory/cleanup/${current.current.operation_id}`, { method: "DELETE" }); }
    catch { notifyStatus(appCopy.settings.memory.freeStopped(formatFileSize(current.current.bytes_reclaimed)), { id: "memory-space", tone: "error" }); }
  };
  return { receipt: running(receipt) ? receipt : undefined, busy: starting || running(receipt), start, cancel };
}
