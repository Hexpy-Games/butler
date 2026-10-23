import { appCopy } from "@/app/copy.ts";
import { NativeSelect, NativeSelectOption } from "@/butler-ds";
import { LOCAL_PERSON_ID, personLabel } from "./localPerson.ts";
export function CanonPersonSelect({ id, value, disabled, compact, onChange }: {
  id?: string; value: string | null; disabled?: boolean; compact?: boolean; onChange: (value: string | null) => void;
}) {
  return <NativeSelect id={id} size={compact ? "sm" : "default"} aria-label={appCopy.canon.assignee} value={value ? `person:${value}` : "none"} disabled={disabled} onChange={event => onChange(event.target.value === "none" ? null : event.target.value.slice("person:".length))}>
      <NativeSelectOption value="none">{appCopy.canon.none}</NativeSelectOption>
      <NativeSelectOption value={`person:${LOCAL_PERSON_ID}`}>{personLabel(LOCAL_PERSON_ID)}</NativeSelectOption>
      {value && value !== LOCAL_PERSON_ID && <NativeSelectOption value={`person:${value}`}>{personLabel(value)}</NativeSelectOption>}
  </NativeSelect>;
}
