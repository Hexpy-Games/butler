import { sessionArtifacts } from "../artifacts/sessionArtifacts.ts";
import { SessionSectionHeader } from "../session-info/SessionSection.tsx";
import { useAppLocale } from "@/app/copy.ts";
import { EmptyPanelLine } from "@/components/common/Display.tsx";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { DocumentTile, FileText, InspectorInset, Section, Stack } from "@/butler-ds";
import type { SessionArtifactSummary } from "@/app/types.ts";
import { artifactCardActions } from "@/components/artifacts/artifactActions";
import {
  artifactDescription,
  artifactMeta,
} from "@/components/artifacts/artifactDisplay";

/** The session's results; a tile opens its file in the conversation's file viewer. */
export function ArtifactsPanel({
  artifacts, compact = false,
}: {
  artifacts: SessionArtifactSummary[];
  compact?: boolean;
}) {
  useAppLocale();
  const openArtifact = useButlerStore((state) => state.openArtifact);
  const messages = useButlerStore((state) => state.messages);
  const allArtifacts = sessionArtifacts(artifacts, messages);

  return (
    <>
    <InspectorInset>
      <Section
        title={compact ? undefined : appCopy.artifacts.title}
        gap="md"
      >
        {compact && <SessionSectionHeader title={appCopy.sessionInfo.artifacts} count={allArtifacts.length} />}
        {allArtifacts.length > 0 ? (
          <Stack gap="xs">
            {allArtifacts.map((artifact) => (
              <DocumentTile
                ariaLabel={`${appCopy.artifacts.open}: ${artifact.title}`}
                actions={artifactCardActions(artifact)}
                clickTarget="tile"
                description={artifactDescription(artifact)}
                icon={<FileText size="md" />}
                key={artifact.id}
                meta={artifactMeta(artifact)}
                title={artifact.title}
                onOpen={() => openArtifact(artifact)}
              />
            ))}
          </Stack>
        ) : (
          <EmptyPanelLine label={appCopy.artifacts.empty} />
        )}
      </Section>
    </InspectorInset>
    </>
  );
}
