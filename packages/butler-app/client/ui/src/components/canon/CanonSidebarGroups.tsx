import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { getCanon, getCanonPlan, type CanonPlan } from "@/app/canonApi.ts";
import { notifyError } from "@/app/notifications.ts";
import { CanonSidebarGroup } from "./CanonSidebarGroup.tsx";
import { useCanonSidebar } from "./useCanonSidebar.ts";
import { EpicCreateDialog } from "./EpicCreateDialog.tsx";
import { PlanFormDialog } from "./PlanFormDialog.tsx";
import { openEpicConversation } from "./canonNavigation.ts";

type Dialog = { kind: "create"; planId: string | null; plans: CanonPlan[] } | { kind: "edit"; plan: CanonPlan };
/** Mounted inside the project collapse motion. Empty groups retain their creation action. */
export function CanonSidebarGroups({ projectId, depth, expanded }: { projectId: string; depth: number; expanded: boolean }) {
  useAppLocale();
  const state = useCanonSidebar(projectId, expanded);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const create = async (planId: string | null) => {
    try { setDialog({ kind: "create", planId, plans: (await getCanon(projectId)).plans }); }
    catch (error) { notifyError(error, appCopy.interfaceFeedback.requestFailed); }
  };
  const edit = async (planId: string) => {
    try { setDialog({ kind: "edit", plan: await getCanonPlan(planId) }); }
    catch (error) { notifyError(error, appCopy.interfaceFeedback.requestFailed); }
  };
  return <>
    {state.sidebar?.groups.map(group => <CanonSidebarGroup key={group.key} projectId={projectId} group={group} depth={depth} busy={state.busy}
      onCreate={() => void create(group.kind === "backlog" ? null : group.key)} onEdit={() => void edit(group.key)}
      onReorder={ids => void state.reorder(group.key, ids)} onMove={epic => void state.move(epic, group.key, group.kind === "backlog" ? appCopy.canon.backlog : group.title)} />)}
    {dialog?.kind === "create" && <EpicCreateDialog projectId={projectId} plans={dialog.plans} defaultPlanId={dialog.planId}
      onClose={() => setDialog(null)} onRefresh={state.refresh} onCreated={epic => void openEpicConversation(projectId, epic)} />}
    {dialog?.kind === "edit" && <PlanFormDialog projectId={projectId} plan={dialog.plan} onClose={() => setDialog(null)} onRefresh={state.refresh} />}
  </>;
}
