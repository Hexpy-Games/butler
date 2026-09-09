import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import type { MessageFileRef } from "@/app/types.ts";
import { AttachmentList } from "@/butler-ds";
import { messageFileUrl } from "./messageMedia";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MessageAttachments({
  attachments,
}: {
  attachments: MessageFileRef[];
}) {
  useAppLocale();
  if (attachments.length === 0) return null;
  return (
    <div
      data-test-class="message-attachment-list"
      aria-label={appCopy.interfacePanels.attachments}
    >
      <AttachmentList
        items={attachments.map((attachment) => ({
          id: attachment.file_id,
          name: attachment.safe_name,
          meta: formatFileSize(attachment.size_bytes),
          href: messageFileUrl(attachment),
        }))}
      />
    </div>
  );
}
