import { appCopy } from "@/app/copy.ts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/butler-ds";
import { LOCAL_PERSON_ID, personLabel } from "./localPerson.ts";
export function CanonPersonSelect({ id, value, disabled, onChange }: {
  id?: string; value: string | null; disabled?: boolean; onChange: (value: string | null) => void;
}) {
  return <Select value={value ? `person:${value}` : "none"} disabled={disabled} onValueChange={value => onChange(value === "none" ? null : value.slice("person:".length))}>
    <SelectTrigger id={id} aria-label={appCopy.canon.assignee}><SelectValue /></SelectTrigger>
    <SelectContent>
      <SelectItem value="none">{appCopy.canon.none}</SelectItem>
      <SelectItem value={`person:${LOCAL_PERSON_ID}`}>{personLabel(LOCAL_PERSON_ID)}</SelectItem>
      {value && value !== LOCAL_PERSON_ID && <SelectItem value={`person:${value}`}>{personLabel(value)}</SelectItem>}
    </SelectContent>
  </Select>;
}
