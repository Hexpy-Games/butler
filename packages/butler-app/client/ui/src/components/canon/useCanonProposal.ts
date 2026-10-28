import { useCallback, useEffect, useRef, useState } from "react";
import { getCanonProposal, observeCanonProposal, type CanonProposal } from "@/app/canonProposals.ts";
export function useCanonProposal(id: string) {
  const [proposal, setProposal] = useState<CanonProposal | null>(null);
  const latest = useRef(0);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const request = ++latest.current;
    const value = await getCanonProposal(id, signal);
    if (!signal?.aborted && request === latest.current) setProposal(value);
  }, [id]);
  useEffect(() => {
    const controller = new AbortController();
    const read = () => { void refresh(controller.signal).catch(() => {}); };
    const stop = observeCanonProposal(id, read);
    read();
    return () => { controller.abort(); stop(); };
  }, [id, refresh]);
  return { proposal: proposal?.proposal_id === id ? proposal : null, refresh };
}
