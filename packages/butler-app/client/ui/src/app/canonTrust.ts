import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { appCopy } from "./copy.ts";
import { notifyError } from "./notifications.ts";
import type { TimelineEvent } from "./types.ts";
export interface CanonGrant {
  id: string; client_title: string; person: string; requested_at: number;
  state: "pending" | "allowed" | "denied" | "revoked";
  requested: string[]; allowed: string[];
}
const listeners = new Set<() => void>();
export function publishCanonTrustEvent(event: TimelineEvent): void {
  if (event.type === "canon.trust_requested" || event.type === "canon.trust_changed" || event.type === "stream.reconcile_required") {
    for (const listener of listeners) listener();
  }
}
export function decideCanonGrant(id: string, action: "allow" | "deny" | "revoke") {
  return api(`/canon/mcp-grants/${encodeURIComponent(id)}/${action}`, { method: "POST", body: "{}" });
}
/** Mounted readers refresh only on startup or a trust event. */
export function useCanonGrants(pendingOnly = false) {
  const [grants, setGrants] = useState<CanonGrant[] | null>(null);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const epoch = ++generation.current;
    try {
      const result = await api<{ grants: CanonGrant[] }>(`/canon/mcp-grants${pendingOnly ? "?state=pending" : ""}`);
      if (generation.current !== epoch) return;
      setGrants(result.grants.filter(g => g.state !== "revoked").sort((a, b) => a.requested_at - b.requested_at || a.id.localeCompare(b.id)));
      setFailed(false);
    } catch (error) {
      if (generation.current !== epoch) return;
      setFailed(true); notifyError(error, appCopy.interfaceFeedback.requestFailed);
    }
  }, [pendingOnly]);
  useEffect(() => {
    void refresh();
    listeners.add(refresh);
    return () => { generation.current++; listeners.delete(refresh); };
  }, [refresh]);
  return { grants, failed, refresh };
}
