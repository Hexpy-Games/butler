import { useEffect, useId, useState, type Dispatch, type SetStateAction } from "react";
import { appCopy } from "@/app/copy.ts";
import type { SavedCredentialView } from "@/app/types";
import {
  Button, ButtonContainer, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
  Input, ProgressMeter, ScrollArea, SegmentedControl, SettingsField, SettingsFieldGroup, SettingsFieldScopeProvider, Textarea, Tooltip, Typo,
} from "@/butler-ds";
import { COMPUTER_FIELD_IDS, type ComputerField, type ComputerForm } from "./computerAddErrors";
import { ComputerEnvironmentFields, type ComputerEnvironmentRow } from "./ComputerEnvironmentFields";
import { ComputerModelFields } from "./ComputerModelFields";
import type { MainModelKind } from "./computerTypes";
import type { Computer } from "./computersApi";
import { useComputerAdd } from "./hooks/useComputerAdd";
import { defaultSource, useComputerModelChoice } from "./hooks/useComputerModelChoice";

const EMPTY_FORM: ComputerForm = { name: "", address: "", auth: "password", password: "", port: "", keyFile: "", folder: "", environmentText: "" };
interface ConnectionField {
  field: Exclude<ComputerField, "environment" | "environmentText">;
  description?: string;
  placeholder?: string;
  autoFocus?: boolean;
  maxLength?: number;
  type?: "password";
  autoComplete?: "off";
  inputMode?: "numeric";
}

interface ComputerAddDialogProps {
  open: boolean;
  mainModel: MainModelKind;
  savedKeys: SavedCredentialView[];
  editing?: Computer | null;
  onOpenChange(open: boolean): void;
  onAdded(computer: Computer, failure?: string): void;
}

export function ComputerAddDialog({ open, onOpenChange, onAdded, mainModel, savedKeys, editing }: ComputerAddDialogProps) {
  const formId = useId();
  const copy = appCopy.computers.form;
  const model = useComputerModelChoice(defaultSource(mainModel));
  const [form, setForm] = useState(EMPTY_FORM);
  const add = useComputerAdd(onAdded, () => setForm((current) => ({ ...current, password: "" })));
  const [environment, setEnvironment] = useState<ComputerEnvironmentRow[]>([]);
  const [lastEditing, setLastEditing] = useState<Computer | null>(null);
  useEffect(() => {
    if (open) {
      setLastEditing(editing ?? null);
      setForm(editing ? { ...EMPTY_FORM,
        name: editing.name,
        address: editing.address,
        auth: editing.managed_key ? "password" : "keyFile",
        port: editing.port?.toString() ?? "",
        keyFile: editing.key_file ?? "",
        folder: editing.folder,
        environmentText: editing.environment_text ?? "",
      } : EMPTY_FORM);
      setEnvironment((editing?.environment ?? []).map((name) => ({ id: name, name, value: "", saved: true })));
      add.reset();
      model.reset(editing?.model_source ?? defaultSource(mainModel));
    }
  }, [open, editing?.id]);
  useEffect(() => {
    if (add.error) document.getElementById(COMPUTER_FIELD_IDS[add.error.field])?.focus();
  }, [add.error]);
  const isEditing = Boolean(open ? editing : lastEditing);
  const passwordRequired = form.auth === "password" && !(open ? editing : lastEditing)?.managed_key;
  const required = !form.name.trim() || !form.address.trim() || !form.folder.trim() ||
    (passwordRequired && !form.password);
  const busyLabel = add.step === "adding" && form.auth === "password" && form.password ? copy.installingKey
    : isEditing ? appCopy.settings.security.working : copy.preparing;
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!add.busy) onOpenChange(next); }}>
      <DialogContent layout="scroll-body" closeLabel={appCopy.common.close} showCloseButton={!add.busy} data-test-class="computer-add-dialog">
        <DialogHeader>
          <DialogTitle asChild><Typo.PanelTitle>{isEditing ? copy.editTitle : copy.title}</Typo.PanelTitle></DialogTitle>
        </DialogHeader>
        <ScrollArea fill>
          <form id={formId} onSubmit={(event) => {
            event.preventDefault();
            if (add.busy || required || !model.ready) return;
            void add.submit(form, model.source, environment, editing ?? undefined);
          }}>
            <SettingsFieldScopeProvider>
              <SettingsFieldGroup>
                <ComputerConnectionFields form={form} setForm={setForm} add={add} busyLabel={busyLabel} />
                <SettingsField id={COMPUTER_FIELD_IDS.environmentText} label={copy.environmentText} controlWidth="full"
                  error={add.error?.field === "environmentText" ? add.error.message : undefined}
                  control={<Textarea id={COMPUTER_FIELD_IDS.environmentText} placeholder="KEY=VALUE" rows={3}
                    value={form.environmentText} disabled={add.busy}
                    onChange={(event) => setForm({ ...form, environmentText: event.target.value })} />}
                />
                <ComputerEnvironmentFields rows={environment} onChange={setEnvironment} disabled={add.busy}
                  error={add.error?.field === "environment" ? add.error.message : undefined} />
                <ComputerModelFields model={model} savedKeys={savedKeys} busyReason={add.busy ? busyLabel : undefined} />
                {add.busy && <ProgressMeter indeterminate label={busyLabel} />}
              </SettingsFieldGroup>
            </SettingsFieldScopeProvider>
          </form>
        </ScrollArea>
        <DialogFooter>
          <ButtonContainer size="default" justify="end">
            <Tooltip label={add.busy ? busyLabel : undefined}>
              <Button type="button" variant="outline" disabled={add.busy} onClick={() => onOpenChange(false)}>{appCopy.common.cancel}</Button>
            </Tooltip>
            <Tooltip label={add.busy ? busyLabel : required ? copy.required : !model.ready ? appCopy.computers.model.chooseKeyFirst : undefined}>
              <Button type="submit" form={formId} aria-busy={add.busy} disabled={add.busy || required || !model.ready}>{isEditing ? copy.save : copy.submit}</Button>
            </Tooltip>
          </ButtonContainer>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ComputerConnectionFields({ form, setForm, add, busyLabel }: {
  form: ComputerForm;
  setForm: Dispatch<SetStateAction<ComputerForm>>;
  add: ReturnType<typeof useComputerAdd>;
  busyLabel: string;
}) {
  const copy = appCopy.computers.form;
  const fields: ConnectionField[] = [
    { field: "name", placeholder: copy.namePlaceholder, autoFocus: true, maxLength: 80 },
    { field: "address", placeholder: copy.addressPlaceholder, description: copy.addressHint },
    { field: "port", placeholder: copy.portPlaceholder, inputMode: "numeric" },
    form.auth === "password"
      ? { field: "password", description: copy.passwordHint, type: "password", autoComplete: "off" }
      : { field: "keyFile", placeholder: copy.keyFilePlaceholder },
    { field: "folder", placeholder: copy.folderPlaceholder, description: copy.folderHint },
  ];
  function renderField({ field, description, ...props }: ConnectionField) {
    const id = COMPUTER_FIELD_IDS[field];
    return (
      <SettingsField key={field} id={id} label={copy[field]} description={description} controlWidth="full"
        error={add.error?.field === field ? add.error.message : undefined}
        control={<Input {...props} id={id} value={form[field]} disabled={add.busy}
          onChange={(event) => setForm({ ...form, [field]: event.target.value })} />}
      />
    );
  }
  const options = [
    { value: "password", label: copy.authPassword },
    { value: "keyFile", label: copy.authKeyFile },
  ].map((option) => ({ ...option, disabled: add.busy, disabledReason: add.busy ? busyLabel : undefined }));
  return (
    <>
      {fields.slice(0, 3).map(renderField)}
      <SettingsField label={copy.auth} controlWidth="full"
        control={<SegmentedControl ariaLabel={copy.auth} options={options} value={form.auth}
          onValueChange={(auth) => setForm({ ...form, auth: auth === "keyFile" ? "keyFile" : "password", password: "" })} />}
      />
      {fields.slice(3).map(renderField)}
    </>
  );
}
