import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCanonSidebar, orderCanonSidebar, editCanonEpic, type EpicCard } from "@/app/canonApi.ts";
import { singleFlight, subscribeCanonChanges } from "@/app/canonEvents.ts";
import { useCanonSidebarState } from "@/app/canonSidebarState.ts";
import { appCopy } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import { canonWriteFailure } from "./canonFeedback.ts";

export function useCanonSidebar(projectId: string, expanded: boolean) {
  const sidebar = useCanonSidebarState(state => state.projects[projectId]);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0), writing = useRef(false), mounted = useRef(true);
  const read = useCallback(async () => {
    if (writing.current || !mounted.current) return;
    const generation = ++epoch.current;
    try {
      const data = await getCanonSidebar(projectId);
      if (generation !== epoch.current) return;
      useCanonSidebarState.getState().rememberSidebar(data);
    } catch (error) { if (generation === epoch.current) notifyError(error, appCopy.interfaceFeedback.requestFailed); }
  }, [projectId]);
  const refresh = useMemo(() => singleFlight(read), [read]);
  useEffect(() => {
    mounted.current = expanded;
    if (!expanded) return () => { mounted.current = false; epoch.current++; };
    void refresh();
    let queued = false;
    const unsubscribe = subscribeCanonChanges(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => { queued = false; void refresh(); });
    }, { projectId, sidebar: true });
    return () => { mounted.current = false; epoch.current++; unsubscribe(); };
  }, [projectId, refresh, expanded]);
  const reorder = async (groupKey: string, ids: string[]) => {
    if (!sidebar || writing.current) return;
    epoch.current++; writing.current = true; setBusy(true);
    const group = sidebar.groups.find(group => group.key === groupKey)!;
    const rows = new Map(group.rows.map(row => [row.id, row]));
    useCanonSidebarState.getState().rememberSidebar({ ...sidebar, groups: sidebar.groups.map(group =>
      group.key === groupKey ? { ...group, rows: ids.map(id => rows.get(id)!) } : group) });
    try {
      useCanonSidebarState.getState().rememberSidebar(await orderCanonSidebar(projectId, { group_key: groupKey, work_ids: ids }));
      notifyStatus(appCopy.canon.personalOrder);
    } catch (error) {
      useCanonSidebarState.getState().rememberSidebar(sidebar);
      await canonWriteFailure(error, async () => {});
    } finally { writing.current = false; setBusy(false); await refresh(); }
  };
  const move = async (epic: EpicCard, groupKey: string, title: string) => {
    if (writing.current) return;
    epoch.current++; writing.current = true; setBusy(true);
    try {
      await editCanonEpic(epic.id, { expected_revision: epic.revision, plan_id: groupKey === "backlog" ? null : groupKey });
      notifyStatus(appCopy.canon.moved(title));
    } catch (error) { await canonWriteFailure(error, async () => {}); }
    finally { writing.current = false; setBusy(false); await refresh(); }
  };
  return { sidebar, refresh, reorder, move, busy };
}
