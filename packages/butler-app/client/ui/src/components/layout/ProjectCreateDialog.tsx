import { useRef, useState } from "react";
import { ProjectFolderBrowser } from "./ProjectFolderBrowser";
import { splitProjectFolderPath } from "./projectFolderPath";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { canSelectProjectFolder } from "@/app/api.ts";
import {
  Button, ButtonContainer, Dialog, DialogContent, DialogForm, DialogTitle,
  Field, FieldError, FieldLabel, IconButton, IconSlot, Input, Folder, FolderPlus, Separator, Stack, Tooltip, Typo, X,
} from "@/butler-ds";
import { useProjectCreateForm, type ProjectCreateDialogProps } from "./useProjectCreateForm";

export function ProjectCreateDialog(props: ProjectCreateDialogProps = {}) {
  useAppLocale();
  const form = useProjectCreateForm(props);
  const [browsing, setBrowsing] = useState(false);
  const back = () => {
    setBrowsing(false);
    requestAnimationFrame(() => document.getElementById("project-create-folder")?.focus());
  };
  return (
    <Dialog open={form.open} onOpenChange={(open) => { form.onOpenChange(open); if (!open) setBrowsing(false); }}>
      <DialogContent closeLabel={appCopy.common.close} aria-describedby={undefined}
        onEscapeKeyDown={(event) => { if (browsing) { event.preventDefault(); back(); } }}
        data-test-class="modal-card" glassRadius="composer" showCloseButton={!form.pending}>
        <DialogTitle visuallyHidden>{browsing ? appCopy.sidebar.chooseProjectFolder : appCopy.sidebar.projectCreateTitle}</DialogTitle>
        <Stack minWidth="0">
          {browsing ? (
            <ProjectFolderBrowser
              initialPath={form.folder?.workspace_path ?? ""}
              onBack={back}
              onSelect={(selection) => { form.selectFolder(selection); back(); }}
            />
          ) : (
            <DialogForm title={appCopy.sidebar.projectCreateTitle} busy={form.pending}
              onSubmit={() => void form.submit()}
              footer={
                <ButtonContainer size="default" justify="end">
                  <Button type="button" variant="outline" disabled={form.pending}
                    onClick={() => form.onOpenChange(false)}>{appCopy.common.cancel}</Button>
                  <Button type="submit" disabled={!form.canSubmit}>{appCopy.common.create}</Button>
                </ButtonContainer>
              }>
              <ProjectCreateFields form={form} onBrowse={() => setBrowsing(true)} />
            </DialogForm>
          )}
        </Stack>
      </DialogContent>
    </Dialog>
  );
}

function ProjectCreateFields({ form, onBrowse }: { form: ReturnType<typeof useProjectCreateForm>; onBrowse: () => void }) {
  const pickerRef = useRef<HTMLButtonElement>(null);
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
        <Stack align="row" cross="center" gap="sm">
          <Stack.Item alignSelf={form.folder ? "start" : "center"} shrink={false}>
            <IconSlot size="md" minHeight="line" tone={form.folder ? undefined : "secondary"}>
              {form.folder ? <Folder /> : <FolderPlus />}
            </IconSlot>
          </Stack.Item>
          {form.folder?.folder_path
            ? <SelectedFolderPath path={form.folder.folder_path} />
            : <Typo.Body grow basis="0" truncate tone="secondary">
                {appCopy.sidebar.projectFolderAuto}
              </Typo.Body>}
          <ButtonContainer size="sm">
            <Button id="project-create-folder" ref={pickerRef} type="button" variant="outline" size="sm"
              disabled={form.pending}
              aria-label={form.folder ? appCopy.sidebar.changeProjectFolder : appCopy.sidebar.chooseProjectFolder}
              onClick={() => { if (canSelectProjectFolder()) void form.pickFolder(); else onBrowse(); }}>
              {form.folder ? appCopy.sidebar.changeProjectFolder : appCopy.sidebar.chooseProjectFolder}
            </Button>
            {form.folder && <IconButton disabled={form.pending} label={appCopy.sidebar.resetProjectFolder}
              onClick={() => { form.resetFolder(); pickerRef.current?.focus(); }}>
              <IconSlot size="sm"><X /></IconSlot>
            </IconButton>}
          </ButtonContainer>
        </Stack>
      </Field>
      {form.error && <FieldError>{form.error}</FieldError>}
    </>
  );
}

function SelectedFolderPath({ path }: { path: string }) {
  const { basename, parent } = splitProjectFolderPath(path);
  return (
    <Tooltip label={path} wrap>
      <Stack gap="none" grow basis="0" minWidth="0" tabIndex={0} aria-label={path}>
        <Typo.Body truncate weight="medium">{basename}</Typo.Body>
        <Typo.Caption truncate tone="secondary">{parent}</Typo.Caption>
      </Stack>
    </Tooltip>
  );
}
