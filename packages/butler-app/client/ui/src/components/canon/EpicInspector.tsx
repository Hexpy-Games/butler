import { useEffect } from "react";
import { appCopy } from "@/app/copy.ts";
import { Button, InspectorPanel, Notice, ProgressMeter } from "@/butler-ds";
import { useCanonBoard } from "./useCanonBoard.ts";
import { EpicDetail } from "./EpicDetail.tsx";
export function EpicInspector({ projectId, epicId }: { projectId: string; epicId: string }) {
  const state = useCanonBoard(projectId);
  useEffect(() => { state.select(epicId); }, [projectId, epicId]);
  return <InspectorPanel title={appCopy.canon.epic}>
    {state.error ? <Notice tone="error" message={appCopy.interfaceFeedback.requestFailed}
      action={<Button size="sm" onClick={() => void state.refresh()}>{appCopy.feedback.retry}</Button>} /> :
      state.detail && state.canon ? <EpicDetail key={epicId} epic={state.detail} plans={state.canon.plans} tasks={state.tasks} busy={state.busy} onWrite={state.write} /> :
        <ProgressMeter indeterminate label={appCopy.feedback.dashboardLoading} />}
  </InspectorPanel>;
}
