import { useState } from "react";
import { sessionArtifacts } from "../artifacts/sessionArtifacts.ts";
import { SessionSectionHeader } from "../session-info/SessionSection.tsx";
import { useAppLocale } from "@/app/copy.ts";
import { EmptyPanelLine } from "@/components/common/Display.tsx";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { Clickable, DocumentTile, FileText, InspectorInset, Section, Stack, Typo } from "@/butler-ds";
import type { SessionArtifactSummary } from "@/app/types.ts";
import { artifactCardActions } from "@/components/artifacts/artifactActions";
import {
  artifactDescription,
  artifactMeta,
} from "@/components/artifacts/artifactDisplay";

/** Full tiles before the toggle row; the same cap as the browser section. */
const SHOWN_RESULTS = 3;

/** The session's results; a tile opens its file in the conversation's file viewer. */
export function ArtifactsPanel({
  artifacts, compact = false,
}: {
  artifacts: SessionArtifactSummary[];
  compact?: boolean;
}) {
  useAppLocale();
  const [expanded, setExpanded] = useState(false);
  const openArtifact = useButlerStore((state) => state.openArtifact);
  const messages = useButlerStore((state) => state.messages);
  const allArtifacts = sessionArtifacts(artifacts, messages);
  const copy = appCopy.sessionInfo;

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
            {(expanded ? allArtifacts : allArtifacts.slice(0, SHOWN_RESULTS)).map((artifact) => (
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
            {allArtifacts.length > SHOWN_RESULTS && (
              <Clickable bleed="inline" stretch aria-expanded={expanded} data-test-class="results-toggle"
                onClick={() => setExpanded(value => !value)}>
                <Typo.Caption tone="tertiary">{expanded ? copy.resultsLess : copy.resultsMore(allArtifacts.length - SHOWN_RESULTS)}</Typo.Caption>
              </Clickable>
            )}
          </Stack>
        ) : (
          <EmptyPanelLine label={appCopy.artifacts.empty} />
        )}
      </Section>
    </InspectorInset>
    </>
  );
}
