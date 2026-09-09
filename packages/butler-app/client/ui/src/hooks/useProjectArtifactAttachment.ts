import { useRef } from "react";
import { api } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { notifyError } from "@/app/notifications.ts";
import { useComposerStore } from "@/components/conversation/composerStore.ts";
import type { MessageFileRef } from "@/app/types.ts";

export function useProjectArtifactAttachment(projectId: string | undefined) {
  const copying = useRef(false);
  return async (source: { id: string; revision: string }) => {
    if (!projectId || copying.current) return;
    copying.current = true;
    const draft = useComposerStore.getState().draftSessionId;
    try {
      const { file } = await api<{ file: MessageFileRef }>(`/projects/${encodeURIComponent(projectId)}/dashboard/attachment`, {
        method: "POST", body: JSON.stringify(source),
      });
      const composer = useComposerStore.getState();
      if (composer.draftSessionId !== draft || draft !== `dashboard:${projectId}`) return;
      composer.setAttachments((current) => [...current, { id: file.file_id, file, kind: file.kind ?? "generic" }]);
      if (!composer.text.trim()) composer.setText(appCopy.projectSignpost.sourceQuestion);
    } catch (error) { notifyError(error, appCopy.feedback.dashboardRetry); }
    finally { copying.current = false; }
  };
}
