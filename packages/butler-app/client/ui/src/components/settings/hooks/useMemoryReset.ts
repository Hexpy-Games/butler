import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { confirmAction } from "@/app/confirmation.ts";
import { onMemoryEvent } from "@/app/memoryEvents.ts";
import { notifyStatus } from "@/app/notifications.ts";
import type { MemoryCard, MemoryReceipt, ProjectMemory } from "../memoryTypes";
export type ResetKind = "automatic" | "profile" | "project_memory";
const running = (receipt?: MemoryReceipt) => receipt?.phase === "preparing" || receipt?.phase === "removing";
export function useMemoryReset(initial: MemoryReceipt | undefined, refresh: () => Promise<void>) {
  const [receipt, setReceipt] = useState<MemoryReceipt>();
  const [starting, setStarting] = useState<ResetKind>();
  const current = useRef<MemoryReceipt | undefined>(undefined);
  const seen = useRef(new Map<string, number>());
  const pending = useRef(false);
  const accept = useCallback((next: MemoryReceipt, announce = true) => {
    if (!next.kind || !["automatic", "profile", "project_memory"].includes(next.kind)) return;
    if ((seen.current.get(next.operation_id) ?? -1) >= next.sequence) return;
    seen.current.set(next.operation_id, next.sequence);
    current.current = next;
    setReceipt(next);
    if (!running(next) && announce) {
      const copy = appCopy.settings.memory;
      const done = next.kind === "profile" ? copy.resetProfileDone : next.kind === "project_memory" ? copy.resetProjectDone : copy.resetChatDone;
      notifyStatus(next.phase === "complete" ? done : copy.resetFailed, { id: "memory-reset", tone: next.phase === "complete" ? "ok" : "error" });
      void refresh();
    }
  }, [refresh]);
  useEffect(() => { if (initial) accept(initial, false); }, [initial, accept]);
  useEffect(() => onMemoryEvent((event) => {
    if (event.type === "memory.operation") accept(event.payload as unknown as MemoryReceipt);
    if (event.type === "stream.reconcile_required" && running(current.current)) {
      void api<MemoryReceipt>(`/memory/reset/${current.current!.operation_id}`).then((next) => accept(next)).catch(() => {});
    }
  }), [accept]);
  const start = async (kind: ResetKind, revision: number, card?: MemoryCard, project?: ProjectMemory, name?: string, projectId?: string) => {
    if (pending.current || running(current.current)) return;
    pending.current = true;
    const copy = appCopy.settings.memory;
    const isProject = kind === "project_memory";
    const title = isProject ? copy.resetProjectTitle : kind === "profile" ? copy.resetProfileTitle : copy.resetChatTitle;
    const body = isProject ? copy.resetProjectBody : kind === "profile" ? copy.resetProfileBody : copy.resetBody;
    const removed = isProject ? copy.removedProject(project?.conversations ?? 0, project?.instructions ?? 0)
      : kind === "profile" ? copy.removedProfile(card?.item_count ?? 0, card?.pending_count ?? 0) : copy.removedChat(card?.item_count ?? 0);
    const kept = isProject ? copy.keptProject : kind === "profile" ? copy.keptProfile : copy.keptChat;
    try {
      const accepted = await confirmAction(body, { title, confirmLabel: copy.reset, destructive: true, note: copy.resetNote,
        details: [...(isProject ? [{ label: copy.project, text: name ?? copy.project }] : []), { label: copy.removed, text: removed }, { label: copy.kept, text: kept }] });
      if (!accepted) return;
      setStarting(kind);
      const route = isProject ? `projects/${encodeURIComponent(projectId ?? project!.project_id)}` : kind === "profile" ? "profile" : "chat-memory";
      accept(await api<MemoryReceipt>(`/memory/reset/${route}`, { method: "POST", body: JSON.stringify({ operation_id: crypto.randomUUID(), inventory_revision: revision }) }));
    } catch { notifyStatus(copy.resetFailed, { id: "memory-reset", tone: "error" }); void refresh(); }
    finally { setStarting(undefined); pending.current = false; }
  };
  return { kind: starting ?? (running(receipt) ? receipt?.kind as ResetKind : undefined), start };
}
