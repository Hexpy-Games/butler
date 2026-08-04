import { useEffect, useState } from "react";
import {
  Button,
  ButtonContainer,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";

interface ProjectCreateDialogProps {
  open?: boolean;
  creatingProject?: boolean;
  initialDisplayName?: string;
  onOpenChange?: (open: boolean) => void;
  onSubmit?: (displayName: string) => Promise<boolean> | boolean | void;
}

export function ProjectCreateDialog({
  open: openProp,
  creatingProject: creatingProjectProp,
  initialDisplayName,
  onOpenChange: onOpenChangeProp,
  onSubmit: onSubmitProp,
}: ProjectCreateDialogProps = {}) {
  const storeOpen = useButlerStore((state) => state.projectCreateDialogOpen);
  const setStoreOpen = useButlerStore(
    (state) => state.setProjectCreateDialogOpen,
  );
  const creatingProject = useButlerStore((state) => state.creatingProject);
  const createScratchProject = useButlerStore(
    (state) => state.createScratchProject,
  );
  const open = openProp ?? storeOpen;
  const pending = creatingProjectProp ?? creatingProject;
  const onOpenChange = onOpenChangeProp ?? setStoreOpen;
  const onSubmit = onSubmitProp ?? createScratchProject;
  const [value, setValue] = useState(initialDisplayName ?? "");
  const [submitting, setSubmitting] = useState(false);
  const inputId = "project-create-input";
  const trimmedValue = value.trim();
  const canSubmit = trimmedValue.length > 0 && !pending && !submitting;

  useEffect(() => {
    if (!open) return;
    setValue(initialDisplayName ?? "");
    setSubmitting(false);
  }, [open]);

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const result = await onSubmit(trimmedValue);
      if (result !== false) onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  }

  function close(): void {
    if (!pending && !submitting) onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) onOpenChange(true);
        else close();
      }}
    >
      <DialogContent data-test-class="modal-card" showCloseButton={!pending}>
        <form
          className="modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{appCopy.sidebar.projectCreateTitle}</DialogTitle>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={inputId}>
              {appCopy.sidebar.projectName}
            </FieldLabel>
            <Input
              id={inputId}
              autoFocus
              value={value}
              disabled={pending || submitting}
              onChange={(event) => setValue(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <ButtonContainer size="default" justify="end">
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={close}
              >
                {appCopy.common.cancel}
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {appCopy.common.create}
              </Button>
            </ButtonContainer>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
