import type { TimelineEvent, NavigationView } from "@/app/types.ts";
import { useProjectDashboardState } from "@/app/projectDashboardState.ts";
import { eventSessionId } from "./liveSessionReconciliation.ts";

/** Only committed/public changes invalidate facts; token/tool progress does not. */
export function invalidateProjectDashboard(event: TimelineEvent, projectId: string, navigation: NavigationView) {
  if (event.type === "stream.reconcile_required") { useProjectDashboardState.getState().invalidate(projectId); return; }
  const payload = event.payload as Record<string, unknown> | undefined;
  const project = payload?.project;
  const session = payload?.session;
  const direct = payload?.project_id ?? (project && typeof project === "object" && "id" in project ? project.id : undefined);
  if ((event.type === "project_dashboard_updated" || event.type === "project.updated") && direct === projectId) {
    useProjectDashboardState.getState().invalidate(projectId); return;
  }
  const isReport = (event.type === "message.created" || event.type === "message.updated") && event.payload?.message?.status === "delivered";
  const isTerminal = event.type === "turn.state_changed" && ["delivered", "cancelled", "failed"].includes(event.payload?.turn?.state ?? "");
  const isSession = event.type === "session.created" || event.type === "session.updated";
  if (!isReport && !isTerminal && !isSession) return;
  const id = eventSessionId(event);
  const known = navigation.projects.find((project) => project.id === projectId)?.sessions?.some((session) => session.id === id);
  if (known || (session && typeof session === "object" && "project_id" in session && session.project_id === projectId)) useProjectDashboardState.getState().invalidate(projectId);
}
