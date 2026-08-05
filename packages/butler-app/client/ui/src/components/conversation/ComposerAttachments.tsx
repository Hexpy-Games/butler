import {
  AttachmentList,
  BookOpenText,
  FileText,
  ImageIcon,
  Paperclip,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { useComposerStore } from "./composerStore";
import type { ComposerAttachment } from "./hooks/useFileAttachments";
import { formatFileSize, messageFileUrl } from "./conversationUtils";

export function ComposerAttachments() {
  const attachments = useComposerStore((store) => store.attachments);
  const removeAttachment = useComposerStore((store) => store.removeAttachment);

  if (attachments.length === 0) return null;

  return (
    <AttachmentList
      className="no-drag"
      items={attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.file.safe_name,
        meta: formatFileSize(attachment.file.size_bytes),
        href: messageFileUrl(attachment.file),
        icon: attachmentIcon(attachment),
        thumbnail:
          attachment.kind === "image"
            ? {
                alt: attachment.file.safe_name,
                src: messageFileUrl(attachment.file),
              }
            : undefined,
      }))}
      emptyLabel={appCopy.composer.attachedFiles}
      onRemove={removeAttachment}
      variant="chips"
    />
  );
}

function attachmentIcon(attachment: ComposerAttachment) {
  if (attachment.kind === "project-document") return <BookOpenText size={13} />;
  if (attachment.kind === "image") return <ImageIcon size={13} />;
  if (attachment.kind === "text") return <FileText size={13} />;
  return <Paperclip size={13} />;
}
