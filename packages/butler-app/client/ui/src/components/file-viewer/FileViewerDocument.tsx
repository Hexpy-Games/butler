import type { ReactNode } from "react";
import { FileViewerBackButton, FileViewerCloseButton, FileViewerPage } from "./FileViewerFrame";

/** The viewer's own controls for a document's title row: back to the chat (a phone) before the title, close at its end. */
export interface DocumentPageControls { leading?: ReactNode; trailing: ReactNode }

/** Renders an editable document with the viewer's controls in its title row; the documents feature supplies it. */
export type DocumentPageRenderer = (id: string, controls: DocumentPageControls) => ReactNode;

/** An editable document: its page carries the one title row (with back and close), so the viewer adds no header. */
export function FileViewerDocument({ id, onClose, onBack, documentPage }: {
  id: string; onClose: () => void; onBack?: () => void; documentPage: DocumentPageRenderer;
}) {
  const controls = { leading: onBack ? <FileViewerBackButton onBack={onBack} /> : undefined, trailing: <FileViewerCloseButton onClose={onClose} /> };
  return <FileViewerPage>{documentPage(id, controls)}</FileViewerPage>;
}
