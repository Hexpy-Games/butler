import type { MessageFileRef, SessionArtifactSummary } from "@/app/types.ts";
import { useButlerStore } from "@/app/store.ts";
import { ArtifactList, FileText, Space } from "@/butler-ds";
import { artifactCardActions } from "@/components/artifacts/artifactActions";
import { artifactDescription } from "@/components/artifacts/artifactDisplay";

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
    size_bytes: attachment.size_bytes,
    created_at: attachment.created_at,
    open_action: "route",
  }));
}

export function MessageArtifacts({
  artifacts,
  attachments = [],
}: {
  artifacts: SessionArtifactSummary[];
  attachments?: MessageFileRef[];
}) {
  const openArtifact = useButlerStore((state) => state.openArtifact);
  const visibleArtifacts =
    artifacts.length > 0 ? artifacts : fallbackArtifacts(attachments);
  if (visibleArtifacts.length === 0) return null;
  return (
    <>
      <Space size="md" />
      <ArtifactList
        aria-label="Message artifacts"
        data-test-class="message-artifact-list"
        items={visibleArtifacts.map((artifact) => ({
          id: artifact.id,
          title: artifact.title,
          description: artifactDescription(artifact),
          icon: <FileText size={20} />,
          actions: artifactCardActions(artifact),
          onOpen: () => openArtifact(artifact.id, artifact),
        }))}
      />
    </>
  );
}
