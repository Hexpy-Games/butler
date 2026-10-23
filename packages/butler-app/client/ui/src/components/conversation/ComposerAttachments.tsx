import { ComposerElements } from "../browser/ComposerElements";
import { useAppLocale } from "@/app/copy.ts";
import {
  AttachmentList,
  BookOpenText,
  FileText,
  Paperclip,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { openImageViewer, type ViewerImage } from "../media/imageViewerState";
import { useComposerStore } from "./composerStore";
import type { ComposerAttachment } from "./hooks/useFileAttachments";
import { messageFileUrl } from "./messageMedia";
import { attachmentViewerKind } from "./messageImages";
import { attachmentTile, openAttachmentInInspector } from "./attachmentTiles";
import { imageRefusalLabel } from "./composerImagePolicy";

export function ComposerAttachments() {
  useAppLocale();
  const attachments = useComposerStore((store) => store.attachments);
  const removeAttachment = useComposerStore((store) => store.removeAttachment);
  const blockedAttachments = useComposerStore((store) => store.blockedAttachments);
  const sessionId = useComposerStore((store) => store.draftSessionId);

  if (attachments.length === 0) return <ComposerElements />;

  const open = (id: string) => {
    const attachment = attachments.find((item) => item.id === id);
    if (!attachment) return;
    const viewable = attachments.filter((item) => attachmentViewerKind(item.file));
    if (!attachmentViewerKind(attachment.file)) { openAttachmentInInspector(attachment.file, sessionId); return; }
    const images: ViewerImage[] = viewable.map((item) => ({
      src: messageFileUrl(item.file), alt: item.file.safe_name, kind: attachmentViewerKind(item.file), sessionId,
    }));
    openImageViewer(images, viewable.indexOf(attachment));
  };

  return (
    <><ComposerElements /><AttachmentList
      windowDrag="no-drag"
      variant="tiles"
      tileLayout="row"
      items={attachments.map((attachment) => ({
        id: attachment.id,
        ...attachmentTile(attachment.file),
        icon: attachmentIcon(attachment),
        blockedReason: blockedLabel(blockedAttachments.get(attachment.id)),
      }))}
      emptyLabel={appCopy.composer.attachedFiles}
      onOpen={(item) => open(item.id)}
      onRemove={removeAttachment}
      removeLabel={appCopy.composer.removeFile}
    /></>
  );
}

function attachmentIcon(attachment: ComposerAttachment) {
  if (attachment.kind === "project-document") return <BookOpenText size="sm" />;
  if (attachment.kind === "text") return <FileText size="sm" />;
  return <Paperclip size="sm" />;
}

function blockedLabel(refusal: Parameters<typeof imageRefusalLabel>[0] | undefined) {
  return refusal ? imageRefusalLabel(refusal) : undefined;
}
