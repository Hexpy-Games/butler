import { useEffect, useRef, useState } from "react";
import { uploadMessageFile } from "@/app/api.ts";
import { notifyError } from "@/app/notifications.ts";
import { projectDocumentFileName } from "@/app/projectDocuments.ts";
import { isDraftChatId } from "@/app/utils.ts";
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
    const rejected: string[] = [];
    setUploadingCount((count) => count + files.length);
    for (const file of files) {
      if (!isMountedRef.current || uploadEpochRef.current !== uploadEpoch)
        break;
      if (file.size > ATTACHMENT_MAX_BYTES) {
        rejected.push(
          `${file.name}: larger than ${formatFileSize(ATTACHMENT_MAX_BYTES)}`,
        );
        if (isMountedRef.current && uploadEpochRef.current === uploadEpoch) {
          setUploadingCount((count) => Math.max(0, count - 1));
        }
        continue;
      }
      try {
        const uploaded = await uploadMessageFile(
          file,
          isDraftChatId(activeChatId) ? undefined : activeChatId,
        );
        accepted.push({
          id: `${file.name}-${file.size}-${crypto.randomUUID()}`,
          file: uploaded,
          kind: uploaded.kind ?? "generic",
        });
      } catch (error) {
        rejected.push(
          `${file.name}: ${error instanceof Error ? error.message : "upload failed"}`,
        );
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
    if (rejected.length > 0) {
      notifyError(new Error(rejected.join("; ")), "Attachment failed", {
        id: `attachment-${activeChatId}`,
      });
    }
  }

  async function addProjectDocument(document: ProjectDashboardDocument) {
    const uploadEpoch = uploadEpochRef.current;
    const file = new File(
      [document.markdown],
      projectDocumentFileName(document),
      {
        type: "text/markdown",
      },
    );
    setUploadingCount((count) => count + 1);
    try {
      const uploaded = await uploadMessageFile(
        file,
        isDraftChatId(activeChatId) ? undefined : activeChatId,
      );
      if (!isMountedRef.current || uploadEpochRef.current !== uploadEpoch)
        return;
      setAttachments((current) => [
        ...current,
        {
          id: `project-document-${document.id}-${crypto.randomUUID()}`,
          file: uploaded,
          kind: "project-document",
        },
      ]);
    } catch (error) {
      notifyError(error, "Project document attachment failed", {
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
