import { faviconSrc } from "@/app/favicons.ts";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReactNode } from "react";
import {
  ArtifactPreview,
  ArtifactPreviewFrame,
  ArtifactPreviewImage,
  ArtifactPreviewPre,
  MarkdownContent, MarkdownLink,
  Stack,
  Typo,
  type ArtifactPreviewSurface,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { SessionArtifactSummary } from "@/app/types.ts";
import {
  useFreshFrameSource,
  useMessageFileSource,
  type MessageFileSourceState,
  type RefreshFileUrls,
} from "@/hooks/useMessageFileSource.ts";
import { artifactPreviewMode } from "./artifactDisplay";
import { HtmlFileFrame } from "./HtmlFileFrame";
import { OutputFrame } from "./OutputFrame";
import { useArtifactText, type ArtifactTextState } from "./useArtifactText";
import { ArtifactSaveButton, OpenInAppButton } from "./artifactActions";

const MARKDOWN_COMPONENTS: Components = { a: MarkdownLink };

/**
 * An artifact's content: markdown, a picture, a PDF, code or text in monospace, a page Butler made in its
 * isolated frame, and the user's own uploaded page as source. `surface="page"` flows it in the host's scroll.
 */
export function ArtifactBody({ artifact, refreshFileUrls, surface = "card" }: {
  artifact: SessionArtifactSummary;
  /** Re-reads the list that owns the artifact when its signed URL is refused. */
  refreshFileUrls?: RefreshFileUrls;
  surface?: ArtifactPreviewSurface;
}) {
  const mode = artifactPreviewMode(artifact);
  const file = useMessageFileSource(artifact, refreshFileUrls);
  const { state, text } = useArtifactText({
    url: file.src,
    enabled: mode === "markdown" || mode === "text",
    path: file.path,
    refreshFileUrls,
  });
  useFreshFrameSource(file, mode === "pdf", refreshFileUrls);
  return (
    <ArtifactPreview surface={surface} data-test-class="artifact-viewer" data-preview-mode={mode}>
      {mode === "web" ? <OutputFrame key={artifact.id} outputId={artifact.id} title={artifact.title} preview={artifact.url?.startsWith("/previews/")} /> : mode === "html" ? <HtmlFileFrame key={file.path} path={file.path} title={artifact.title} /> : renderPreview({ mode, state, text, title: artifact.title, file, save: surface === "page" ? <OpenInAppButton artifact={artifact} /> : <ArtifactSaveButton artifact={artifact} /> })}
    </ArtifactPreview>
  );
}

/** The artifact as one of its Library versions (newest first); index 0 is the artifact itself. */
export function revisionArtifact(artifact: SessionArtifactSummary, index: number): SessionArtifactSummary {
  const revision = index > 0 ? artifact.revisions?.[index] : undefined;
  if (!revision) return artifact;
  const { file } = revision;
  return { ...artifact, file_id: file.file_id, url: file.url, signed_url: file.signed_url, size_bytes: file.size_bytes,
    safe_path_label: file.safe_name, source_label: file.source_label ?? artifact.source_label, created_at: revision.capturedAt };
}

function renderPreview(input: {
  mode: ReturnType<typeof artifactPreviewMode>;
  state: ArtifactTextState;
  text: string;
  title: string;
  file: MessageFileSourceState;
  /** What an unpreviewable file offers instead (save, open in another app). */
  save: ReactNode;
}) {
  const { file } = input;
  if (!file.src || input.mode === "unsupported") {
    return <Stack gap="md"><Typo.Caption>{appCopy.artifacts.unsupported}</Typo.Caption>{input.save}</Stack>;
  }
  if (input.mode === "image") {
    return (
      <ArtifactPreviewImage
        alt={input.title}
        src={file.src}
        onError={file.onError}
        onLoad={file.onLoad}
      />
    );
  }
  if (input.mode === "pdf") {
    return <ArtifactPreviewFrame src={file.src} title={input.title} />;
  }
  if (input.state === "loading") {
    return <Typo.Caption>{appCopy.artifacts.loading}</Typo.Caption>;
  }
  if (input.state === "failed") {
    return <Typo.Caption>{appCopy.artifacts.loadFailed}</Typo.Caption>;
  }
  if (input.mode === "markdown") {
    return (
      <MarkdownContent faviconSrc={faviconSrc}>
        <ReactMarkdown
          components={MARKDOWN_COMPONENTS}
          remarkPlugins={[remarkGfm]}
        >
          {input.text}
        </ReactMarkdown>
      </MarkdownContent>
    );
  }
  return <ArtifactPreviewPre>{input.text}</ArtifactPreviewPre>;
}
