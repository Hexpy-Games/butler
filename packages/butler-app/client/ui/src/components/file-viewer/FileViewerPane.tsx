import type { ReactNode } from "react";
import { appCopy, useAppLocale } from "@/app/copy";
import { useFileViewerState, useSessionFiles, type FileViewerEntry } from "@/app/fileViewerState";
import { AdaptiveShellCard, Box, FileText, ImageIcon, Presence, Stack, TabStrip } from "@/butler-ds";
import { artifactPreviewMode } from "../artifacts/artifactDisplay";
import { FileViewerArtifact } from "./FileViewerArtifact";
import { FileViewerDocument, type DocumentPageRenderer } from "./FileViewerDocument";
import { FILE_VIEWER_PAGE_ID } from "./FileViewerFrame";

/**
 * The file viewer in the conversation's right slot: one tab per open file (from two files on), then the file
 * with one title row that carries back and close. Closing the last file empties the viewer, which frees the slot.
 */
export function FileViewerPane({ sessionId, notice, onBack, documentPage }: {
  sessionId: string;
  /** A connection notice above the viewer when it takes the whole workspace. */
  notice?: ReactNode;
  /** Back to the chat, when the viewer takes the whole workspace (a phone). */
  onBack?: () => void;
  /** Renders an editable document (its title row with the viewer's controls, and body); the documents feature supplies it. */
  documentPage: DocumentPageRenderer;
}) {
  useAppLocale();
  const files = useSessionFiles(sessionId);
  const active = files.entries.find((entry) => entry.id === files.activeId) ?? files.entries[0];
  if (!active) return null;
  const c = appCopy.fileViewer;
  const viewer = useFileViewerState.getState();
  const close = () => viewer.close(sessionId, active.id);
  return (
    <AdaptiveShellCard aria-label={c.files} data-test-class="file-viewer">
      <Presence present motion="fade"><Stack fill gap="none">
        {notice}
        {files.entries.length > 1 && <Box paddingX="sm" paddingY="xs">
          <TabStrip hideChip panelId={FILE_VIEWER_PAGE_ID} activeTabId={active.id} data-test-class="file-viewer-tabs"
            labels={{ tabs: c.files, myTabs: c.files, closeTab: c.closeFile, tabCount: c.fileCount }}
            onActivate={(id) => viewer.activate(sessionId, id)} onClose={(id) => viewer.close(sessionId, id)}
            groups={[{ id: "files", kind: "mine", label: c.files, tabs: files.entries.map((entry) => ({ id: entry.id, title: entryTitle(entry), icon: entryIcon(entry) })) }]} />
        </Box>}
        {active.kind === "artifact"
          ? <FileViewerArtifact key={active.id} sessionId={sessionId} artifact={active.artifact} onClose={close} onBack={onBack} />
          : <FileViewerDocument key={active.id} id={active.id} onClose={close} onBack={onBack} documentPage={documentPage} />}
      </Stack></Presence>
    </AdaptiveShellCard>
  );
}

function entryTitle(entry: FileViewerEntry): string {
  return entry.kind === "artifact" ? entry.artifact.title : entry.title;
}

function entryIcon(entry: FileViewerEntry) {
  return entry.kind === "artifact" && artifactPreviewMode(entry.artifact) === "image" ? <ImageIcon size="md" /> : <FileText size="md" />;
}
