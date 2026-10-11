import type { ImgHTMLAttributes } from "react";
import type { MessageFileRef, SessionArtifactSummary } from "@/app/types.ts";
import {
  useMessageFileSource,
  type RefreshFileUrls,
} from "@/hooks/useMessageFileSource.ts";
import { markdownImageFile } from "./messageMedia";
import { ArtifactPreviewImage, Button, ButtonContainer, Expand, Stack } from "@/butler-ds";
import { artifactCardActions } from "@/components/artifacts/artifactActions";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store";

export interface MessageInlineImageProps
  extends Omit<ImgHTMLAttributes<HTMLImageElement>, "className" | "style"> {
  attachments: MessageFileRef[];
  artifacts: SessionArtifactSummary[];
  refreshFileUrls?: RefreshFileUrls;
}

/**
 * A markdown image. Message files load through their signed URL; a failed
 * load (expired or revoked signature) refreshes the session once. A message
 * file opens full size in the artifact viewer.
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
  const file = markdownImageFile(src, attachments, artifacts);
  const source = useMessageFileSource(file, refreshFileUrls);
  const resolvedSrc = file ? source.src : src;
  if (!resolvedSrc) return null;
  const attachment = attachments.find(item => item.url === file?.url);
  const artifact = artifacts.find(item => item.url === file?.url) ?? (attachment ? {
    id: `artifact-${attachment.file_id}`, file_id: attachment.file_id,
    title: attachment.safe_name, kind: attachment.kind, url: attachment.url,
    signed_url: attachment.signed_url, created_at: attachment.created_at,
  } : undefined);
  const save = artifact ? artifactCardActions(artifact)[0] : undefined;
  const open = artifact ? () => openArtifact(artifact.id, artifact) : undefined;
  return (
    <Stack as="span" gap="xs" cross="start" data-test-class="message-image">
    <ArtifactPreviewImage
      {...props}
      alt={alt ?? ""}
      data-test-class="markdown-inline-image"
      decoding="async"
      loading="lazy"
      src={resolvedSrc}
      onClick={open}
      onError={file ? source.onError : undefined}
      onLoad={file ? source.onLoad : undefined}
    />
    {(open || save) && <ButtonContainer size="xs">
      {open && artifact && <Button size="xs" variant="inline" iconStart={<Expand size="sm" />}
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
