import { useCallback, useEffect, useRef, useState } from "react";
import { GatewayError } from "../../../../butler-protocol/src/client/index.ts";
import { useConversation } from "@/conversation/live";
import type { ConsolidationStatus, InstructionsView, MemoryInventory, PatternsView } from "../types";

export function useMemoryData() {
  const { client, reconcile, subscribe } = useConversation();
  const [inventory, setInventory] = useState<MemoryInventory>();
  const [instructions, setInstructions] = useState<InstructionsView>();
  const [patterns, setPatterns] = useState<PatternsView>();
  const [status, setStatus] = useState<ConsolidationStatus>();
  const [errors, setErrors] = useState<Record<string, boolean>>({});
  const [unavailable, setUnavailable] = useState(false);
  const versions = useRef(new Map<string, number>());
  const read = useCallback(async <T,>(key: string, path: string, receive: (value: T) => void, measure = false) => {
    if (!client) return;
    const version = (versions.current.get(key) ?? 0) + 1;
    versions.current.set(key, version);
    try {
      const next = await client.request<T>(path, measure ? { method: "POST", body: {} } : undefined);
      if (versions.current.get(key) !== version) return;
      receive(next);
      setErrors(old => ({ ...old, [key]: false }));
      if (key === "instructions") setUnavailable(false);
    } catch (error) {
      if (versions.current.get(key) !== version) return;
      const missing = key === "instructions" && error instanceof GatewayError && error.status === 404;
      setErrors(old => ({ ...old, [key]: !missing }));
      if (missing) { setUnavailable(true); setInstructions({ instructions: [] }); }
    }
  }, [client]);
  const reloadInventory = useCallback(() => read("inventory", "/memory/inventory/check", setInventory, true), [read]);
  const reload = useCallback(async () => {
    await Promise.all([reloadInventory(),
      read("instructions", "/memory/instructions", setInstructions), read("patterns", "/memory/patterns", setPatterns),
      read("status", "/memory/consolidation", setStatus)]);
  }, [read, reloadInventory]);
  useEffect(() => { void reload(); }, [reload, reconcile]);
  useEffect(() => subscribe(event => {
    if (event.type === "memory.operation" && (!event.payload?.operation_id || ["complete", "failed", "cancelled"].includes(String(event.payload.phase)))) void reload();
    if (event.type === "personalization.updated") void reloadInventory();
  }), [subscribe, reload, reloadInventory]);
  useEffect(() => () => { versions.current.forEach((v, k) => versions.current.set(k, v + 1)); }, [client]);
  return { inventory, instructions, patterns, status, errors, unavailable, reload };
}
