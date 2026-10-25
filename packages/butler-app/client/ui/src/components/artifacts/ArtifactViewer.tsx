import { useAppLocale } from "@/app/copy.ts";
import {
  NativeSelect,
  NativeSelectOption,
  Stack,
  Typo,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { SessionArtifactSummary } from "@/app/types.ts";
import type { RefreshFileUrls } from "@/hooks/useMessageFileSource.ts";
import {
  artifactDescription,
  artifactMeta,
} from "./artifactDisplay";
import { useMemo, useState } from "react";
import { ArtifactBody, revisionArtifact } from "./ArtifactBody";

/** An artifact inside another surface (a project document's dialog): its type, size and age, version and content. */
export function ArtifactViewer({
  artifact: latest,
  refreshFileUrls,
}: {
  artifact: SessionArtifactSummary;
  /** Re-reads the list that owns the artifact when its signed URL is refused. */
  refreshFileUrls?: RefreshFileUrls;
}) {
  useAppLocale();
  const [choice, setChoice] = useState<{ id: string; index: number }>();
  const index = choice?.id === latest.id ? choice.index : 0;
  const artifact = useMemo(() => revisionArtifact(latest, index), [latest, index]);

  const meta = [artifactDescription(artifact), artifactMeta(artifact)]
    .filter(Boolean)
    .join(" · ");

  return (
    <Stack gap="md">
      <Typo.Caption>{meta}</Typo.Caption>
      <ArtifactRevisionSelect artifact={latest} index={index} onChange={(next) => setChoice({ id: latest.id, index: next })} />
      <ArtifactBody artifact={artifact} refreshFileUrls={refreshFileUrls} />
    </Stack>
  );
}

/** The artifact's Library versions (newest first), when it has more than one. */
export function ArtifactRevisionSelect({ artifact, index, onChange }: { artifact: SessionArtifactSummary; index: number; onChange: (index: number) => void }) {
  const revisions = artifact.revisions ?? [];
  if (revisions.length < 2) return null;
  return <Stack align="row" gap="sm" cross="center" wrap>
    <NativeSelect aria-label={appCopy.artifacts.revision} value={String(index)} onChange={(event) => onChange(Number(event.target.value))}>
      {revisions.map((revision, position) => <NativeSelectOption key={revision.file.file_id} value={String(position)}>
        {`${appCopy.artifacts.revision} ${revisions.length - position}`}
      </NativeSelectOption>)}
    </NativeSelect>
  </Stack>;
}
