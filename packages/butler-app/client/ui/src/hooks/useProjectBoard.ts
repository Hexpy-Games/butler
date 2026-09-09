import { useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import { rememberDashboardLoadedCount, useProjectDashboardState } from "@/app/projectDashboardState.ts";
import type { DashboardBoardCard, DashboardBoardPage } from "../../../../../butler-agent/src/gateways/app/interface/protocol/session-dashboard-contract.ts";

export function useProjectBoard(projectId: string, kind: DashboardBoardCard["kind"], parent?: string, sourceRevision?: string, lane?: DashboardBoardCard["lane"]) {
  const [page, setPage] = useState<DashboardBoardPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [cursor, setCursor] = useState<string | undefined>();
  const key = `${projectId}\0${kind}\0${parent ?? ""}\0${sourceRevision ?? ""}\0${lane ?? ""}`;
  const windowKey = `board:${kind}:${parent ?? ""}${lane ? `:${lane}` : ""}`;
  const [loadedKey, setLoadedKey] = useState(key);
  useEffect(() => { setPage(null); setCursor(undefined); setLoadedKey(key); }, [key]);
  useEffect(() => {
    if (key !== loadedKey) return;
    let cancelled = false;
    setLoading(true); setError(false);
    const query = new URLSearchParams({ kind, limit: lane ? "10" : "50", ...(lane ? { lane } : {}), ...(parent ? { parent } : {}), ...(cursor ? { cursor } : {}) });
    const request = async () => {
      let next = await api<DashboardBoardPage>(`/projects/${encodeURIComponent(projectId)}/dashboard/records?${query}`);
      const wanted = lane ? 10 : useProjectDashboardState.getState().projects[projectId]?.loadedCounts?.[windowKey] ?? 50;
      while (!cursor && !cancelled && next.status === "ready" && next.nextCursor && next.items.length < wanted) {
        query.set("cursor", next.nextCursor);
        const more = await api<DashboardBoardPage>(`/projects/${encodeURIComponent(projectId)}/dashboard/records?${query}`);
        next = more.status === "ready" ? { ...more, items: [...next.items, ...more.items] } : more;
      }
      return next;
    };
    request()
      .then((next) => { if (!cancelled) setPage((previous) => cursor && previous?.status === "ready" && next.status === "ready"
        ? { ...next, items: [...previous.items, ...next.items] } : next); })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, kind, parent, cursor, key, loadedKey, revision]);
  useEffect(() => {
    if (key === loadedKey && page?.status === "ready") rememberDashboardLoadedCount(projectId, windowKey, page.items.length);
  }, [page, key, loadedKey, projectId, windowKey]);
  return { page: loadedKey === key ? page : null, loading, error,
    retry: () => { setCursor(undefined); setPage(null); setRevision((value) => value + 1); },
    loadMore: () => { if (!loading && page?.status === "ready" && page.nextCursor) setCursor(page.nextCursor); } };
}
