import { faviconSrc } from "@/app/favicons.ts";
import { useAppLocale } from "@/app/copy.ts";
import { memo, useMemo, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { appCopy } from "@/app/copy.ts";
import type { MessageFileRef, SessionArtifactSummary } from "@/app/types.ts";
import { MarkdownContent, MarkdownLink, MarkdownTable, useStreamingReveal } from "@/butler-ds";
import type { RefreshFileUrls } from "@/hooks/useMessageFileSource.ts";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import { MessageInlineImage } from "./MessageInlineImage";
import { remarkPunctuationBoldSuffix } from "./remarkPunctuationBoldSuffix";

const EMPTY_ATTACHMENTS: MessageFileRef[] = [];
const EMPTY_ARTIFACTS: SessionArtifactSummary[] = [];
const MESSAGE_MARKDOWN_PLUGINS: ComponentProps<typeof ReactMarkdown>["remarkPlugins"] = [
  [remarkGfm, { singleTilde: false }],
  remarkPunctuationBoldSuffix,
];

function markdownComponents(
  attachments: MessageFileRef[],
  artifacts: SessionArtifactSummary[],
  refreshFileUrls: RefreshFileUrls | undefined,
) {
  return {
    pre: MarkdownCodeBlock,
    table: MarkdownTable,
    a: MarkdownLink,
    img: ({
      node: _node,
      ...props
    }: React.ImgHTMLAttributes<HTMLImageElement> & { node?: unknown }) => (
      <MessageInlineImage
        {...props}
        artifacts={artifacts}
        attachments={attachments}
        refreshFileUrls={refreshFileUrls}
      />
    ),
  };
}

interface MessageMarkdownProps {
  attachments?: MessageFileRef[];
  /** Message artifacts, for inline `/message-files/<id>` images. */
  artifacts?: SessionArtifactSummary[];
  /** Refreshes signed file URLs once after an inline image fails to load. */
  refreshFileUrls?: RefreshFileUrls;
  text: string;
  /** Streaming text fades in chunk by chunk. */
  streaming?: boolean;
}

function MessageMarkdownComponent({
  attachments = EMPTY_ATTACHMENTS,
  artifacts = EMPTY_ARTIFACTS,
  refreshFileUrls,
  text,
  streaming = false,
}: MessageMarkdownProps) {
  useAppLocale();
  const rehypePlugins = useStreamingReveal(text, streaming);
  const components = useMemo(
    () => markdownComponents(attachments, artifacts, refreshFileUrls),
    [attachments, artifacts, refreshFileUrls],
  );
  return (
    <section
      aria-label={appCopy.conversation.result.regionLabel}
      data-test-class="turn-result-section"
    >
      <MarkdownContent data-test-class="markdown-document" faviconSrc={faviconSrc}>
        <ReactMarkdown components={components} rehypePlugins={rehypePlugins} remarkPlugins={MESSAGE_MARKDOWN_PLUGINS}>
          {text}
        </ReactMarkdown>
      </MarkdownContent>
    </section>
  );
}

export const MessageMarkdown = memo(MessageMarkdownComponent);
MessageMarkdown.displayName = "MessageMarkdown";
