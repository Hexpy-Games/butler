import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArtifactPreviewImage, MarkdownContent, MarkdownLink, MarkdownTable } from "@/butler-ds";
import type { MessageFileRef } from "@/app/types.ts";
import { useMessageFileSource } from "@/hooks/useMessageFileSource.ts";
import { getCanonEpic } from "@/app/canonApi.ts";
import { rememberSignedFileUrls, absoluteGatewayUrl, messageFileSource } from "@/app/messageFileUrls.ts";

/** Only explicit attachment references can load images from this epic's file set. */
export function EpicMarkdown({ epicId, description, attachments = [] }: {
  epicId: string; description: string; attachments?: MessageFileRef[];
}) {
  const fileFor = (url?: string) => url?.startsWith("attachment:")
    ? attachments.find(file => file.file_id === url.slice("attachment:".length)) : undefined;
  const source = (file: MessageFileRef) => {
    const url = messageFileSource(file);
    return url ? absoluteGatewayUrl(url) : undefined;
  };
  return <MarkdownContent data-test-class="canon-markdown">
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml
      urlTransform={url => /^(attachment:|https?:|mailto:)/iu.test(url) ? url : ""}
      components={{
        table: MarkdownTable,
        a: ({ href, children }) => {
          const file = fileFor(href);
          const url = href?.startsWith("attachment:") ? file && source(file) : href;
          return <MarkdownLink href={url}>{children}</MarkdownLink>;
        },
        img: ({ src, alt }) => {
          const file = fileFor(typeof src === "string" ? src : undefined);
          return file?.kind === "image" ? <EpicAttachmentImage epicId={epicId} file={file} alt={alt ?? ""} /> : null;
        },
      }}>{description}</ReactMarkdown>
  </MarkdownContent>;
}

function EpicAttachmentImage({ epicId, file, alt }: { epicId: string; file: MessageFileRef; alt: string }) {
  const source = useMessageFileSource(file, async () => rememberSignedFileUrls(await getCanonEpic(epicId)));
  return source.src ? <ArtifactPreviewImage src={source.src} alt={alt} onError={source.onError} onLoad={source.onLoad} /> : null;
}
