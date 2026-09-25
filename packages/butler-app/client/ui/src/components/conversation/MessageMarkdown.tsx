import { useAppLocale } from "@/app/copy.ts";
import { memo, useMemo, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { appCopy } from "@/app/copy.ts";
import type { MessageFileRef } from "@/app/types.ts";
import { MarkdownContent, MarkdownTable, useStreamingReveal } from "@/butler-ds";
import { resolveMarkdownImageSource } from "./messageMedia";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import { remarkPunctuationBoldSuffix } from "./remarkPunctuationBoldSuffix";

const EMPTY_ATTACHMENTS: MessageFileRef[] = [];
const MESSAGE_MARKDOWN_PLUGINS: ComponentProps<typeof ReactMarkdown>["remarkPlugins"] = [
  [remarkGfm, { singleTilde: false }],
  remarkPunctuationBoldSuffix,
];

function markdownComponents(attachments: MessageFileRef[]) {
  return {
    pre: MarkdownCodeBlock,
    table: MarkdownTable,
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
  /** Streaming text fades in chunk by chunk. */
  streaming?: boolean;
}

function MessageMarkdownComponent({
  attachments = EMPTY_ATTACHMENTS,
  text,
  streaming = false,
}: MessageMarkdownProps) {
  useAppLocale();
  const rehypePlugins = useStreamingReveal(text, streaming);
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
        <ReactMarkdown components={components} rehypePlugins={rehypePlugins} remarkPlugins={MESSAGE_MARKDOWN_PLUGINS}>
          {text}
        </ReactMarkdown>
      </MarkdownContent>
    </section>
  );
}

export const MessageMarkdown = memo(MessageMarkdownComponent);
MessageMarkdown.displayName = "MessageMarkdown";
