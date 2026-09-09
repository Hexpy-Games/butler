import { appCopy } from "@/app/copy.ts";
import { useRef, useState } from "react";
import { api } from "@/app/api";
import { useButlerStore } from "@/app/store";
import type { SessionSummary } from "@/app/types";
import type { SessionBranchRequest } from "../../../../../../../butler-agent/src/foundation/session-branch.ts";

export function useSessionBranch() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reservation = useRef<SessionBranchRequest | null>(null);
  async function create(input: Omit<SessionBranchRequest, "requestId">): Promise<boolean> {
    if (pending) return false;
    setPending(true);
    setError(null);
    const request = reservation.current ?? { ...input, requestId: crypto.randomUUID() };
    reservation.current = request;
    try {
      const result = await api<{ session: SessionSummary }>("/space/branches", {
        method: "POST", body: JSON.stringify(request),
      });
      await useButlerStore.getState().refreshNavigation();
      await useButlerStore.getState().openSession(result.session.id);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : appCopy.interfaceDetails.branchFailed);
      return false;
    } finally { setPending(false); }
  }
  return { create, pending, error, reserved: reservation.current !== null };
}
