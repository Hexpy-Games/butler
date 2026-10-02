import { useAppLocale, appCopy } from "@/app/copy.ts";
import { useId, useRef } from "react";
import { useConfirmationStore } from "@/app/confirmation.ts";
import {
  Button, ButtonContainer, Card, Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle, ScrollArea, Stack, Typo,
} from "@/butler-ds";

export function AppConfirmationDialog() {
  useAppLocale();
  const pending = useConfirmationStore((state) => state.pending);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  if (!pending) return null;
  const detailed = Boolean(pending.details);
  return (
    <Dialog open onOpenChange={(open) => !open && pending.resolve(false)}>
      <DialogContent
        role="alertdialog" showCloseButton={false}
        size={detailed ? "sm" : undefined} layout={detailed ? "scroll-body" : undefined}
        maxHeight={detailed ? "3/5" : undefined}
        aria-describedby={detailed ? `${id}-description ${id}-details` : undefined}
        onPointerDownOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => { event.preventDefault(); cancelRef.current?.focus(); }}
        onCloseAutoFocus={(event) => { event.preventDefault(); pending.returnFocus?.focus(); }}
      >
        <DialogHeader>
          <DialogTitle>{pending.title ?? appCopy.common.confirm}</DialogTitle>
          <DialogDescription><Typo.Text id={`${id}-description`}>{pending.message}</Typo.Text></DialogDescription>
        </DialogHeader>
        {detailed && <ScrollArea fill><Stack gap="sm" id={`${id}-details`}>
          <Card padding="md"><Stack gap="sm">
            {pending.details?.map((detail, index) => <Stack gap="none" key={index}>
              {detail.label && <Typo.Caption tone="secondary">{detail.label}</Typo.Caption>}
              <Typo.Body as="div" wrap="pre">{detail.text}</Typo.Body>
              {detail.caption && <Typo.Caption tone="secondary" wrap="anywhere">{detail.caption}</Typo.Caption>}
            </Stack>)}
          </Stack></Card>
          {pending.note && <Typo.Caption tone="secondary">{pending.note}</Typo.Caption>}
        </Stack></ScrollArea>}
        <DialogFooter>
          <ButtonContainer size="sm">
            <Button ref={cancelRef} size="sm" variant="ghost" onClick={() => pending.resolve(false)}>{appCopy.common.cancel}</Button>
            <Button size="sm" variant={pending.destructive ? "destructive" : "default"} onClick={() => pending.resolve(true)}>{pending.confirmLabel ?? appCopy.common.confirm}</Button>
          </ButtonContainer>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
