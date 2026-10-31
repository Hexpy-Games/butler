import { useAppLocale, appCopy } from "@/app/copy.ts";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { typedConfirmationMatches, useConfirmationStore, type ConfirmationRequest } from "@/app/confirmation.ts";
import {
  Button, ButtonContainer, Card, Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle, Field, FieldLabel, Input, ScrollArea, Stack, Tooltip, Typo,
} from "@/butler-ds";

export function AppConfirmationDialog() {
  useAppLocale();
  const pending = useConfirmationStore((state) => state.pending);
  if (!pending) return null;
  return <ConfirmationDialog key={pending.id} pending={pending} />;
}

function ConfirmationDialog({ pending }: { pending: ConfirmationRequest }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const typed = pending.typedConfirmation;
  const [value, setValue] = useState("");
  const [composing, setComposing] = useState(false);
  // An IME composition is unfinished text: never compare it.
  const matched = !typed || (!composing && typedConfirmationMatches(value, typed.phrase));
  const detailed = Boolean(pending.details || typed);
  const inputId = `${id}-typed`;
  const confirm = () => { if (matched) pending.resolve(true); };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing || composing) return;
    event.preventDefault();
    confirm();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && pending.resolve(false)}>
      <DialogContent
        role="alertdialog" showCloseButton={false}
        size={detailed ? "sm" : undefined} layout={detailed ? "scroll-body" : undefined}
        maxHeight={detailed ? "3/5" : undefined}
        aria-describedby={detailed ? `${id}-description ${id}-details` : undefined}
        onPointerDownOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (typed) document.getElementById(inputId)?.focus();
          else cancelRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => { event.preventDefault(); pending.returnFocus?.focus(); }}
      >
        <DialogHeader>
          <DialogTitle>{pending.title ?? appCopy.common.confirm}</DialogTitle>
          <DialogDescription><Typo.Text id={`${id}-description`}>{pending.message}</Typo.Text></DialogDescription>
        </DialogHeader>
        {detailed && <ScrollArea fill><Stack gap={typed ? "md" : "sm"} id={`${id}-details`}>
          {pending.details && <Card padding="md"><Stack gap="sm">
            {pending.details.map((detail, index) => <Stack gap="none" key={index}>
              {detail.label && <Typo.Caption tone="secondary">{detail.label}</Typo.Caption>}
              <Typo.Body as="div" wrap="pre">{detail.text}</Typo.Body>
              {detail.caption && <Typo.Caption tone="secondary" wrap="anywhere">{detail.caption}</Typo.Caption>}
            </Stack>)}
          </Stack></Card>}
          {pending.note && <Typo.Caption tone="secondary">{pending.note}</Typo.Caption>}
          {typed && <Field>
            <FieldLabel htmlFor={inputId}>{typed.label}</FieldLabel>
            <Input id={inputId} value={value} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
              onChange={(event) => setValue(event.target.value)} onKeyDown={onKeyDown}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={(event) => { setComposing(false); setValue(event.currentTarget.value); }} />
          </Field>}
        </Stack></ScrollArea>}
        <DialogFooter>
          <ButtonContainer size="sm">
            <Button ref={cancelRef} size="sm" variant="ghost" onClick={pending.decline}>{pending.cancelLabel ?? appCopy.common.cancel}</Button>
            <Tooltip label={matched ? undefined : typed?.mismatchTooltip}>
              <Button size="sm" variant={pending.destructive ? "destructive" : "default"} aria-disabled={!matched || undefined}
                onClick={confirm}>{pending.confirmLabel ?? appCopy.common.confirm}</Button>
            </Tooltip>
          </ButtonContainer>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
