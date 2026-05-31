import { EmptyPanelLine } from "@/components/common/Display.tsx";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { DocumentTile, FileText, Section, Stack } from "@/butler-ds";
import type { SessionArtifactSummary } from "@/app/types.ts";
import { ArtifactViewer } from "@/components/artifacts/ArtifactViewer";
import { artifactCardActions } from "@/components/artifacts/artifactActions";
import {
  artifactDescription,
  artifactMeta,
} from "@/components/artifacts/artifactDisplay";
import { inspectorInset } from "./inspectorLayout.ts";

export function ArtifactsPanel({
  artifacts,
}: {
  artifacts: SessionArtifactSummary[];
}) {
  const selectedArtifactId = useButlerStore(
    (state) => state.selectedArtifactId,
  );
  const selectedArtifactFallback = useButlerStore(
    (state) => state.selectedArtifact,
  );
  const setSelectedArtifactId = useButlerStore(
    (state) => state.setSelectedArtifactId,
  );
  const messages = useButlerStore((state) => state.messages);
  const messageArtifacts = messages.flatMap(
    (message) => message.artifacts ?? [],
  );
  const allArtifacts = dedupeArtifacts([...artifacts, ...messageArtifacts]);
  const selectedArtifact = selectedArtifactId
    ? (allArtifacts.find(
        (artifact) => artifact.id === selectedArtifactId,
      ) ??
      (selectedArtifactFallback?.id === selectedArtifactId
        ? selectedArtifactFallback
        : undefined))
    : undefined;

  return (
    <Section
      title={appCopy.artifacts.title}
      gap="md"
      style={inspectorInset}
    >
      {selectedArtifact ? (
        <ArtifactViewer
          artifact={selectedArtifact}
          onBack={() => setSelectedArtifactId(null)}
        />
      ) : allArtifacts.length > 0 ? (
        <Stack gap="xs">
          {allArtifacts.map((artifact) => (
            <DocumentTile
              ariaLabel={`${appCopy.artifacts.open}: ${artifact.title}`}
              actions={artifactCardActions(artifact)}
              clickTarget="tile"
              description={artifactDescription(artifact)}
              icon={<FileText size={16} />}
              key={artifact.id}
              meta={artifactMeta(artifact)}
              title={artifact.title}
              onOpen={() => setSelectedArtifactId(artifact.id)}
            />
          ))}
        </Stack>
      ) : (
        <EmptyPanelLine label={appCopy.artifacts.empty} />
      )}
    </Section>
  );
}

function dedupeArtifacts(
  artifacts: SessionArtifactSummary[],
): SessionArtifactSummary[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const key =
      artifact.id || artifact.file_id || artifact.url || artifact.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
