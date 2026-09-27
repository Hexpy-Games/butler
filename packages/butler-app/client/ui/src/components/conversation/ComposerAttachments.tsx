import { useAppLocale } from "@/app/copy.ts";
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
import { imageRefusalLabel } from "./composerImagePolicy";

export function ComposerAttachments() {
  useAppLocale();
  const attachments = useComposerStore((store) => store.attachments);
  const removeAttachment = useComposerStore((store) => store.removeAttachment);
  const blockedAttachments = useComposerStore((store) => store.blockedAttachments);

  if (attachments.length === 0) return null;

  return (
    <AttachmentList
      windowDrag="no-drag"
      items={attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.file.safe_name,
        meta: formatFileSize(attachment.file.size_bytes),
        href: messageFileUrl(attachment.file),
        icon: attachmentIcon(attachment),
        blockedReason: blockedLabel(blockedAttachments.get(attachment.id)),
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
  if (attachment.kind === "project-document") return <BookOpenText size="sm" />;
  if (attachment.kind === "image") return <ImageIcon size="sm" />;
  if (attachment.kind === "text") return <FileText size="sm" />;
  return <Paperclip size="sm" />;
}

function blockedLabel(refusal: Parameters<typeof imageRefusalLabel>[0] | undefined) {
  return refusal ? imageRefusalLabel(refusal) : undefined;
}
