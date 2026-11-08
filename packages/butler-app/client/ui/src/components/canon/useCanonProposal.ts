import { useCallback, useEffect, useRef, useState } from "react";
import { getCanonProposal, observeCanonProposal, type CanonProposal } from "@/app/canonProposals.ts";
/** Loads each anchored proposal and re-reads one when its pending ask changes. */
export function useCanonProposals(ids: readonly string[]) {
  const [loaded, setLoaded] = useState<ReadonlyMap<string, CanonProposal>>(() => new Map());
  const latest = useRef(new Map<string, number>());
  const key = ids.join("\n");
  const refresh = useCallback(async (id: string, signal?: AbortSignal) => {
    const request = (latest.current.get(id) ?? 0) + 1;
    latest.current.set(id, request);
    const value = await getCanonProposal(id, signal);
    if (!signal?.aborted && latest.current.get(id) === request) setLoaded(current => new Map(current).set(id, value));
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const stops = key.split("\n").filter(Boolean).map(id => {
      const read = () => { void refresh(id, controller.signal).catch(() => {}); };
      read();
      return observeCanonProposal(id, read);
    });
    return () => { controller.abort(); for (const stop of stops) stop(); };
  }, [key, refresh]);
  return { proposals: ids.flatMap(id => loaded.get(id) ?? []), refresh };
}
