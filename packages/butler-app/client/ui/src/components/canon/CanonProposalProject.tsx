import { useId } from "react";
import { Field, FieldLabel, Input, NativeSelect, NativeSelectOption } from "@/butler-ds";
import { useButlerStore } from "@/app/store.ts";
import { canonProposalCopy } from "./canonProposalCopy.ts";
export function CanonProposalProject({ value, name, busy, ko, onSelect, onName }: {
  value: string; name: string; busy: boolean; ko: boolean; onSelect: (id: string) => void; onName: (name: string) => void;
}) {
  const id = useId();
  const projects = useButlerStore(state => state.navigation.projects);
  const copy = canonProposalCopy(ko);
  return <Field>
    <FieldLabel htmlFor={id}>{copy.project}</FieldLabel>
    <NativeSelect id={id} stretch value={value} disabled={busy} onChange={event => onSelect(event.target.value)}>
      {projects.map(project => <NativeSelectOption key={project.id} value={project.id}>{project.display_name}</NativeSelectOption>)}
      <NativeSelectOption value="@new">{copy.newProject}</NativeSelectOption>
    </NativeSelect>
    {value === "@new" && <Input aria-label={copy.newProject} value={name} disabled={busy} onChange={event => onName(event.target.value)} />}
  </Field>;
}
