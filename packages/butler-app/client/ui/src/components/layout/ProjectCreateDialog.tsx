import { appCopy, useAppLocale } from "@/app/copy.ts";
import { canSelectProjectFolder } from "@/app/api.ts";
import {
  Button, ButtonContainer, Dialog, DialogContent, DialogForm, DialogTitle,
  Field, FieldError, FieldLabel, IconButton, IconSlot, Input, Plus, Separator, Stack, Typo,
} from "@/butler-ds";
import { useProjectCreateForm, type ProjectCreateDialogProps } from "./useProjectCreateForm";

export function ProjectCreateDialog(props: ProjectCreateDialogProps = {}) {
  useAppLocale();
  const form = useProjectCreateForm(props);
  return (
    <Dialog open={form.open} onOpenChange={form.onOpenChange}>
      <DialogContent closeLabel={appCopy.common.close} aria-describedby={undefined}
        data-test-class="modal-card" glassRadius="composer" showCloseButton={!form.pending}>
        <DialogTitle visuallyHidden>{appCopy.sidebar.projectCreateTitle}</DialogTitle>
        <Stack minWidth="0">
          <DialogForm title={appCopy.sidebar.projectCreateTitle} busy={form.pending}
            onSubmit={() => void form.submit()}
            footer={
              <ButtonContainer size="default" justify="end">
                <Button type="button" variant="outline" disabled={form.pending}
                  onClick={() => form.onOpenChange(false)}>{appCopy.common.cancel}</Button>
                <Button type="submit" disabled={!form.canSubmit}>{appCopy.common.create}</Button>
              </ButtonContainer>
            }>
            <ProjectCreateFields form={form} />
          </DialogForm>
        </Stack>
      </DialogContent>
    </Dialog>
  );
}

function ProjectCreateFields({ form }: { form: ReturnType<typeof useProjectCreateForm> }) {
  const pickerAvailable = canSelectProjectFolder();
  return (
    <>
      <Field>
        <FieldLabel htmlFor="project-create-input">{appCopy.sidebar.projectName}</FieldLabel>
        <Input id="project-create-input" autoFocus value={form.value} disabled={form.pending}
          onChange={(event) => form.setValue(event.target.value)} />
      </Field>
      <Separator />
      <Field>
        <FieldLabel htmlFor="project-create-folder">{appCopy.sidebar.projectFolder}</FieldLabel>
        <Stack align="row" cross="start" gap="sm">
          <Typo.Body grow basis="0" truncate alignWith="control" tone={form.folder ? "primary" : "secondary"}
            title={form.folder?.folder_path}>
            {form.folder?.folder_path ?? appCopy.sidebar.projectFolderAuto}
          </Typo.Body>
          <ButtonContainer size="icon-sm">
            <IconButton id="project-create-folder" disabled={!pickerAvailable || form.pending}
              label={pickerAvailable ? appCopy.sidebar.chooseProjectFolder : appCopy.sidebar.availableInDesktop}
              onClick={() => void form.pickFolder()}>
              <IconSlot size="sm"><Plus /></IconSlot>
            </IconButton>
          </ButtonContainer>
        </Stack>
      </Field>
      {form.error && <FieldError>{form.error}</FieldError>}
    </>
  );
}
