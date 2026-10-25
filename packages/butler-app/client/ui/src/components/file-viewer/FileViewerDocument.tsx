import type { ReactNode } from "react";
import { appCopy } from "@/app/copy";
import { Typo } from "@/butler-ds";
import { FileViewerHeader, FileViewerPage } from "./FileViewerFrame";

/** An editable document: the documents feature renders its page (header actions and body) inside the viewer. */
export function FileViewerDocument({ title, onClose, children }: { title: string; onClose: () => void; children?: ReactNode }) {
  return <>
    <FileViewerHeader title={title} onClose={onClose} />
    <FileViewerPage>{children ?? <Typo.Caption>{appCopy.artifacts.unsupported}</Typo.Caption>}</FileViewerPage>
  </>;
}
