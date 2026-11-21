import { useCallback, useEffect, useRef, useState } from "react";
import { getAppCopy, type AppCopy } from "../../../../butler-i18n/src/index.ts";
import { GatewayError } from "../../../../butler-protocol/src/client/index.ts";
import { useConversation } from "@/conversation/live";
import { showToast } from "@/ds";
import { useAppLocale } from "@/i18n";
import { formatFileSize, uuid } from "../format";
import type { ConsolidationReceipt, MemoryReceipt } from "../types";
import type { useMemoryData } from "./useMemoryData";

export type ResetKind = "automatic" | "profile" | "project_memory";
const running = (receipt?: MemoryReceipt | ConsolidationReceipt) => receipt && ["preparing", "removing", "running"].includes(receipt.phase);

function announceReceipt(next: MemoryReceipt | ConsolidationReceipt, copy: AppCopy["settings"]["memory"]) {
  const success = next.phase === "complete";
  let message: string;
  if (next.kind === "consolidation") message = success ? copy.consolidationDone : copy.consolidationFailed;
  else if (next.kind && ["automatic", "profile", "project_memory"].includes(next.kind)) {
    message = !success ? copy.resetFailed : next.kind === "profile" ? copy.resetProfileDone : next.kind === "project_memory" ? copy.resetProjectDone : copy.resetChatDone;
  } else {
    const bytes = formatFileSize("bytes_reclaimed" in next ? next.bytes_reclaimed : 0);
    message = success ? copy.freed(bytes) : next.phase === "failed" ? copy.freeStopped(bytes) : copy.freeCancelled(bytes);
  }
  showToast({ message, tone: success ? "success" : next.phase === "cancelled" ? "neutral" : "error" });
}

export function useMemoryOps(data: ReturnType<typeof useMemoryData>) {
  const { client, subscribe, reconcile } = useConversation();
  const copy = getAppCopy(useAppLocale()).settings.memory;
  const [cleanup, setCleanup] = useState<MemoryReceipt>();
  const [reset, setReset] = useState<MemoryReceipt>();
  const [active, setActive] = useState<ConsolidationReceipt>();
  const [starting, setStarting] = useState<string>();
  const [leaseBusy, setLeaseBusy] = useState(false);
  const pending = useRef(false), seen = useRef(new Map<string, number>()), owned = useRef(new Set<string>());
  const accept = useCallback((next: MemoryReceipt | ConsolidationReceipt, announce = true) => {
    if ((seen.current.get(next.operation_id) ?? -1) >= next.sequence) return;
    seen.current.set(next.operation_id, next.sequence);
    if (next.kind === "consolidation" && "trigger" in next) setActive(next);
    else if ("bytes_reclaimed" in next) {
      if (next.kind && ["automatic", "profile", "project_memory"].includes(next.kind)) setReset(next);
      else setCleanup(next);
    }
    if (!running(next)) {
      const notify = next.kind !== "consolidation" || owned.current.delete(next.operation_id);
      if (announce && notify) announceReceipt(next, copy);
    }
  }, [copy]);
  useEffect(() => { if (data.inventory?.operation) accept(data.inventory.operation, false); }, [data.inventory?.operation, accept]);
  useEffect(() => { if (data.status?.active) accept(data.status.active, false); else setActive(undefined); }, [data.status, accept]);
  useEffect(() => { setLeaseBusy(false); }, [reconcile]);
  useEffect(() => subscribe(event => {
    if (event.type !== "memory.operation") return;
    setLeaseBusy(false);
    const p = event.payload;
    if (!p || typeof p.operation_id !== "string" || typeof p.sequence !== "number") return;
    if (p.kind === "consolidation" && (p.phase === "running" || p.phase === "complete" || p.phase === "failed") && (p.trigger === "manual" || p.trigger === "scheduled")) {
      accept({ kind: p.kind, operation_id: p.operation_id, sequence: p.sequence, phase: p.phase, trigger: p.trigger });
    } else if ((p.phase === "preparing" || p.phase === "removing" || p.phase === "complete" || p.phase === "failed" || p.phase === "cancelled") && typeof p.bytes_reclaimed === "number") {
      accept({ operation_id: p.operation_id, sequence: p.sequence, phase: p.phase, bytes_reclaimed: p.bytes_reclaimed,
        ...(typeof p.kind === "string" ? { kind: p.kind } : {}), ...(typeof p.project_id === "string" ? { project_id: p.project_id } : {}) });
    }
  }), [subscribe, accept]);
  const start = async (kind: "cleanup" | "consolidation" | ResetKind) => {
    if (!client || pending.current || running(cleanup) || running(reset) || running(active) || (kind === "consolidation" && leaseBusy)) return;
    pending.current = true; setStarting(kind);
    const id = uuid();
    if (kind === "consolidation") owned.current.add(id);
    const route = kind === "automatic" ? "chat-memory" : kind === "project_memory" ? `projects/${encodeURIComponent(data.selected)}` : kind;
    try {
      const next = await client.request<MemoryReceipt | ConsolidationReceipt>(`/memory/${kind === "cleanup" || kind === "consolidation" ? kind : `reset/${route}`}`,
        { method: "POST", body: { operation_id: id, ...(kind !== "consolidation" ? { inventory_revision: data.inventory?.revision ?? 0 } : {}) } });
      if (next.operation_id !== id) owned.current.delete(id);
      accept(next);
    } catch (error) {
      owned.current.delete(id);
      if (kind === "consolidation" && error instanceof GatewayError && error.status === 409) setLeaseBusy(true);
      else showToast({ message: kind === "consolidation" ? copy.consolidationFailed : kind === "cleanup" ? copy.freeStopped(formatFileSize(0)) : copy.resetFailed, tone: "error" });
      void data.reload();
    } finally { pending.current = false; setStarting(undefined); }
  };
  const cancel = async () => {
    if (!client || !cleanup) return;
    try { await client.request(`/memory/cleanup/${cleanup.operation_id}`, { method: "DELETE" }); }
    catch { showToast({ message: copy.freeStopped(formatFileSize(cleanup.bytes_reclaimed)), tone: "error" }); }
  };
  const busy = starting === "cleanup" || Boolean(running(cleanup));
  const resetKind = starting && ["automatic", "profile", "project_memory"].includes(starting) ? starting : running(reset) ? reset?.kind : undefined;
  const consolidating = starting === "consolidation" || Boolean(running(active));
  return { receipt: running(cleanup) ? cleanup : undefined, busy, resetKind, consolidating, leaseBusy, sharedBusy: busy || Boolean(resetKind) || consolidating, start, cancel };
}
