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
import type { RefreshFileUrls } from "@/hooks/useMessageFileSource";

function fallbackArtifacts(
  attachments: MessageFileRef[],
): SessionArtifactSummary[] {
  return attachments.map((attachment) => ({
    id: `artifact-${attachment.file_id}`,
    file_id: attachment.file_id,
    title: attachment.safe_name,
    kind: attachment.kind === "image" ? "image" : "file",
    safe_path_label: attachment.safe_name,
    url: attachment.url,
    signed_url: attachment.signed_url,
    size_bytes: attachment.size_bytes,
    created_at: attachment.created_at,
    open_action: "route",
  }));
}

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
  const visibleArtifacts = (artifacts.length > 0 ? artifacts : fallbackArtifacts(attachments))
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
