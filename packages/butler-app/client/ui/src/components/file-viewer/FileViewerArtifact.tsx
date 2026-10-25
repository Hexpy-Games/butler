import { useCallback, useMemo, useState } from "react";
import { appCopy } from "@/app/copy";
import { refreshSessionFileUrls } from "@/app/messageFileRefresh";
import { useButlerStore } from "@/app/store";
import type { SessionArtifactSummary } from "@/app/types";
import { Library, Save } from "@/butler-ds";
import { ArtifactBody, revisionArtifact } from "../artifacts/ArtifactBody";
import { ArtifactRevisionSelect } from "../artifacts/ArtifactViewer";
import { artifactCardActions } from "../artifacts/artifactActions";
import { artifactDescription, artifactMeta } from "../artifacts/artifactDisplay";
import { clearFilters, setFilters } from "../library/libraryFilters";
import { openLibrary } from "../library/libraryNav";
import { FileViewerHeader, FileViewerPage, type FileViewerAction } from "./FileViewerFrame";

/** A stored file in the viewer: its header (version, 서랍, save, close) and its content as a reading page. */
export function FileViewerArtifact({ sessionId, artifact: latest, onClose, onBack }: {
  sessionId: string; artifact: SessionArtifactSummary; onClose: () => void; onBack?: () => void;
}) {
  const [index, setIndex] = useState(0);
  const artifact = useMemo(() => revisionArtifact(latest, index), [latest, index]);
  const cursor = useButlerStore((state) => state.messages.find((message) => message.id === latest.message_id)?.cursor);
  const owner = latest.session_id || sessionId;
  const refreshFileUrls = useCallback(() => refreshSessionFileUrls(owner, { cursor }), [owner, cursor]);
  const meta = [artifactDescription(artifact), artifactMeta(artifact)].filter(Boolean).join(" · ");
  return <>
    <FileViewerHeader title={artifact.title} meta={meta} onClose={onClose} onBack={onBack} actions={fileActions(latest, artifact)}
      leading={<ArtifactRevisionSelect artifact={latest} index={index} onChange={setIndex} />} />
    <FileViewerPage><ArtifactBody artifact={artifact} refreshFileUrls={refreshFileUrls} surface="page" /></FileViewerPage>
  </>;
}

function fileActions(latest: SessionArtifactSummary, artifact: SessionArtifactSummary): FileViewerAction[] {
  const c = appCopy.fileViewer;
  const actions: FileViewerAction[] = [];
  // Only a delivered file is filed in the 서랍 (as a document); the 문서 section opens searched to it.
  if (latest.deliverable) actions.push({ id: "open-in-library", label: c.openInLibrary, ariaLabel: `${c.openInLibrary}: ${latest.title}`,
    icon: <Library size="sm" />, labelIcon: true, run: () => openInLibrary(latest.title) });
  const save = artifactCardActions(artifact).find((action) => action.id === "save");
  if (save) actions.push({ id: "save", label: c.save, ariaLabel: save.ariaLabel, icon: <Save size="sm" />,
    run: save.onClick ?? (() => download(save.href!, save.download)) });
  return actions;
}

function openInLibrary(title: string) {
  clearFilters();
  setFilters({ text: title, q: title });
  openLibrary({ section: "document" });
}

/** The web build saves through a download link. */
function download(href: string, name: string | undefined) {
  const link = document.createElement("a");
  link.href = href;
  if (name) link.download = name;
  link.click();
}
