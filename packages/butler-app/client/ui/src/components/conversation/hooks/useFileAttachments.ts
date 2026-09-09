import { useEffect, useRef, useState } from "react";
import { uploadMessageFile } from "@/app/api.ts";
import { browserRandomUUID } from "@/app/id.ts";
import { notifyError } from "@/app/notifications.ts";
import { appCopy } from "@/app/copy.ts";
import { projectDocumentFileName } from "@/app/projectDocuments.ts";
import { completeProjectDocument, readProjectDocumentPage } from "@/app/projectDocumentSource.ts";
import { isProjectSourceContentPart } from "@/app/messageContent.ts";
import { useComposerStore } from "../composerStore.ts";
import { isServerBackedSessionId } from "@/app/sessionIds.ts";
import type { MessageFileRef, ProjectDashboardDocument } from "@/app/types.ts";
import { ATTACHMENT_MAX_BYTES, formatFileSize } from "../conversationUtils";

export interface ComposerAttachment {
  id: string;
  file: MessageFileRef;
  kind: "project-document" | MessageFileRef["kind"];
}

export function useFileAttachments(activeChatId: string) {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  const isMountedRef = useRef(true);
  const uploadEpochRef = useRef(0);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      uploadEpochRef.current += 1;
    };
  }, []);

  useEffect(() => {
    uploadEpochRef.current += 1;
    setAttachments([]);
    setUploadingCount(0);
  }, [activeChatId]);

  async function addFiles(fileList: FileList | null) {
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;
    const uploadEpoch = uploadEpochRef.current;
    const accepted: ComposerAttachment[] = [];
    const failed: string[] = [];
    const oversized: string[] = [];
    setUploadingCount((count) => count + files.length);
    for (const file of files) {
      if (!isMountedRef.current || uploadEpochRef.current !== uploadEpoch)
        break;
      if (file.size > ATTACHMENT_MAX_BYTES) {
        oversized.push(file.name);
        if (isMountedRef.current && uploadEpochRef.current === uploadEpoch) {
          setUploadingCount((count) => Math.max(0, count - 1));
        }
        continue;
      }
      try {
        const uploaded = await uploadMessageFile(
          file,
          isServerBackedSessionId(activeChatId) ? activeChatId : undefined,
        );
        accepted.push({
          id: `${file.name}-${file.size}-${browserRandomUUID()}`,
          file: uploaded,
          kind: uploaded.kind ?? "generic",
        });
      } catch {
        failed.push(file.name);
      } finally {
        if (isMountedRef.current && uploadEpochRef.current === uploadEpoch) {
          setUploadingCount((count) => Math.max(0, count - 1));
        }
      }
    }
    if (!isMountedRef.current || uploadEpochRef.current !== uploadEpoch) return;
    if (accepted.length > 0) {
      setAttachments((current) => [...current, ...accepted]);
    }
    if (failed.length > 0) {
      notifyError(new Error(appCopy.feedback.attachmentRetry(failed.join(", "))), appCopy.feedback.attachmentFailed, {
        id: `attachment-${activeChatId}`,
      });
    }
    if (oversized.length > 0) {
      notifyError(new Error(appCopy.feedback.attachmentSizeLimit(oversized.join(", "), formatFileSize(ATTACHMENT_MAX_BYTES))),
        appCopy.feedback.attachmentTooLarge, { id: `attachment-size-${activeChatId}` });
    }
  }

  async function addProjectDocument(document: ProjectDashboardDocument, topic?: string) {
    const uploadEpoch = uploadEpochRef.current;
    const fileName = projectDocumentFileName(document);
    setUploadingCount((count) => count + 1);
    try {
      if (document.project_id && document.revision) {
        const source = await readProjectDocumentPage(document);
        if (!isMountedRef.current || uploadEpochRef.current !== uploadEpoch) return;
        const part = { type: "project_source_ref", projectId: document.project_id, titleSnapshot: topic ?? source.title,
          ...(topic ? { topic } : {}),
          source: { kind: source.document_type ?? source.kind, id: source.id, revision: source.revision } };
        if (!isProjectSourceContentPart(part)) throw new Error("Invalid project source.");
        const draft = useComposerStore.getState();
        const parts = draft.contentParts?.parts ?? [{ type: "text" as const, text: draft.text }];
        draft.setContentParts({ version: 1, parts: [...parts, part] });
        return;
      }
      const complete = await completeProjectDocument(document);
      if (!isMountedRef.current || uploadEpochRef.current !== uploadEpoch) return;
      const file = new File([complete.markdown], fileName, { type: "text/markdown" });
      if (file.size > ATTACHMENT_MAX_BYTES) throw new Error("Project source exceeds the attachment limit.");
      const uploaded = await uploadMessageFile(
        file,
        isServerBackedSessionId(activeChatId) ? activeChatId : undefined,
      );
      if (!isMountedRef.current || uploadEpochRef.current !== uploadEpoch)
        return;
      setAttachments((current) => [
        ...current,
        {
          id: `project-document-${document.id}-${browserRandomUUID()}`,
          file: uploaded,
          kind: "project-document",
        },
      ]);
    } catch {
      if (!isMountedRef.current || uploadEpochRef.current !== uploadEpoch) return;
      notifyError(new Error(appCopy.feedback.attachmentRetry(fileName)), appCopy.feedback.attachmentFailed, {
        id: `project-document-attachment-${activeChatId}`,
      });
    } finally {
      if (isMountedRef.current && uploadEpochRef.current === uploadEpoch) {
        setUploadingCount((count) => Math.max(0, count - 1));
      }
    }
  }

  return {
    attachments,
    setAttachments,
    uploadingCount,
    addFiles,
    addProjectDocument,
  };
}
