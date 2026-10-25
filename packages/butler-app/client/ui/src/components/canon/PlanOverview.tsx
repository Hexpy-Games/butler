import { useProjectDashboardBackground } from "@/hooks/useProjectDashboardBackground.tsx";
import { useButlerStore } from "@/app/store.ts";
import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Button, ButtonContainer, DashboardHeader, ManagementPage, Notice, IconButton, Pencil, Plus, ProgressMeter, Stack, Typo } from "@/butler-ds";
import { EpicCreateDialog } from "./EpicCreateDialog.tsx";
import { PlanFormDialog } from "./PlanFormDialog.tsx";
import { PlanEpicList } from "./PlanEpicList.tsx";
import { usePlanOverview } from "./usePlanOverview.ts";

export function PlanOverview({ projectId, planId }: { projectId: string; planId: string | null }) {
  const locale = useAppLocale();
  const state = usePlanOverview(projectId, planId);
  const project = useButlerStore(state => state.navigation.projects.find(project => project.id === projectId));
  const { background, onColumnRect } = useProjectDashboardBackground(project);
  const [dialog, setDialog] = useState<"create" | "edit" | null>(null);
  const copy = appCopy.canon;
  const title = state.plan?.title ?? copy.backlog;
  const done = state.rows.filter(epic => epic.canon_status === "done").length;
  const due = state.plan?.due_on;
  const meta = due ? copy.due(new Intl.DateTimeFormat(locale, { month: "long", day: "numeric" }).format(new Date(`${due}T00:00:00`))) : undefined;
  return <ManagementPage dataTestClass="canon-plan-overview" background={background} backgroundTreatment="none" onColumnRect={onColumnRect}><Stack gap="xl">
    <Stack gap="md">
      <Typo.Caption tone="secondary">{planId ? copy.plan : copy.noPlan}</Typo.Caption>
      <DashboardHeader title={title} meta={meta} action={<ButtonContainer size="default">
        {state.plan && <IconButton label={copy.editPlan} onClick={() => setDialog("edit")}><Pencil size="sm" /></IconButton>}
        <Button onClick={() => setDialog("create")} disabled={!state.canon || state.busy}><Plus size="sm" />{copy.newEpic}</Button>
      </ButtonContainer>} />
      {state.plan && <Stack gap="sm">
        {state.plan.description && <Typo.Body wrap="pre">{state.plan.description}</Typo.Body>}
        <ProgressMeter value={state.rows.length ? done / state.rows.length * 100 : 0} label={copy.progress} meta={copy.done(done, state.rows.length)} ariaLabel={copy.progress} />
      </Stack>}
    </Stack>
    <Stack gap="xl">
      {state.error ? <Notice tone="error" message={appCopy.interfaceFeedback.requestFailed} action={<Button onClick={() => void state.refresh()}>{appCopy.feedback.retry}</Button>} /> :
        !state.canon ? <ProgressMeter indeterminate label={appCopy.feedback.dashboardLoading} /> :
          planId && !state.plan ? <Notice tone="info" message={copy.planMissing} /> :
            <PlanEpicList projectId={projectId} rows={state.rows} plans={state.canon.plans} backlog={!planId} busy={state.busy}
              onWrite={(epic, input, message) => void state.write(epic, input, message)} onReorder={ids => void state.reorder(ids)} />}
    </Stack>
  </Stack>
    {dialog === "create" && state.canon && <EpicCreateDialog projectId={projectId} plans={state.canon.plans} defaultPlanId={planId}
      onClose={() => setDialog(null)} onRefresh={state.refresh} onCreated={() => void state.refresh()} />}
    {dialog === "edit" && state.plan && <PlanFormDialog projectId={projectId} plan={state.plan} onClose={() => setDialog(null)} onRefresh={state.refresh} />}
  </ManagementPage>;
}
