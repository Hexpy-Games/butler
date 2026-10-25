import { createContext, useContext, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArtifactPreviewImage, MarkdownContent, MarkdownLink, MarkdownTable } from "@/butler-ds";
import type { MessageFileRef } from "@/app/types.ts";
import { useMessageFileSource } from "@/hooks/useMessageFileSource.ts";
import { getCanonEpic } from "@/app/canonApi.ts";
import { rememberSignedFileUrls, absoluteGatewayUrl, messageFileSource } from "@/app/messageFileUrls.ts";

const EpicFiles = createContext<{ epicId: string; attachments: MessageFileRef[] }>({ epicId: "", attachments: [] });
const NO_ATTACHMENTS: MessageFileRef[] = [];

function useEpicFile(url?: string) {
  const { attachments } = useContext(EpicFiles);
  return url && /^attachment:/iu.test(url) ? attachments.find(file => file.file_id === url.slice("attachment:".length)) : undefined;
}

function fileSource(file: MessageFileRef) {
  const url = messageFileSource(file);
  return url ? absoluteGatewayUrl(url) : undefined;
}

// One identity for every render: a new renderer type remounts links under the pointer, dropping their clicks and focus.
const components: Components = {
  table: MarkdownTable,
  a: function EpicLink({ href, children }) {
    const file = useEpicFile(href);
    const url = href && /^attachment:/iu.test(href) ? file && fileSource(file) : href;
    return <MarkdownLink href={url}>{children}</MarkdownLink>;
  },
  img: function EpicImage({ src, alt }) {
    const file = useEpicFile(typeof src === "string" ? src : undefined);
    return file?.kind === "image" ? <EpicAttachmentImage file={file} alt={alt ?? ""} /> : null;
  },
};

/** Only explicit attachment references can load images from this epic's file set. */
export function EpicMarkdown({ epicId, description, attachments = NO_ATTACHMENTS, density }: {
  density?: "document" | "compact";
  epicId: string; description: string; attachments?: MessageFileRef[];
}) {
  const files = useMemo(() => ({ epicId, attachments }), [epicId, attachments]);
  return <EpicFiles.Provider value={files}><MarkdownContent density={density} data-test-class="canon-markdown">
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}
      urlTransform={url => /^(attachment:|https?:|mailto:)/iu.test(url) ? url : ""}>{description}</ReactMarkdown>
  </MarkdownContent></EpicFiles.Provider>;
}

function EpicAttachmentImage({ file, alt }: { file: MessageFileRef; alt: string }) {
  const { epicId } = useContext(EpicFiles);
  const source = useMessageFileSource(file, async () => rememberSignedFileUrls(await getCanonEpic(epicId)));
  return source.src ? <ArtifactPreviewImage src={source.src} alt={alt} onError={source.onError} onLoad={source.onLoad} /> : null;
}
