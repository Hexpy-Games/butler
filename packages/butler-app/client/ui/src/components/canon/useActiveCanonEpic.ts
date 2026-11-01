import { useEffect } from "react";
import { useButlerStore } from "@/app/store.ts";
import { sessionFromNavigation } from "@/app/utils.ts";
import { getCanon } from "@/app/canonApi.ts";
import { singleFlight, subscribeCanonChanges } from "@/app/canonEvents.ts";
import { useCanonSidebarState } from "@/app/canonSidebarState.ts";

const reads = new Map<string, Promise<void>>();
function readProject(projectId: string): Promise<void> {
  const existing = reads.get(projectId);
  if (existing) return existing;
  const read = getCanon(projectId).then(canon => {
    if (reads.get(projectId) === read) useCanonSidebarState.getState().rememberCanon(canon);
  });
  reads.set(projectId, read);
  void read.catch(() => { if (reads.get(projectId) === read) reads.delete(projectId); });
  return read;
}
const refreshes = new Map<string, () => Promise<void>>();
function refreshProject(projectId: string) {
  let refresh = refreshes.get(projectId);
  if (!refresh) {
    refresh = singleFlight(() => { reads.delete(projectId); return readProject(projectId).catch(() => {}); });
    refreshes.set(projectId, refresh);
  }
  void refresh();
}
/** Sidebar data wins immediately; a direct conversation entry reads canon once. */
export function useActiveCanonEpic() {
  const sessionId = useButlerStore(state => state.activeChatId);
  const projectId = useButlerStore(state => sessionFromNavigation(state.navigation, state.activeChatId)?.project_id);
  const match = useCanonSidebarState(state => state.sessions[sessionId]?.[0]);
  useEffect(() => {
    if (!projectId) return;
    if (!useCanonSidebarState.getState().sessions[sessionId]) void readProject(projectId).catch(() => {});
    return subscribeCanonChanges(() => {
      refreshProject(projectId);
    }, { projectId });
  }, [projectId, sessionId]);
  return match;
}
