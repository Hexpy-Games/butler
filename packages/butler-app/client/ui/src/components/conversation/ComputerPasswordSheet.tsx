import { useId, useState } from "react";
import { appCopy } from "@/app/copy";
import {
  Button, ButtonContainer, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  Field, FieldError, FieldLabel, Input, Typo,
} from "@/butler-ds";

export interface ComputerPasswordSheetProps {
  name: string;
  busy: boolean;
  error?: string;
  onSubmit(password: string, clearPassword: () => void): Promise<void>;
  onCancel(): void;
}

export function ComputerPasswordSheet({ name, busy, error, onSubmit, onCancel }: ComputerPasswordSheetProps) {
  const copy = appCopy.computers;
  const formId = useId();
  const fieldId = useId();
  const errorId = `${fieldId}-error`;
  const [password, setPassword] = useState("");
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <DialogContent closeLabel={appCopy.common.close} showCloseButton={!busy} size="sm" data-test-class="computer-password-sheet"
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{copy.passwordSheet.title}</DialogTitle>
          <DialogDescription><Typo.Text>{copy.passwordSheet.description(name)}</Typo.Text></DialogDescription>
        </DialogHeader>
        <form id={formId} onSubmit={(event) => {
          event.preventDefault();
          if (busy || !password) return;
          void onSubmit(password, () => setPassword(""));
        }}>
          <Field data-invalid={error ? "true" : undefined}>
            <FieldLabel htmlFor={fieldId}>{copy.form.password}</FieldLabel>
            <Input id={fieldId} type="password" autoComplete="off" autoFocus disabled={busy}
              aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined}
              value={password} onChange={(event) => setPassword(event.target.value)}
            />
            {error && <FieldError id={errorId}>{error}</FieldError>}
          </Field>
        </form>
        <DialogFooter>
          <ButtonContainer size="sm">
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>{appCopy.common.cancel}</Button>
            <Button type="submit" form={formId} size="sm" disabled={busy || !password} aria-busy={busy}>{copy.passwordSheet.submit}</Button>
          </ButtonContainer>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
