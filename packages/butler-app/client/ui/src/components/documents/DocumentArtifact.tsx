import { useState } from "react";
import { getNearestEditorFromDOMNode, KEY_ESCAPE_COMMAND } from "lexical";
import { Dialog, DialogContent } from "@/butler-ds";
import { appCopy } from "@/app/copy";
import { DocumentPage } from "./DocumentPage";

/** Chat documents use the full-height reader while the artifact list stays in place. */
export function DocumentArtifact({ id, title, onBack }: { id: string; title: string; onBack: () => void }) {
  const [trigger] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  return <Dialog open onOpenChange={open => { if (!open) onBack(); }}>
    <DialogContent size="xl" height="full" layout="scroll-body" showCloseButton={false} closeLabel={appCopy.common.close} aria-describedby={undefined} onInteractOutside={event => event.preventDefault()}
      onCloseAutoFocus={event => { event.preventDefault(); if (trigger?.isConnected) trigger.focus(); }}
      onEscapeKeyDown={event => {
        // Radix handles Escape on document capture, before Lexical sees the key.
        const editor = event.target instanceof Node ? getNearestEditorFromDOMNode(event.target) : null;
        editor?.dispatchCommand(KEY_ESCAPE_COMMAND, event);
      }}>
      <DocumentPage key={id} id={id} dialogTitle={title} />
    </DialogContent>
  </Dialog>;
}
