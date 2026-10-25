import { useCallback, useMemo, useState } from "react";
import { appCopy } from "@/app/copy";
import { refreshSessionFileUrls } from "@/app/messageFileRefresh";
import { useButlerStore } from "@/app/store";
import type { SessionArtifactSummary } from "@/app/types";
import { Button, Library } from "@/butler-ds";
import { ArtifactBody, revisionArtifact } from "../artifacts/ArtifactBody";
import { ArtifactRevisionSelect } from "../artifacts/ArtifactViewer";
import { artifactCardActions } from "../artifacts/artifactActions";
import { artifactDescription, artifactMeta } from "../artifacts/artifactDisplay";
import { openLibrary } from "../library/libraryNav";
import { FileViewerHeader, FileViewerPage } from "./FileViewerFrame";

/** A stored file in the viewer: its header (version, 서랍, save, close) and its content as a reading page. */
export function FileViewerArtifact({ sessionId, artifact: latest, onClose }: { sessionId: string; artifact: SessionArtifactSummary; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const artifact = useMemo(() => revisionArtifact(latest, index), [latest, index]);
  const cursor = useButlerStore((state) => state.messages.find((message) => message.id === latest.message_id)?.cursor);
  const owner = latest.session_id || sessionId;
  const refreshFileUrls = useCallback(() => refreshSessionFileUrls(owner, { cursor }), [owner, cursor]);
  const meta = [artifactDescription(artifact), artifactMeta(artifact)].filter(Boolean).join(" · ");
  return <>
    <FileViewerHeader title={artifact.title} meta={meta} onClose={onClose} actions={<>
      <ArtifactRevisionSelect artifact={latest} index={index} onChange={setIndex} />
      {/* User uploads never reach the 서랍; Butler's deliverables and outputs do. */}
      {latest.kind !== "attachment" && <Button size="sm" variant="outline" iconStart={<Library size="sm" />} text={appCopy.fileViewer.openInLibrary}
        onClick={() => openLibrary({ section: latest.kind === "web" ? "output" : "document" })} />}
      <SaveButton artifact={artifact} />
    </>} />
    <FileViewerPage><ArtifactBody artifact={artifact} refreshFileUrls={refreshFileUrls} surface="page" /></FileViewerPage>
  </>;
}

function SaveButton({ artifact }: { artifact: SessionArtifactSummary }) {
  const save = artifactCardActions(artifact).find((action) => action.id === "save");
  if (!save) return null;
  if (save.href) return <Button asChild size="sm" variant="outline">
    <a aria-label={save.ariaLabel} download={save.download} href={save.href}>{appCopy.fileViewer.save}</a>
  </Button>;
  return <Button size="sm" variant="outline" text={appCopy.fileViewer.save} aria-label={save.ariaLabel} onClick={save.onClick} />;
}
