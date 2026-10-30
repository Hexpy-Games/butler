import { useCallback } from "react";
import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { refreshSessionFileUrls } from "@/app/messageFileRefresh.ts";
import type { MessageFileRef } from "@/app/types.ts";
import { AttachmentList } from "@/butler-ds";
import { useFreshFileSources, type RefreshFileUrls } from "@/hooks/useMessageFileSource.ts";
import { attachmentTile, openAttachmentInViewer } from "./attachmentTiles";
import { attachmentViewerKind, useOpenMessageImage } from "./messageImages";

/**
 * A sent message's files as tiles: pictures and videos open the image viewer over the session, other files the file viewer.
 * Pictures and videos load from fresh signed URLs; `refreshFileUrls` re-signs them (default: the session's latest pages).
 */
export function MessageAttachments({
  attachments,
  sessionId, tileAlign, refreshFileUrls,
}: {
  attachments: MessageFileRef[];
  sessionId: string;
  tileAlign?: "start" | "end";
  refreshFileUrls?: RefreshFileUrls;
}) {
  useAppLocale();
  const openImage = useOpenMessageImage();
  const refreshSession = useCallback(() => refreshSessionFileUrls(sessionId), [sessionId]);
  useFreshFileSources(attachments.filter((file) => attachmentViewerKind(file)), refreshFileUrls ?? refreshSession);
  if (attachments.length === 0) return null;
  const files = new Map(attachments.map((file) => [file.file_id, file]));
  return (
    <div
      data-test-class="message-attachment-list"
      aria-label={appCopy.interfacePanels.attachments}
    >
      <AttachmentList
        variant="tiles"
        tileLayout="wrap"
        tileAlign={tileAlign}
        items={attachments.map((file) => ({ id: file.file_id, ...attachmentTile(file) }))}
        onOpen={(item) => {
          const file = files.get(item.id);
          if (!file) return;
          if (attachmentViewerKind(file) && openImage) openImage(file.url);
          else openAttachmentInViewer(file, sessionId);
        }}
      />
    </div>
  );
}
