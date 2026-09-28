import type { ImgHTMLAttributes } from "react";
import type { MessageFileRef, SessionArtifactSummary } from "@/app/types.ts";
import {
  useMessageFileSource,
  type RefreshFileUrls,
} from "@/hooks/useMessageFileSource.ts";
import { markdownImageFile } from "./messageMedia";

export interface MessageInlineImageProps
  extends ImgHTMLAttributes<HTMLImageElement> {
  attachments: MessageFileRef[];
  artifacts: SessionArtifactSummary[];
  refreshFileUrls?: RefreshFileUrls;
}

/**
 * A markdown image. Message files load through their signed URL; a failed
 * load (expired or revoked signature) refreshes the session once.
 */
export function MessageInlineImage({
  alt,
  src,
  attachments,
  artifacts,
  refreshFileUrls,
  ...props
}: MessageInlineImageProps) {
  const file = markdownImageFile(src, attachments, artifacts);
  const source = useMessageFileSource(file, refreshFileUrls);
  const resolvedSrc = file ? source.src : src;
  if (!resolvedSrc) return null;
  return (
    <img
      {...props}
      alt={alt ?? ""}
      data-test-class="markdown-inline-image"
      decoding="async"
      loading="lazy"
      src={resolvedSrc}
      onError={file ? source.onError : undefined}
      onLoad={file ? source.onLoad : undefined}
    />
  );
}
