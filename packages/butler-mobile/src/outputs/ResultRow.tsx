import type { SessionArtifactSummary } from "../../../butler-protocol/src/index.ts";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { useConversation } from "@/conversation/live";
import { icons, ListRow } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { artifactName, artifactTarget, resultDescription } from "./results";
import { openResult } from "./openResult";

export function ResultRow({ artifact, onBeforeOpen }: { artifact: SessionArtifactSummary; onBeforeOpen?: () => void }) {
  const target = artifactTarget(artifact);
  const { pairing } = useConversation();
  const copy = getAppCopy(useAppLocale());
  const M = useMobileCopy();
  return <ListRow icon={target?.kind === "image" ? icons.Image : icons.File} title={artifact.title}
    description={resultDescription(artifactName(artifact), artifact.size_bytes)} descriptionLines={1}
    navigates={!!target} onPress={target && pairing ? () => {
      onBeforeOpen?.(); openResult(target, pairing, M.outputs.loadFailed, copy);
    } : undefined} />;
}
