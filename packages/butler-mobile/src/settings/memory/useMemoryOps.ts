import { useCallback, useEffect, useRef, useState } from "react";
import { getAppCopy, type AppCopy } from "../../../../butler-i18n/src/index.ts";
import { useConversation } from "@/conversation/live";
import { showToast } from "@/ds";
import { useAppLocale } from "@/i18n";
import { uuid } from "../format";
import type { ConsolidationReceipt, MemoryReceipt } from "../types";
import type { useMemoryData } from "./useMemoryData";

export type ResetKind = "automatic" | "profile";
// A receipt can also report a project reset started on the computer.
const RESET_KINDS: string[] = ["automatic", "profile", "project_memory"];
const running = (receipt?: MemoryReceipt | ConsolidationReceipt) => receipt && ["preparing", "removing", "running"].includes(receipt.phase);

function announceReset(next: MemoryReceipt, copy: AppCopy["settings"]["memory"]) {
  const success = next.phase === "complete";
  showToast({ message: !success ? copy.resetFailed : next.kind === "profile" ? copy.resetProfileDone : copy.resetChatDone,
    tone: success ? "success" : next.phase === "cancelled" ? "neutral" : "error" });
}

/** Starts memory resets and tracks every memory operation, so a reset waits for cleanup, consolidation or another reset. */
export function useMemoryOps(data: ReturnType<typeof useMemoryData>) {
  const { client, subscribe } = useConversation();
  const copy = getAppCopy(useAppLocale()).settings.memory;
  const [cleanup, setCleanup] = useState<MemoryReceipt>();
  const [reset, setReset] = useState<MemoryReceipt>();
  const [active, setActive] = useState<ConsolidationReceipt>();
  const [starting, setStarting] = useState<ResetKind>();
  const pending = useRef(false), seen = useRef(new Map<string, number>()), owned = useRef(new Set<string>());
  const accept = useCallback((next: MemoryReceipt | ConsolidationReceipt) => {
    if ((seen.current.get(next.operation_id) ?? -1) >= next.sequence) return;
    seen.current.set(next.operation_id, next.sequence);
    if ("trigger" in next) { setActive(next); return; }
    if (next.kind && RESET_KINDS.includes(next.kind)) setReset(next); else setCleanup(next);
    if (!running(next) && owned.current.delete(next.operation_id)) announceReset(next, copy);
  }, [copy]);
  useEffect(() => { if (data.inventory?.operation) accept(data.inventory.operation); }, [data.inventory?.operation, accept]);
  useEffect(() => { if (data.status?.active) accept(data.status.active); else setActive(undefined); }, [data.status, accept]);
  useEffect(() => subscribe(event => {
    if (event.type !== "memory.operation") return;
    const p = event.payload;
    if (!p || typeof p.operation_id !== "string" || typeof p.sequence !== "number") return;
    if (p.kind === "consolidation" && (p.phase === "running" || p.phase === "complete" || p.phase === "failed") && (p.trigger === "manual" || p.trigger === "scheduled")) {
      accept({ kind: p.kind, operation_id: p.operation_id, sequence: p.sequence, phase: p.phase, trigger: p.trigger });
    } else if ((p.phase === "preparing" || p.phase === "removing" || p.phase === "complete" || p.phase === "failed" || p.phase === "cancelled") && typeof p.bytes_reclaimed === "number") {
      accept({ operation_id: p.operation_id, sequence: p.sequence, phase: p.phase, bytes_reclaimed: p.bytes_reclaimed,
        ...(typeof p.kind === "string" ? { kind: p.kind } : {}), ...(typeof p.project_id === "string" ? { project_id: p.project_id } : {}) });
    }
  }), [subscribe, accept]);
  const start = async (kind: ResetKind) => {
    if (!client || pending.current || running(cleanup) || running(reset) || running(active)) return;
    pending.current = true; setStarting(kind);
    const id = uuid();
    owned.current.add(id);
    try {
      const next = await client.request<MemoryReceipt>(`/memory/reset/${kind === "automatic" ? "chat-memory" : kind}`,
        { method: "POST", body: { operation_id: id, inventory_revision: data.inventory?.revision ?? 0 } });
      if (next.operation_id !== id) owned.current.delete(id);
      accept(next);
    } catch {
      owned.current.delete(id);
      showToast({ message: copy.resetFailed, tone: "error" });
      void data.reload();
    } finally { pending.current = false; setStarting(undefined); }
  };
  const resetKind = starting ?? (running(reset) ? reset?.kind : undefined);
  return { resetKind, sharedBusy: Boolean(running(cleanup)) || Boolean(resetKind) || Boolean(running(active)), start };
}
