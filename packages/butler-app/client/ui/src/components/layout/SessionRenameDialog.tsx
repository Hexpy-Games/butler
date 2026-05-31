import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/butler-ds";
import { Field, FieldLabel } from "@/butler-ds";
import { Input } from "@/butler-ds";
import { Button, ButtonContainer } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type { SessionSummary } from "@/app/types.ts";

export function SessionRenameDialog({
  session: sessionProp,
  onCancel,
  onSubmit,
}: {
  session?: SessionSummary | null;
  onCancel?: () => void;
  onSubmit?: (session: SessionSummary, value: string) => void;
} = {}) {
  const storeSession = useButlerStore((state) => state.renameSession);
  const setRenameSession = useButlerStore((state) => state.setRenameSession);
  const submitSessionRename = useButlerStore(
    (state) => state.submitSessionRename,
  );
  const session = sessionProp ?? storeSession;
  const [value, setValue] = useState(session?.title ?? "");

  if (!session) return null;

  const cancel = onCancel ?? (() => setRenameSession(null));
  const submit = onSubmit ?? submitSessionRename;
  const canSubmit = value.trim().length > 0 && value.trim() !== session.title;
  const inputId = "session-rename-input";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      <DialogContent data-test-class="modal-card">
        <form
          className="modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) submit(session, value);
          }}
        >
          <DialogHeader>
            <DialogTitle>{appCopy.sessionActions.renameTitle}</DialogTitle>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={inputId}>
              {appCopy.sessionActions.renameField}
            </FieldLabel>
            <Input
              id={inputId}
              autoFocus
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <ButtonContainer size="default" justify="end">
              <Button type="button" variant="outline" onClick={cancel}>
                {appCopy.sessionActions.cancel}
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {appCopy.sessionActions.save}
              </Button>
            </ButtonContainer>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
