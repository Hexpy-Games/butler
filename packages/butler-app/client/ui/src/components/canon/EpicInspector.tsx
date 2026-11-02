import { useEffect, useRef } from "react";
import { appCopy } from "@/app/copy.ts";
import { Button, Stack, Notice, ProgressMeter, Typo } from "@/butler-ds";
import { useCanonBoard } from "./useCanonBoard.ts";
import { EpicDetail } from "./EpicDetail.tsx";
export function EpicInspector({ projectId, epicId, focusTitle = false, embedded = false }: { embedded?: boolean; projectId: string; epicId: string; focusTitle?: boolean }) {
  const state = useCanonBoard(projectId);
  const title = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focusTitle || !state.detail) return;
    const previous = document.activeElement as HTMLElement | null;
    title.current?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [focusTitle, state.detail?.id]);
  useEffect(() => { state.select(epicId); }, [projectId, epicId]);
  const content = <>
    {state.missing ? <Typo.Caption>{appCopy.canon.deletion.missing}</Typo.Caption> : state.error && !state.detail ? <Notice tone="error" message={appCopy.interfaceFeedback.requestFailed}
      action={<Button size="sm" onClick={() => void state.refresh()}>{appCopy.feedback.retry}</Button>} /> :
      state.detail && state.canon ? <EpicDetail compact={embedded} showConversation={!embedded} titleRef={title} key={epicId} epic={state.detail} plans={state.canon.plans} tasks={state.tasks} busy={state.busy} onRefresh={state.refresh} onWrite={state.write} /> :
        <ProgressMeter indeterminate label={appCopy.feedback.dashboardLoading} />}
  </>;
  return <Stack gap="sm">{content}</Stack>;
}
