import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import type { MessageFileRef } from "@/app/types.ts";
import { AttachmentList } from "@/butler-ds";
import { attachmentTile, openAttachmentInViewer } from "./attachmentTiles";
import { attachmentViewerKind, useOpenMessageImage } from "./messageImages";

/** A sent message's files as tiles: pictures and videos open the image viewer over the session, other files the file viewer. */
export function MessageAttachments({
  attachments,
  sessionId, tileAlign,
}: {
  attachments: MessageFileRef[];
  sessionId: string;
  tileAlign?: "start" | "end";
}) {
  useAppLocale();
  const openImage = useOpenMessageImage();
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
