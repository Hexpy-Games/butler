import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import type { MessageFileRef, SessionArtifactSummary } from "@/app/types.ts";
import { useButlerStore } from "@/app/store.ts";
import { ArtifactList, FileText, MarkdownContent, Space, Stack } from "@/butler-ds";
import { artifactCardActions } from "@/components/artifacts/artifactActions";
import { artifactDescription } from "@/components/artifacts/artifactDisplay";
import { useMemo } from "react";
import { inlineImageFiles } from "./inlineImageFiles";
import { MessageInlineImage } from "./MessageInlineImage";
import { fileArtifact, isLegacyFileMessage } from "./workingFiles";
import type { RefreshFileUrls } from "@/hooks/useMessageFileSource";

export function MessageArtifacts({
  artifacts,
  attachments = [],
  text = "",
  refreshFileUrls,
}: {
  artifacts: SessionArtifactSummary[];
  attachments?: MessageFileRef[];
  text?: string;
  refreshFileUrls?: RefreshFileUrls;
}) {
  useAppLocale();
  const openArtifact = useButlerStore((state) => state.openArtifact);
  const inlineFiles = useMemo(() => inlineImageFiles(text, attachments, artifacts), [text, attachments, artifacts]);
  const legacy = isLegacyFileMessage(attachments);
  // Only delivered files are listed here; the rest of the turn's files stay in the changed-files block.
  const visibleArtifacts = (artifacts.length > 0 ? artifacts : attachments.map(fileArtifact))
    .filter(artifact => legacy || artifact.deliverable)
    .filter(artifact => artifact.kind !== "image" || !artifact.url || !inlineFiles.has(artifact.url));
  if (visibleArtifacts.length === 0) return null;
  const images = visibleArtifacts.filter(artifact => artifact.kind === "image" && artifact.url);
  const files = visibleArtifacts.filter(artifact => artifact.kind !== "image" || !artifact.url);
  return (
    <>
      <Space size="md" />
      <Stack gap="md">{images.map(artifact => <MarkdownContent key={artifact.id}>
        <MessageInlineImage src={artifact.url} alt={artifact.title} attachments={attachments}
          artifacts={artifacts} refreshFileUrls={refreshFileUrls} />
      </MarkdownContent>)}
      {files.length > 0 && <ArtifactList
        aria-label={appCopy.interfacePanels.artifacts}
        data-test-class="message-artifact-list"
        items={files.map((artifact) => ({
          id: artifact.id,
          title: artifact.title,
          description: artifactDescription(artifact),
          icon: <FileText size="lg" />,
          actions: artifactCardActions(artifact),
          onOpen: () => openArtifact(artifact.id, artifact),
        }))}
      />}
      </Stack>
    </>
  );
}
