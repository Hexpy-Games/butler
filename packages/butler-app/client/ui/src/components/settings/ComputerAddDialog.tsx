import { useEffect, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import type { SavedCredentialView } from "@/app/types";
import { Button, ButtonContainer, Dialog, DialogContent, DialogForm, Input, ProgressMeter, SettingsField, Tooltip } from "@/butler-ds";
import { COMPUTER_FIELD_IDS, type ComputerField, type ComputerForm } from "./computerAddErrors";
import { ComputerModelFields } from "./ComputerModelFields";
import type { MainModelKind } from "./computerTypes";
import type { Computer } from "./computersApi";
import { useComputerAdd } from "./hooks/useComputerAdd";
import { defaultSource, useComputerModelChoice } from "./hooks/useComputerModelChoice";

const EMPTY_FORM: ComputerForm = { name: "", address: "", port: "", keyFile: "", folder: "" };

export function ComputerAddDialog({ open, onOpenChange, onAdded, mainModel, savedKeys, editing }: {
  open: boolean;
  mainModel: MainModelKind;
  savedKeys: SavedCredentialView[];
  editing?: Computer | null;
  onOpenChange(open: boolean): void;
  onAdded(computer: Computer, failure?: string): void;
}) {
  const copy = appCopy.computers.form;
  const add = useComputerAdd(onAdded);
  const model = useComputerModelChoice(defaultSource(mainModel));
  const [form, setForm] = useState(EMPTY_FORM);
  const [lastEditing, setLastEditing] = useState<Computer | null>(null);
  useEffect(() => {
    if (open) {
      setLastEditing(editing ?? null);
      setForm(editing ? {
        name: editing.name,
        address: editing.address,
        port: editing.port?.toString() ?? "",
        keyFile: editing.key_file ?? "",
        folder: editing.folder,
      } : EMPTY_FORM);
      add.reset();
      model.reset(editing?.model_source ?? defaultSource(mainModel));
    }
  }, [open, editing?.id]);
  useEffect(() => {
    if (add.error) document.getElementById(COMPUTER_FIELD_IDS[add.error.field])?.focus();
  }, [add.error]);
  const required = !form.name.trim() || !form.address.trim() || !form.folder.trim();
  const isEditing = Boolean(open ? editing : lastEditing);
  const busyLabel = isEditing ? appCopy.settings.security.working : copy.preparing;
  const fields = [
    { field: "name", placeholder: copy.namePlaceholder, autoFocus: true, maxLength: 80 },
    { field: "address", placeholder: copy.addressPlaceholder, description: copy.addressHint },
    { field: "port", placeholder: copy.portPlaceholder, inputMode: "numeric" },
    { field: "keyFile", placeholder: copy.keyFilePlaceholder },
    { field: "folder", placeholder: copy.folderPlaceholder, description: copy.folderHint },
  ] as const satisfies ReadonlyArray<{
    field: ComputerField; placeholder: string; description?: string; autoFocus?: boolean; maxLength?: number; inputMode?: "numeric";
  }>;
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!add.busy) onOpenChange(next); }}>
      <DialogContent closeLabel={appCopy.common.close} showCloseButton={!add.busy} data-test-class="computer-add-dialog">
        <DialogForm dialog title={isEditing ? copy.editTitle : copy.title}
          onSubmit={() => void add.submit(form, model.source, editing ?? undefined)} footer={
          <ButtonContainer size="default" justify="end">
            <Tooltip label={add.busy ? busyLabel : undefined}>
              <Button type="button" variant="outline" disabled={add.busy} onClick={() => onOpenChange(false)}>{appCopy.common.cancel}</Button>
            </Tooltip>
            <Tooltip label={add.busy ? busyLabel : required ? copy.required : !model.ready ? appCopy.computers.model.chooseKeyFirst : undefined}>
              <Button type="submit" aria-busy={add.busy} disabled={add.busy || required || !model.ready}>{isEditing ? copy.save : copy.submit}</Button>
            </Tooltip>
          </ButtonContainer>
        }>
          {fields.map(({ field, ...input }) => {
            const { description, ...props } = input as typeof input & { description?: string };
            const id = COMPUTER_FIELD_IDS[field];
            return (
              <SettingsField key={field} id={id} label={copy[field]} description={description} controlWidth="full"
                error={add.error?.field === field ? add.error.message : undefined}
                control={<Input {...props} id={id} value={form[field]} disabled={add.busy}
                  onChange={(event) => setForm({ ...form, [field]: event.target.value })} />}
              />
            );
          })}
          <ComputerModelFields model={model} savedKeys={savedKeys} busyReason={add.busy ? busyLabel : undefined} />
          {add.busy && <ProgressMeter indeterminate label={busyLabel} />}
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
