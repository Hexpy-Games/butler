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
  NativeSelect,
  NativeSelectOption,
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
import { HtmlFileFrame } from "./HtmlFileFrame";
import { OutputFrame } from "./OutputFrame";
import { useArtifactText, type ArtifactTextState } from "./useArtifactText";
import { useMemo, useState, type ReactNode } from "react";
import { ArtifactSaveButton } from "./artifactActions";

const MARKDOWN_COMPONENTS: Components = { a: MarkdownLink };

export function ArtifactViewer({
  artifact: latest,
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
  const [choice, setChoice] = useState<{ id: string; index: number }>();
  const revisions = latest.revisions ?? [];
  const index = choice?.id === latest.id ? choice.index : 0;
  const artifact = useMemo(() => revisionArtifact(latest, index), [latest, index]);
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
      {revisions.length > 1 && <Stack align="row" gap="sm" cross="center" wrap>
        <NativeSelect aria-label={appCopy.artifacts.revision} value={String(index)} onChange={(event) => setChoice({ id: latest.id, index: Number(event.target.value) })}>
          {revisions.map((revision, position) => <NativeSelectOption key={revision.file.file_id} value={String(position)}>
            {`${appCopy.artifacts.revision} ${revisions.length - position}`}
          </NativeSelectOption>)}
        </NativeSelect>
      </Stack>}
      <ArtifactPreview data-test-class="artifact-viewer">
        {mode === "web" ? <OutputFrame key={artifact.id} outputId={artifact.id} title={artifact.title} preview={artifact.url?.startsWith("/previews/")} /> : mode === "html" ? <HtmlFileFrame key={file.path} path={file.path} title={artifact.title} /> : renderPreview({ mode, state, text, title: artifact.title, file, save: <ArtifactSaveButton artifact={artifact} /> })}
      </ArtifactPreview>
    </Stack>
  );
}

/** The artifact as one of its Library versions (newest first); index 0 is the artifact itself. */
function revisionArtifact(artifact: SessionArtifactSummary, index: number): SessionArtifactSummary {
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
