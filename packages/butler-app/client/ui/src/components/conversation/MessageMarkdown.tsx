import { useAppLocale } from "@/app/copy.ts";
import { memo, useMemo, type ComponentProps, type TableHTMLAttributes } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { appCopy } from "@/app/copy.ts";
import type { MessageFileRef } from "@/app/types.ts";
import { MarkdownContent, useScrollEdges } from "@/butler-ds";
import { resolveMarkdownImageSource } from "./messageMedia";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import { remarkPunctuationBoldSuffix } from "./remarkPunctuationBoldSuffix";

const EMPTY_ATTACHMENTS: MessageFileRef[] = [];
const MESSAGE_MARKDOWN_PLUGINS: ComponentProps<typeof ReactMarkdown>["remarkPlugins"] = [
  [remarkGfm, { singleTilde: false }],
  remarkPunctuationBoldSuffix,
];

function MarkdownTable({
  node: _node,
  ...props
}: TableHTMLAttributes<HTMLTableElement> & { node?: unknown }) {
  const tableFadeRef = useScrollEdges("x");
  return <table ref={tableFadeRef} {...props} />;
}

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
}

function MessageMarkdownComponent({
  attachments = EMPTY_ATTACHMENTS,
  text,
}: MessageMarkdownProps) {
  useAppLocale();
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
        <ReactMarkdown components={components} remarkPlugins={MESSAGE_MARKDOWN_PLUGINS}>
          {text}
        </ReactMarkdown>
      </MarkdownContent>
    </section>
  );
}

export const MessageMarkdown = memo(MessageMarkdownComponent);
MessageMarkdown.displayName = "MessageMarkdown";
