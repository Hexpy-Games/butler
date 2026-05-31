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
import type { ProjectSummary } from "@/app/types.ts";

export function ProjectRenameDialog({
  project: projectProp,
  onCancel,
  onSubmit,
}: {
  project?: ProjectSummary | null;
  onCancel?: () => void;
  onSubmit?: (project: ProjectSummary, value: string) => void;
} = {}) {
  const storeProject = useButlerStore((state) => state.renameProject);
  const setRenameProject = useButlerStore((state) => state.setRenameProject);
  const submitProjectRename = useButlerStore(
    (state) => state.submitProjectRename,
  );
  const project = projectProp ?? storeProject;
  const [value, setValue] = useState(project?.display_name ?? "");

  if (!project) return null;

  const cancel = onCancel ?? (() => setRenameProject(null));
  const submit = onSubmit ?? submitProjectRename;
  const canSubmit =
    value.trim().length > 0 && value.trim() !== project.display_name;
  const inputId = "project-rename-input";
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
            if (canSubmit) submit(project, value);
          }}
        >
          <DialogHeader>
            <DialogTitle>{appCopy.sidebar.projectRenameTitle}</DialogTitle>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={inputId}>
              {appCopy.sidebar.projectName}
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
                {appCopy.common.cancel}
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {appCopy.common.save}
              </Button>
            </ButtonContainer>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
