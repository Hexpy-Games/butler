import { ADAPTIVE_MEDIA, ArrowLeft, Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, ScrollArea, Stack, useMediaMatch } from "@/butler-ds";
import { appCopy } from "@/app/copy";
import { DocumentPage } from "./DocumentPage";

/** Documents share the artifact selection/back action; phones give the editor the full dialog body. */
export function DocumentArtifact({ id, title, onBack }: { id: string; title: string; onBack: () => void }) {
  const phone = useMediaMatch(ADAPTIVE_MEDIA.compact);
  const back = <Button iconStart={<ArrowLeft size="sm" />} size="xs" variant="borderless" text={appCopy.artifacts.backToList} onClick={onBack} />;
  if (!phone) return <Stack gap="md">{back}<DocumentPage key={id} id={id} /></Stack>;
  return <Dialog open modal={false} onOpenChange={open => { if (!open) onBack(); }}>
    <DialogContent size="full" height="full" layout="scroll-body" showCloseButton={false} aria-describedby={undefined} onInteractOutside={event => event.preventDefault()}>
      <DialogHeader><DialogTitle visuallyHidden>{title}</DialogTitle>{back}</DialogHeader>
      <ScrollArea fill><DocumentPage key={id} id={id} /></ScrollArea>
      <DialogFooter />
    </DialogContent>
  </Dialog>;
}
