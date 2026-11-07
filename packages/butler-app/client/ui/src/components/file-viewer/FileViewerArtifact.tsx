import { useCallback, useMemo, useState } from "react";
import { LIBRARY_VIEWER, useFileViewerState } from "@/app/fileViewerState";
import { appCopy } from "@/app/copy";
import { refreshSessionFileUrls } from "@/app/messageFileRefresh";
import { useButlerStore } from "@/app/store";
import type { SessionArtifactSummary } from "@/app/types";
import { ArtifactPreview, FolderOpen, Globe2, Library, Popup, RefreshCcw, Save } from "@/butler-ds";
import { ArtifactBody, revisionArtifact } from "../artifacts/ArtifactBody";
import { ArtifactRevisionSelect } from "../artifacts/ArtifactViewer";
import { artifactCardActions, canOpenInApp, openInApp } from "../artifacts/artifactActions";
import { artifactDescription, artifactMeta, artifactPreviewMode, previewIsFrame } from "../artifacts/artifactDisplay";
import { OutputFrameView, OutputRevisionSelect, useOutputView } from "../artifacts/OutputFrame";
import { openBrowser, openLink, useBrowserState } from "../browser/browserBridge";
import { clearFilters, setFilters } from "../library/libraryFilters";
import { openLibrary } from "../library/libraryNav";
import { FileViewerHeader, FileViewerPage, type FileViewerAction } from "./FileViewerFrame";

interface FileViewerArtifactProps { sessionId: string; artifact: SessionArtifactSummary; onClose: () => void; onBack?: () => void }

/** A stored file in the viewer: its header (version, 서랍, save, close) and its content, filling the pane. */
export function FileViewerArtifact(props: FileViewerArtifactProps) {
  return artifactPreviewMode(props.artifact) === "web" ? <FileViewerOutput {...props} /> : <FileViewerFile {...props} />;
}

function FileViewerFile({ sessionId, artifact: latest, onClose, onBack }: FileViewerArtifactProps) {
  const [index, setIndex] = useState(0);
  const artifact = useMemo(() => revisionArtifact(latest, index), [latest, index]);
  const cursor = useButlerStore((state) => state.messages.find((message) => message.id === latest.message_id)?.cursor);
  const owner = latest.session_id || sessionId;
  const refreshFileUrls = useCallback(() => refreshSessionFileUrls(owner, { cursor }), [owner, cursor]);
  const meta = [artifactDescription(artifact), artifactMeta(artifact)].filter(Boolean).join(" · ");
  return <>
    <FileViewerHeader title={artifact.title} meta={meta} onClose={onClose} onBack={onBack} actions={fileActions(latest, artifact, sessionId !== LIBRARY_VIEWER)}
      leading={<ArtifactRevisionSelect artifact={latest} index={index} onChange={setIndex} />} />
    <FileViewerPage frame={previewIsFrame(artifactPreviewMode(artifact))}><ArtifactBody artifact={artifact} refreshFileUrls={refreshFileUrls} surface="page" /></FileViewerPage>
  </>;
}

/** A page Butler made: the header carries its one version select, 브라우저에서 열기 and 새로고침; the page fills the pane. */
function FileViewerOutput({ sessionId, artifact, onClose, onBack }: FileViewerArtifactProps) {
  const preview = artifact.url?.startsWith("/previews/") ?? false;
  const output = useOutputView(artifact.id, preview);
  const { view } = output;
  const browserEnabled = useBrowserState((state) => state.enabled);
  const activeSession = useButlerStore((state) => state.activeChatId);
  const inBrowser = Boolean(window.butlerBrowser);
  const meta = [artifactDescription(artifact), artifactMeta(artifact)].filter(Boolean).join(" · ");
  const actions: FileViewerAction[] = [...fileActions(artifact, artifact, sessionId !== LIBRARY_VIEWER), {
    id: "open-in-browser", label: appCopy.browser.openOutput, icon: <Globe2 size="sm" />, labelIcon: true,
    disabled: !view || (inBrowser && !browserEnabled), disabledReason: inBrowser && !browserEnabled ? appCopy.browser.updateRequired : output.failure,
    // The in-app browser opens it as the source conversation's tab; a client without one opens a browser window.
    run: () => {
      if (!view) return;
      if (inBrowser) void openBrowser({ url: view.url, sessionId: artifact.session_id || activeSession, previewId: preview ? artifact.id : undefined });
      else void openLink(view.url);
    },
  }, { id: "reload", label: appCopy.artifacts.reload, icon: <RefreshCcw size="sm" />, iconOnly: true, run: output.reload }];
  return <>
    <FileViewerHeader title={artifact.title} meta={meta} onClose={onClose} onBack={onBack} actions={actions}
      leading={view && !preview && view.revisions.length > 1 ? <OutputRevisionSelect view={view} onChange={output.selectRevision} /> : undefined} />
    <FileViewerPage frame>
      <ArtifactPreview surface="page" fill data-test-class="artifact-viewer" data-preview-mode="web"><OutputFrameView output={output} title={artifact.title} /></ArtifactPreview>
    </FileViewerPage>
  </>;
}

function fileActions(latest: SessionArtifactSummary, artifact: SessionArtifactSummary, outsideLibrary: boolean): FileViewerAction[] {
  const c = appCopy.fileViewer;
  const actions: FileViewerAction[] = [];
  // Only a delivered file is filed in the 서랍 (as a document); the 문서 section opens searched to it.
  if (outsideLibrary && latest.deliverable) actions.push({ id: "open-in-library", label: c.openInLibrary, ariaLabel: `${c.openInLibrary}: ${latest.title}`,
    icon: <Library size="sm" />, labelIcon: true, run: () => openInLibrary(latest.title) });
  const save = artifactCardActions(artifact).find((action) => action.id === "save");
  if (save) actions.push({ id: "save", label: c.save, ariaLabel: save.ariaLabel, icon: <Save size="sm" />,
    run: save.onClick ?? (() => download(save.href!, save.download)) });
  const fileId = artifact.file_id;
  if (fileId && typeof window !== "undefined" && typeof window.butlerApp?.openMessageFile === "function") {
    const reveal = !canOpenInApp(artifact.safe_path_label || artifact.title);
    const label = reveal ? c.showInFolder : c.openInDefaultApp;
    actions.push({ id: "open-external", label, ariaLabel: `${label}: ${artifact.title}`, iconOnly: true,
      icon: reveal ? <FolderOpen size="sm" /> : <Popup size="sm" />, run: () => { void openInApp(fileId); } });
  }
  return actions;
}

function openInLibrary(title: string) {
  useFileViewerState.getState().setShown(LIBRARY_VIEWER, false);
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
