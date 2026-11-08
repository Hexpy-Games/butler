import { useProjectDashboardState } from "@/app/projectDashboardState.ts";
import { appCopy } from "@/app/copy.ts";
import { linkCanonConversation, type EpicCard } from "@/app/canonApi.ts";
import { sessionFromNavigation } from "@/app/utils.ts";
import { useButlerStore } from "@/app/store.ts";
import { notifyError } from "@/app/notifications.ts";

export function openPlanOverview(projectId: string, planId: string | null) {
  const app = useButlerStore.getState();
  app.openProjectDashboard(projectId);
  app.setView({ kind: "plan-overview", projectId, planId });
}
/** Link failure leaves the already-created Epic in place and keeps this screen. */
export async function openEpicConversation(_projectId: string, epic: EpicCard): Promise<void> {
  try {
    const id = epic.home_session_id ?? (await linkCanonConversation(epic.id)).session_id;
    const app = useButlerStore.getState();
    if (!sessionFromNavigation(app.navigation, id)) await app.refreshNavigation();
    app.openSession(id);
  } catch (error) { notifyError(error, appCopy.canon.conversationFailed); }
}

/** Open an epic in the board's existing detail panel. */
export function openCanonEpic(projectId: string, epicId?: string) {
  const app = useButlerStore.getState();
  useProjectDashboardState.getState().update(projectId, { tab: "work" });
  app.openProjectDashboard(projectId);
  app.setView({ kind: "project-dashboard", projectId, epicId });
}
