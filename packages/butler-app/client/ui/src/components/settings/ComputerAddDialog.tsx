import { useEffect, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { Button, ButtonContainer, Dialog, DialogContent, DialogForm, Input, ProgressMeter, SettingsField, Tooltip } from "@/butler-ds";
import { COMPUTER_FIELD_IDS, type ComputerField, type ComputerForm } from "./computerAddErrors";
import type { Computer } from "./computersApi";
import { useComputerAdd } from "./hooks/useComputerAdd";

const EMPTY_FORM: ComputerForm = { name: "", address: "", port: "", keyFile: "", folder: "" };

export function ComputerAddDialog({ open, onOpenChange, onAdded }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onAdded(computer: Computer, failure?: string): void;
}) {
  const copy = appCopy.computers.form;
  const add = useComputerAdd(onAdded);
  const [form, setForm] = useState(EMPTY_FORM);
  useEffect(() => {
    if (open) {
      setForm(EMPTY_FORM);
      add.reset();
    }
  }, [open]);
  useEffect(() => {
    if (add.error) document.getElementById(COMPUTER_FIELD_IDS[add.error.field])?.focus();
  }, [add.error]);
  const required = !form.name.trim() || !form.address.trim() || !form.folder.trim();
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
        <DialogForm dialog title={copy.title} onSubmit={() => void add.submit(form)} footer={
          <ButtonContainer size="default" justify="end">
            <Tooltip label={add.busy ? copy.preparing : undefined}>
              <Button type="button" variant="outline" disabled={add.busy} onClick={() => onOpenChange(false)}>{appCopy.common.cancel}</Button>
            </Tooltip>
            <Tooltip label={add.busy ? copy.preparing : required ? copy.required : undefined}>
              <Button type="submit" aria-busy={add.busy} disabled={add.busy || required}>{copy.submit}</Button>
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
          {add.busy && <ProgressMeter indeterminate label={copy.preparing} />}
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
