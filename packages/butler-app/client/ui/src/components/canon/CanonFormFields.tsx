import { appCopy } from "@/app/copy.ts";
import { Field, FieldLabel, Input, Textarea } from "@/butler-ds";
export function CanonFormFields({ prefix, title, description, onTitle, onDescription }: {
  prefix: string; title: string; description: string; onTitle: (value: string) => void; onDescription: (value: string) => void;
}) {
  const copy = appCopy.canon;
  return <>
    <Field><FieldLabel htmlFor={`${prefix}-title`}>{copy.title}</FieldLabel>
      <Input id={`${prefix}-title`} autoFocus required maxLength={120} placeholder={copy.titlePlaceholder}
        value={title} onChange={event => onTitle(event.target.value)} /></Field>
    <Field><FieldLabel htmlFor={`${prefix}-description`}>{copy.description} · {copy.optional}</FieldLabel>
      <Textarea id={`${prefix}-description`} placeholder={copy.descriptionPlaceholder}
        value={description} onChange={event => onDescription(event.target.value)} /></Field>
  </>;
}
