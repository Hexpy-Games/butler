import { useEffect, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { useCanonDetailSelection, type CanonDetailTarget } from "@/app/canonDetailLayout.ts";
import { Button, ButtonContainer, Grid, IconButton, InspectorPanel, ManagementPagePanel, Notice, Presence, ProgressMeter, Section, X } from "@/butler-ds";
import { useCanonBoard } from "./useCanonBoard.ts";
import { EpicDetail } from "./EpicDetail.tsx";

/**
 * SCRATCH PROTOTYPE (push layout): the 과제 detail as the dashboard's right
 * column, in page flow. Over a wallpaper it is a ManagementPagePanel (the same
 * TintedGlass as the header and tabs panels); on a plain page an InspectorPanel.
 */
export function CanonDetailAside({ projectId, glass }: { projectId: string; glass: boolean }) {
  const target = useCanonDetailSelection(state => state.target);
  const open = target?.via === "push" && target.projectId === projectId ? target : null;
  const [shown, setShown] = useState(open);
  useEffect(() => { if (open) setShown(open); }, [open?.epicId]);
  const current = open ?? shown;
  return <Presence present={Boolean(open)} motion="rise">
    <Grid columns="1" role="complementary" aria-label={appCopy.canon.epic} data-test-class="canon-detail-panel canon-detail-aside">
      {current && <AsideBody key={current.epicId} target={current} glass={glass} />}
    </Grid>
  </Presence>;
}

function AsideBody({ target, glass }: { target: CanonDetailTarget; glass: boolean }) {
  useAppLocale();
  const state = useCanonBoard(target.projectId);
  useEffect(() => { state.select(target.epicId); }, [target.epicId]);
  const close = <ButtonContainer size="sm">
    <IconButton label={appCopy.canon.close} onClick={() => useCanonDetailSelection.getState().open(null)}><X size="sm" /></IconButton>
  </ButtonContainer>;
  const body = state.error ? <Notice tone="error" message={appCopy.interfaceFeedback.requestFailed}
    action={<Button size="sm" onClick={() => void state.refresh()}>{appCopy.feedback.retry}</Button>} />
    : state.detail && state.canon ? <EpicDetail epic={state.detail} plans={state.canon.plans} tasks={state.tasks} busy={state.busy} onWrite={state.write} />
      : <ProgressMeter indeterminate label={appCopy.feedback.dashboardLoading} />;
  if (!glass) return <InspectorPanel title={appCopy.canon.epic} action={close}>{body}</InspectorPanel>;
  return <ManagementPagePanel><Section title={appCopy.canon.epic} actions={close} gap="sm">{body}</Section></ManagementPagePanel>;
}
