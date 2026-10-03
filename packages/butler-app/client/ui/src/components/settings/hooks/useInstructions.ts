import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { confirmAction } from "@/app/confirmation.ts";
import { onMemoryEvent } from "@/app/memoryEvents.ts";
import { notifyStatus } from "@/app/notifications.ts";
import type { SettingsSectionState } from "@/butler-ds";
import type { Instruction } from "../memoryTypes";
export function instructionScope(item: Instruction) {
  if (item.scope.kind === "session") return appCopy.settings.memory.thisChat;
  return item.scope.kind === "all" ? appCopy.settings.memory.allChats : item.scope.project_name || appCopy.settings.memory.project;
}
export function instructionDuration(item: Instruction) {
  const copy = appCopy.settings.memory;
  if (item.duration === "this chat") return copy.thisChatOnly;
  if (!item.expires_at || item.duration === "always") return "";
  const hours = Math.max(1, Math.ceil((Date.parse(item.expires_at) - Date.now()) / 3_600_000));
  return hours <= 24 ? copy.expiresInHours(hours) : copy.expiresInDays(Math.ceil(hours / 24));
}
export function useInstructions(refreshSummary: () => Promise<void>) {
  const [rows, setRows] = useState<Instruction[]>([]);
  const [state, setState] = useState<SettingsSectionState>("loading");
  const [unavailable, setUnavailable] = useState(false);
  const [deleting, setDeleting] = useState<string>();
  const busy = useRef(false);
  const alive = useRef(false);
  const reload = useCallback(async (quiet = false) => {
    try {
      const result = await api<{ instructions: Instruction[] }>("/memory/instructions");
      if (alive.current) { setUnavailable(false); setRows(result.instructions); setState(result.instructions.length ? "ready" : "empty"); }
      return result.instructions;
    } catch (error) {
      if (alive.current && !quiet) { const missing = (error as { status?: number }).status === 404; setUnavailable(missing); setState(missing ? "empty" : "error"); }
      throw error;
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void reload().catch(() => {});
    const off = onMemoryEvent((event) => {
      if (!busy.current && (event.type !== "memory.operation" || event.payload.kind === "instructions")) void reload().catch(() => {});
    });
    return () => { alive.current = false; off(); };
  }, [reload]);
  const remove = async (item: Instruction) => {
    if (busy.current) return;
    busy.current = true;
    const copy = appCopy.settings.memory;
    const accepted = await confirmAction(copy.chatsKept, { title: copy.deleteInstructionTitle,
      confirmLabel: appCopy.common.delete, destructive: true,
      details: [{ text: item.text, caption: instructionScope(item) }] });
    if (!accepted) { busy.current = false; return; }
    setDeleting(item.handle);
    const index = rows.findIndex((row) => row.handle === item.handle);
    try {
      await api(`/memory/instructions/${item.handle}`, { method: "DELETE", body: JSON.stringify({ expected_revision: item.revision, project_id: item.project_id, operation_id: crypto.randomUUID() }) });
      notifyStatus(copy.instructionDeleted, { id: "instruction", tone: "ok" });
      const next = await reload(true);
      await refreshSummary();
      const target = next[Math.min(index, next.length - 1)];
      requestAnimationFrame(() => { if (target) document.getElementById(`instruction-delete-${target.handle}`)?.focus(); });
    } catch { notifyStatus(copy.deleteFailed, { id: "instruction", tone: "error" }); }
    finally { setDeleting(undefined); busy.current = false; }
  };
  return { rows, state, unavailable, deleting, reload: () => { void reload().catch(() => {}); }, remove };
}
