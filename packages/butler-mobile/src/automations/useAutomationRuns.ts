import { useCallback, useEffect, useRef, useState } from "react";
import type { AutomationRunPage, AutomationRunSummary } from "../../../butler-protocol/src/index.ts";
import { useConversation } from "@/conversation/live";

export function useAutomationRuns(id: string) {
  const { client } = useConversation();
  const [runs, setRuns] = useState<AutomationRunSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const next = useRef<string | undefined>(undefined), latest = useRef(0), pending = useRef(false);
  const load = useCallback(async (cursor?: string) => {
    const request = ++latest.current;
    pending.current = true;
    setFailed(false);
    if (!cursor) {
      next.current = undefined;
      setRuns(null);
    }
    try {
      const path = `/automations/${encodeURIComponent(id)}/runs?limit=30`;
      const page = await client!.request<AutomationRunPage>(cursor ? `${path}&cursor=${encodeURIComponent(cursor)}` : path);
      if (request !== latest.current) return;
      next.current = page.next_cursor;
      setRuns(old => cursor ? [...(old ?? []), ...page.runs] : page.runs);
    } catch {
      if (request === latest.current) {
        next.current = undefined;
        setFailed(true);
      }
    } finally { if (request === latest.current) pending.current = false; }
  }, [client, id]);
  const reload = useCallback(() => load(), [load]);
  useEffect(() => {
    void reload();
    return () => { latest.current++; };
  }, [reload]);
  const more = () => next.current && !pending.current ? load(next.current) : undefined;
  return { runs, failed, reload, more, hasMore: next.current !== undefined };
}
