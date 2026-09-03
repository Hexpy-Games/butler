import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { appCopy } from "@/app/copy.ts";
import type { MessageFileRef } from "@/app/types.ts";
import { MarkdownContent } from "@/butler-ds";
import { resolveMarkdownImageSource } from "./messageMedia";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";

const EMPTY_ATTACHMENTS: MessageFileRef[] = [];

function markdownComponents(attachments: MessageFileRef[]) {
  return {
    pre: MarkdownCodeBlock,
    a: ({
      children,
      ...props
    }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
      <a {...props} target="_blank" rel="noreferrer">
        {children}
      </a>
    ),
    img: ({
      alt,
      src,
      ...props
    }: React.ImgHTMLAttributes<HTMLImageElement>) => {
      const resolvedSrc = resolveMarkdownImageSource(src, attachments);
      if (!resolvedSrc) return null;
      return (
        <img
          {...props}
          alt={alt ?? ""}
          data-test-class="markdown-inline-image"
          decoding="async"
          loading="lazy"
          src={resolvedSrc}
        />
      );
    },
  };
}

interface MessageMarkdownProps {
  attachments?: MessageFileRef[];
  text: string;
}

function MessageMarkdownComponent({
  attachments = EMPTY_ATTACHMENTS,
  text,
}: MessageMarkdownProps) {
  const components = useMemo(
    () => markdownComponents(attachments),
    [attachments],
  );
  return (
    <section
      aria-label={appCopy.conversation.result.regionLabel}
      data-test-class="turn-result-section"
    >
      <MarkdownContent data-test-class="markdown-document">
        <ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>
          {text}
        </ReactMarkdown>
      </MarkdownContent>
    </section>
  );
}

export const MessageMarkdown = memo(MessageMarkdownComponent);
MessageMarkdown.displayName = "MessageMarkdown";
