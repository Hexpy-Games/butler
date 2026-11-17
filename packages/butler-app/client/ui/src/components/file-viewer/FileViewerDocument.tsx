import type { ReactNode } from "react";
import { FileViewerBackButton, FileViewerCloseButton, FileViewerPage, FileViewerTitleBand } from "./FileViewerFrame";

/** The viewer's own controls for a document's title row: back to the chat (a phone) before the title, close at its end. */
export interface DocumentPageControls { leading?: ReactNode; trailing?: ReactNode; frame: (header: ReactNode, body: ReactNode) => ReactNode }

/** Renders an editable document with the viewer's controls in its title row fixed above the page; the documents feature supplies it. */
export type DocumentPageRenderer = (id: string, controls: DocumentPageControls) => ReactNode;

/** An editable document: its one title row (with back and close) is fixed above the page. */
export function FileViewerDocument({ id, onClose, onBack, documentPage }: {
  id: string; onClose?: () => void; onBack?: () => void; documentPage: DocumentPageRenderer;
}) {
  const leading = onBack ? <FileViewerBackButton onBack={onBack} /> : undefined;
  const trailing = onClose ? <FileViewerCloseButton onClose={onClose} /> : undefined;
  return documentPage(id, { leading, trailing, frame: (header, body) => <><FileViewerTitleBand>{header}</FileViewerTitleBand><FileViewerPage>{body}</FileViewerPage></> });
}
