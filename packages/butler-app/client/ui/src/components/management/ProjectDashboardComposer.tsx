import { useRef, useState } from "react";
import { Composer } from "@/components/conversation/Composer.tsx";
import { useButlerStore } from "@/app/store.ts";
import { useProjectDashboardState } from "@/app/projectDashboardState.ts";
import { projectDraftId } from "@/app/utils.ts";
import { browserRandomId } from "@/app/id.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/butler-ds";
import type { ComposerControls, SessionSummary } from "@/app/types.ts";
import styles from "./ProjectDashboardComposer.module.css";

const noop = () => {};
export function ProjectDashboardComposer({ projectId, sessions }: { projectId: string; sessions: SessionSummary[] }) {
  useAppLocale();
  const target = useProjectDashboardState((state) => state.projects[projectId]?.targetSessionId);
  const update = useProjectDashboardState((state) => state.update);
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const eligible = sessions.filter((session) => !session.archived && session.project_id === projectId);
  const send = async (text: string, controls: ComposerControls) => {
    if (inFlight.current) return;
    inFlight.current = true; setSending(true);
    try {
      const fingerprint = JSON.stringify([text, controls.contentParts, controls.attachments?.map((file) => file.file_id),
        controls.model, controls.reasoningEffort, controls.accessMode, controls.planMode, controls.queuePolicy]);
      const previous = useProjectDashboardState.getState().projects[projectId]?.pendingSend;
      const pending = previous?.fingerprint === fingerprint && previous.sessionId === target ? previous
        : { fingerprint, clientMessageId: browserRandomId("client"), sessionId: target };
      update(projectId, { pendingSend: pending });
      await useButlerStore.getState().sendMessage(text, { ...controls, onAccepted: () => {
        update(projectId, { pendingSend: undefined }); controls.onAccepted?.();
      }, dashboardTarget: {
        projectId, sessionId: target, clientMessageId: pending.clientMessageId,
        onSessionCreated: (id) => update(projectId, { targetSessionId: id, pendingSend: { ...pending, sessionId: id } }),
      } });
    } finally { inFlight.current = false; setSending(false); }
  };
  return <div className={styles.dock}>
    <div className={styles.target}>
      <Select value={target ?? "new"} onValueChange={(value) => update(projectId, { targetSessionId: value === "new" ? undefined : value })} disabled={sending}>
        <SelectTrigger aria-label={appCopy.projectSignpost.conversationTarget}><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="new">{appCopy.projectSignpost.newProjectConversation}</SelectItem>
          {target && !eligible.some((session) => session.id === target) && <SelectItem value={target}>{appCopy.projectSignpost.pendingConversation}</SelectItem>}
          {eligible.map((session) => <SelectItem key={session.id} value={session.id}>{session.title}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
    <Composer large={false} onOpenContext={noop} onReserveChange={noop} scope={{
      draftKey: `dashboard:${projectId}`, targetChatId: target ?? projectDraftId(projectId), isSending: sending, onSend: send,
    }} />
  </div>;
}
