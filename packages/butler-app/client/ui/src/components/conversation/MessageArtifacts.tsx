import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import type { MessageFileRef, SessionArtifactSummary } from "@/app/types.ts";
import { useButlerStore } from "@/app/store.ts";
import { ArtifactList, Eye, FileText, MarkdownContent, Space, Stack } from "@/butler-ds";
import { artifactCardActions } from "@/components/artifacts/artifactActions";
import { artifactDescription } from "@/components/artifacts/artifactDisplay";
import { useEffect, useId, useMemo } from "react";
import { inlineImageFiles } from "./inlineImageFiles";
import { MessageInlineImage } from "./MessageInlineImage";
import { fileArtifact, isLegacyFileMessage } from "./workingFiles";
import { usePromotedFile } from "./workingFileActions";
import type { RefreshFileUrls } from "@/hooks/useMessageFileSource";

export function MessageArtifacts({
  artifacts,
  attachments = [],
  text = "",
  refreshFileUrls,
  bubble = false,
  origin,
}: {
  bubble?: boolean;
  origin?: import("@/app/initiatedTypes").InitiatedOrigin;
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
  const images = visibleArtifacts.filter(artifact => artifact.kind === "image" && artifact.url);
  const files = visibleArtifacts.filter(artifact => artifact.kind !== "image" || !artifact.url);
  const listId = useId();
  const promoted = usePromotedFile((state) => state.fileId);
  const promotedIndex = promoted ? files.findIndex((artifact) => artifact.file_id === promoted) : -1;
  // A file saved from its ⋯ menu lands here; focus follows it, since its row and ⋯ are gone.
  useEffect(() => {
    if (promotedIndex < 0) return;
    document.getElementById(listId)?.querySelectorAll<HTMLElement>(':scope > [role="button"]')[promotedIndex]?.focus();
    usePromotedFile.setState({ fileId: undefined });
  }, [listId, promotedIndex]);
  const workLink = (origin?.kind === "work_result" || origin?.kind === "work_failed") && origin.work_session_id ? [{
    id: `work:${origin.relation_id ?? origin.work_session_id}`,
    title: origin.work_title ?? "",
    description: appCopy.conversation.initiated.viewWork,
    icon: <Eye size="lg" />,
    onOpen: () => useButlerStore.getState().openSessionObserver(origin.work_session_id!),
  }] : [];
  if (visibleArtifacts.length === 0 && workLink.length === 0) return null;
  return (
    <>
      {!bubble && <Space size="md" />}
      <Stack gap={bubble ? "lg" : "md"}>{images.map(artifact => <MarkdownContent key={artifact.id}>
        <MessageInlineImage src={artifact.url} alt={artifact.title} attachments={attachments}
          artifacts={artifacts} refreshFileUrls={refreshFileUrls} />
      </MarkdownContent>)}
      {(files.length > 0 || workLink.length > 0) && <ArtifactList
        aria-label={appCopy.interfacePanels.artifacts}
        id={listId}
        data-test-class="message-artifact-list"
        items={[...files.map((artifact) => ({
          id: artifact.id,
          title: artifact.title,
          description: artifactDescription(artifact),
          icon: <FileText size="lg" />,
          actions: artifactCardActions(artifact),
          onOpen: () => openArtifact(artifact),
        })), ...workLink]}
      />}
      </Stack>
    </>
  );
}
