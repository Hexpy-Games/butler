import { useEffect, useRef } from "react";
import { appCopy } from "@/app/copy.ts";
import { Button, InspectorPanel, Notice, ProgressMeter } from "@/butler-ds";
import { useCanonBoard } from "./useCanonBoard.ts";
import { EpicDetail } from "./EpicDetail.tsx";
export function EpicInspector({ projectId, epicId, focusTitle = false }: { projectId: string; epicId: string; focusTitle?: boolean }) {
  const state = useCanonBoard(projectId);
  const title = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focusTitle || !state.detail) return;
    const previous = document.activeElement as HTMLElement | null;
    title.current?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [focusTitle, state.detail?.id]);
  useEffect(() => { state.select(epicId); }, [projectId, epicId]);
  return <InspectorPanel title={null}>
    {state.error && !state.detail ? <Notice tone="error" message={appCopy.interfaceFeedback.requestFailed}
      action={<Button size="sm" onClick={() => void state.refresh()}>{appCopy.feedback.retry}</Button>} /> :
      state.detail && state.canon ? <EpicDetail titleRef={title} key={epicId} epic={state.detail} plans={state.canon.plans} tasks={state.tasks} busy={state.busy} onWrite={state.write} /> :
        <ProgressMeter indeterminate label={appCopy.feedback.dashboardLoading} />}
  </InspectorPanel>;
}
