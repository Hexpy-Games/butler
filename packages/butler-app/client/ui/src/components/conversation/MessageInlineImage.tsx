import type { ImgHTMLAttributes } from "react";
import type { MessageFileRef, SessionArtifactSummary } from "@/app/types.ts";
import {
  useMessageFileSource,
  type RefreshFileUrls,
} from "@/hooks/useMessageFileSource.ts";
import { markdownImageFile } from "./messageMedia";
import { ArtifactPreviewImage, Button, ButtonContainer, Eye, Stack } from "@/butler-ds";
import { artifactCardActions } from "@/components/artifacts/artifactActions";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store";
import { useOpenMessageImage } from "./messageImages";
import { fileArtifact } from "./workingFiles";

export interface MessageInlineImageProps
  extends Omit<ImgHTMLAttributes<HTMLImageElement>, "className" | "style"> {
  attachments: MessageFileRef[];
  artifacts: SessionArtifactSummary[];
  refreshFileUrls?: RefreshFileUrls;
}

/**
 * A markdown image. Message files load through their signed URL; a failed
 * load (expired or revoked signature) refreshes the session once. The picture
 * opens the image viewer on the message's pictures; Open shows a message file
 * in the file viewer. A relative path that names no message file cannot
 * load, so it shows nothing.
 */
export function MessageInlineImage({
  alt,
  src,
  attachments,
  artifacts,
  refreshFileUrls,
  ...props
}: MessageInlineImageProps) {
  const openArtifact = useButlerStore((state) => state.openArtifact);
  const openImage = useOpenMessageImage();
  const file = markdownImageFile(src, attachments, artifacts);
  const source = useMessageFileSource(file, refreshFileUrls);
  const resolvedSrc = file ? source.src : src;
  if (!resolvedSrc || (!file && !/^(https?:|data:image\/|\/)/iu.test(resolvedSrc))) return null;
  const key = file?.url ?? resolvedSrc;
  const view = openImage ? () => openImage(key) : undefined;
  const attachment = attachments.find(item => item.url === file?.url);
  // The attachment as an artifact keeps what decides its actions (delivered or not, its size).
  const artifact = artifacts.find(item => item.url === file?.url) ?? (attachment ? fileArtifact(attachment) : undefined);
  const save = artifact ? artifactCardActions(artifact)[0] : undefined;
  const open = artifact ? () => openArtifact(artifact) : undefined;
  return (
    <Stack as="span" gap="xs" cross="start" data-test-class="message-image">
    <ArtifactPreviewImage
      {...props}
      alt={alt ?? ""}
      data-test-class="markdown-inline-image"
      decoding="async"
      loading="lazy"
      src={resolvedSrc}
      role={view ? "button" : undefined}
      tabIndex={view ? 0 : undefined}
      aria-label={view ? appCopy.conversation.imageViewer.viewImage(alt || artifact?.title || appCopy.conversation.answerBlocks.image) : undefined}
      onClick={view ?? open}
      onKeyDown={view ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); view(); } } : undefined}
      onError={file ? source.onError : undefined}
      onLoad={file ? source.onLoad : undefined}
    />
    {(open || save) && <ButtonContainer size="xs">
      {open && artifact && <Button size="xs" variant="inline" iconStart={<Eye size="sm" />}
        aria-label={`${appCopy.artifacts.open}: ${artifact.title}`} data-test-class="message-image-open" onClick={open}>
        {appCopy.artifacts.open}
      </Button>}
      {save && <Button size="xs" variant="inline" iconStart={save.icon} aria-label={save.ariaLabel}
        onClick={save.onClick} asChild={Boolean(save.href)}>
        {save.href ? <a href={save.href} download={save.download}>{save.label}</a> : save.label}
      </Button>}
    </ButtonContainer>}
    </Stack>
  );
}
