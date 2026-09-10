import { useEffect, useRef, useState } from "react";
import { api } from "@/app/api.ts";
import type { DashboardStatisticsView } from "../../../../../butler-agent/src/gateways/app/interface/protocol/session-dashboard-contract.ts";

const STATISTICS_WAIT_MS = 20_000;
type Result = { key: string; data?: DashboardStatisticsView; loading: boolean; error: boolean };

/** Query scope owns results; live revisions request refresh, not cancellation. */
export function useProjectStatistics(projectId: string, period: 7 | 30 | 90, timezone: string, revision?: string) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const refresh = useRef<() => void>(() => {});
  const key = `${projectId}:${period}:${timezone}`;
  useEffect(() => {
    let disposed = false;
    let pending = false;
    let dirty = false;
    let failed = false;
    let cancelWait: (() => void) | undefined;
    const load = () => {
      if (disposed) return;
      if (pending) { dirty = true; return; }
      pending = true;
      dirty = false;
      setResult((current) => ({ key, data: current?.key === key ? current.data : undefined, loading: true, error: false }));
      let settled = false;
      const finish = (data?: DashboardStatisticsView) => {
        if (disposed || settled) return;
        settled = true;
        clearTimeout(timer);
        pending = false;
        failed = !data;
        setResult((current) => ({ key, data: data ?? (current?.key === key ? current.data : undefined), loading: false, error: !data }));
        if (data && dirty) load();
      };
      const timer = setTimeout(() => finish(), STATISTICS_WAIT_MS);
      cancelWait = () => { settled = true; clearTimeout(timer); };
      api<DashboardStatisticsView>(`/projects/${encodeURIComponent(projectId)}/dashboard/statistics?days=${period}&timezone=${encodeURIComponent(timezone)}`)
        .then((data) => {
          if (!data.activity?.buckets || !data.materialTypes?.buckets || !data.execution?.outcomes || !data.sources || typeof data.sessionHistoryAvailable !== "boolean") {
            finish();
          } else finish(data);
        }).catch(() => finish());
    };
    refresh.current = () => { if (!failed) load(); };
    load();
    return () => { disposed = true; cancelWait?.(); };
  }, [key, projectId, period, timezone, attempt]);
  const previousRevision = useRef(revision);
  useEffect(() => {
    if (previousRevision.current !== revision) refresh.current();
    previousRevision.current = revision;
  }, [revision]);
  return {
    data: result?.key === key ? result.data : undefined,
    error: result?.key === key && result.error,
    loading: result?.key !== key || result.loading,
    retry: () => setAttempt((value) => value + 1),
  };
}
