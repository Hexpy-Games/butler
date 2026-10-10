import { faviconSrc } from "@/app/favicons.ts";
import { useAppLocale } from "@/app/copy.ts";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  ArtifactPreview,
  ArtifactPreviewFrame,
  ArtifactPreviewImage,
  ArtifactPreviewPre,
  Button,
  MarkdownContent, MarkdownLink,
  PanelHeader,
  Stack,
  Typo,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { SessionArtifactSummary } from "@/app/types.ts";
import {
  useFreshFrameSource,
  useMessageFileSource,
  type MessageFileSourceState,
  type RefreshFileUrls,
} from "@/hooks/useMessageFileSource.ts";
import {
  artifactDescription,
  artifactMeta,
  artifactPreviewMode,
} from "./artifactDisplay";
import { OutputFrame } from "./OutputFrame";
import { useArtifactText, type ArtifactTextState } from "./useArtifactText";

const MARKDOWN_COMPONENTS: Components = { a: MarkdownLink };

export function ArtifactViewer({
  artifact,
  onBack,
  embedded = false,
  refreshFileUrls,
}: {
  artifact: SessionArtifactSummary;
  onBack: () => void;
  embedded?: boolean;
  /** Re-reads the list that owns the artifact when its signed URL is refused. */
  refreshFileUrls?: RefreshFileUrls;
}) {
  useAppLocale();
  const mode = artifactPreviewMode(artifact);
  const file = useMessageFileSource(artifact, refreshFileUrls);
  const { state, text } = useArtifactText({
    url: file.src,
    enabled: mode === "markdown" || mode === "text",
    path: file.path,
    refreshFileUrls,
  });
  useFreshFrameSource(file, mode === "pdf", refreshFileUrls);

  const meta = [artifactDescription(artifact), artifactMeta(artifact)]
    .filter(Boolean)
    .join(" / ");

  return (
    <Stack gap="md">
      {embedded ? <Typo.Caption>{meta}</Typo.Caption> : <PanelHeader
        actions={
          <Button
            iconStart={<ArrowLeft size="sm" />}
            size="xs"
            text={appCopy.artifacts.backToList}
            variant="borderless"
            onClick={onBack}
          />
        }
        description={meta}
        title={artifact.title}
      />}
      <ArtifactPreview data-test-class="artifact-viewer">
        {mode === "web" ? <OutputFrame key={artifact.id} outputId={artifact.id} title={artifact.title} preview={artifact.url?.startsWith("/previews/")} /> : renderPreview({ mode, state, text, title: artifact.title, file })}
      </ArtifactPreview>
    </Stack>
  );
}

function renderPreview(input: {
  mode: ReturnType<typeof artifactPreviewMode>;
  state: ArtifactTextState;
  text: string;
  title: string;
  file: MessageFileSourceState;
}) {
  const { file } = input;
  if (!file.src || input.mode === "unsupported") {
    return <Typo.Caption>{appCopy.artifacts.unsupported}</Typo.Caption>;
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
