import { useRef, useState } from "react";
import { Composer } from "@/components/conversation/Composer.tsx";
import { useButlerStore } from "@/app/store.ts";
import { prepareDashboardSend, useProjectDashboardState } from "@/app/projectDashboardState.ts";
import { projectDraftId } from "@/app/utils.ts";
import type { ComposerControls } from "@/app/types.ts";

const noop = () => {};
export function ProjectDashboardComposer({ projectId, onReserveChange }: {
  projectId: string; onReserveChange: (height: number) => void;
}) {
  const update = useProjectDashboardState((state) => state.update);
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const send = async (text: string, controls: ComposerControls) => {
    if (inFlight.current) return;
    inFlight.current = true; setSending(true);
    try {
      const fingerprint = JSON.stringify([text, controls.contentParts, controls.attachments?.map((file) => file.file_id),
        controls.model, controls.reasoningEffort, controls.accessMode, controls.planMode, controls.queuePolicy]);
      const pending = prepareDashboardSend(projectId, fingerprint);
      await useButlerStore.getState().sendMessage(text, { ...controls, onAccepted: () => {
        update(projectId, { pendingSend: undefined }); controls.onAccepted?.();
      }, dashboardTarget: {
        projectId, sessionId: pending.sessionId, clientMessageId: pending.clientMessageId,
        onSessionCreated: (id) => update(projectId, { pendingSend: { ...pending, sessionId: id } }),
      } });
    } finally { inFlight.current = false; setSending(false); }
  };
  return <Composer large={false} onOpenContext={noop} onReserveChange={onReserveChange} scope={{
      draftKey: `dashboard:${projectId}`, targetChatId: projectDraftId(projectId), isSending: sending, onSend: send,
    }} />;
}
