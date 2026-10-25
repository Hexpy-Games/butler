import { useState } from "react";
import { getNearestEditorFromDOMNode, KEY_ESCAPE_COMMAND } from "lexical";
import { ArrowLeft, Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, ScrollArea } from "@/butler-ds";
import { appCopy } from "@/app/copy";
import { DocumentPage } from "./DocumentPage";

/** Chat documents use the full-height reader while the artifact list stays in place. */
export function DocumentArtifact({ id, title, onBack }: { id: string; title: string; onBack: () => void }) {
  const [trigger] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const back = <Button iconStart={<ArrowLeft size="sm" />} size="xs" variant="borderless" text={appCopy.artifacts.backToList} onClick={onBack} />;
  return <Dialog open modal={false} onOpenChange={open => { if (!open) onBack(); }}>
    <DialogContent size="full" height="full" layout="scroll-body" showCloseButton={false} aria-describedby={undefined} onInteractOutside={event => event.preventDefault()}
      onCloseAutoFocus={event => { event.preventDefault(); if (trigger?.isConnected) trigger.focus(); }}
      onEscapeKeyDown={event => {
        // Radix handles Escape on document capture, before Lexical sees the key.
        const editor = event.target instanceof Node ? getNearestEditorFromDOMNode(event.target) : null;
        editor?.dispatchCommand(KEY_ESCAPE_COMMAND, event);
      }}>
      <DialogHeader><DialogTitle visuallyHidden>{title}</DialogTitle>{back}</DialogHeader>
      <ScrollArea fill><DocumentPage key={id} id={id} /></ScrollArea>
      <DialogFooter />
    </DialogContent>
  </Dialog>;
}
