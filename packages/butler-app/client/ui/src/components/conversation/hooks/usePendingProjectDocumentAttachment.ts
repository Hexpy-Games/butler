import { useEffect } from "react";
import type { ProjectDashboardDocument } from "@/app/types.ts";
import { parseDraftChatId } from "@/app/utils.ts";
import type { useFileAttachments } from "./useFileAttachments";

type PendingProjectDocumentAttachment = {
  projectId: string;
  document: ProjectDashboardDocument;
};

export function usePendingProjectDocumentAttachment({
  activeChatId,
  clearPendingProjectDocumentAttachment,
  files,
  pendingProjectDocumentAttachment,
}: {
  activeChatId: string;
  clearPendingProjectDocumentAttachment: () => void;
  files: ReturnType<typeof useFileAttachments>;
  pendingProjectDocumentAttachment: PendingProjectDocumentAttachment | null;
}) {
  useEffect(() => {
    const pending = pendingProjectDocumentAttachment;
    if (!pending) return;
    if (parseDraftChatId(activeChatId).projectId !== pending.projectId) return;
    clearPendingProjectDocumentAttachment();
    void files.addProjectDocument(pending.document);
  }, [
    activeChatId,
    clearPendingProjectDocumentAttachment,
    files,
    pendingProjectDocumentAttachment,
  ]);
}
