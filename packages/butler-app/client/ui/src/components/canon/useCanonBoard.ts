import { readCanonProgress } from "./canonProgressSource.ts";
import { useCanonSidebarState } from "@/app/canonSidebarState.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCanon, getCanonEpic, editCanonEpic, type CanonOverview, type EpicDetail, type EpicInput, type EpicProgressSnapshot } from "@/app/canonApi.ts";
import { singleFlight, subscribeCanonChanges } from "@/app/canonEvents.ts";
import { notifyStatus } from "@/app/notifications.ts";
import { useCanonMove } from "./useCanonMove.ts";
import { canonWriteFailure } from "./canonFeedback.ts";

/** A mounted project owns its reads; event bursts coalesce and stale reads never win. */
export function useCanonBoard(projectId: string) {
  const [canon, setCanon] = useState<CanonOverview | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<EpicDetail | null>(null);
  const [tasks, setTasks] = useState<EpicProgressSnapshot | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const selectedRef = useRef(selected);
  const mounted = useRef(true);
  selectedRef.current = selected;
  const movingRef = useRef(false);
  const read = useCallback(async () => {
    if (movingRef.current) return;
    const epoch = ++generation.current;
    const id = selectedRef.current;
    try {
      const [board, epic, queue] = await Promise.all([getCanon(projectId), id ? getCanonEpic(id) : null, id ? readCanonProgress(id) : null]);
      if (!mounted.current || epoch !== generation.current) return;
      useCanonSidebarState.getState().rememberCanon(board);
      setCanon(board); setDetail(epic); setTasks(queue); setError(null);
    } catch (error) { if (mounted.current && epoch === generation.current) setError(error); }
  }, [projectId]);
  const refresh = useMemo(() => singleFlight(read), [read]);
  const drag = useCanonMove(canon, setCanon, refresh, () => { generation.current++; }, movingRef);
  useEffect(() => {
    mounted.current = true;
    let queued = false;
    const unsubscribe = subscribeCanonChanges(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => { queued = false; if (mounted.current) void refresh(); });
    }, { projectId });
    return () => { mounted.current = false; generation.current++; unsubscribe(); };
  }, [projectId, refresh]);
  useEffect(() => { void refresh(); }, [refresh, selected]);
  const select = (id: string | null) => {
    if (id === selectedRef.current) return;
    generation.current++;
    selectedRef.current = id;
    setSelected(id); setDetail(null); setTasks(null);
  };
  const write = async (input: EpicInput, message?: string): Promise<boolean> => {
    if (!detail || busy) return false;
    setBusy(true);
    try {
      await editCanonEpic(detail.id, { ...input, expected_revision: input.expected_revision ?? detail.revision });
      if (message) notifyStatus(message);
      await refresh();
      return true;
    } catch (error) { await canonWriteFailure(error, refresh); return false; }
    finally { if (mounted.current) setBusy(false); }
  };
  return { canon, selected, detail, tasks, error, busy, refresh, select, write, move: drag.move, moving: drag.moving };
}
