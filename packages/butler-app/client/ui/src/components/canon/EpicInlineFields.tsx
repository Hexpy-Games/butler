import { useRef, useState, type Ref } from "react";
import { appCopy } from "@/app/copy.ts";
import type { EpicDetail, EpicInput } from "@/app/canonApi.ts";
import { Box, ButtonContainer, CheckIcon, Clickable, IconButton, Input, Pencil, Presence, Stack, Textarea, Tooltip, Typo, X } from "@/butler-ds";
import { InlineUnsavedDialog } from "./InlineUnsavedDialog.tsx";
import { useInlineExitGuard } from "./useInlineExitGuard.ts";
import { useEpicInlineEdit, type EpicTextField } from "./useEpicInlineEdit.ts";

export function EpicInlineFields({ epic, busy, onWrite, titleRef }: {
  epic: EpicDetail; busy: boolean; titleRef?: Ref<HTMLElement>;
  onWrite: (input: EpicInput, message?: string) => Promise<boolean>;
}) {
  const edit = useEpicInlineEdit(epic, onWrite);
  const root = useRef<HTMLElement>(null);
  const focus = () => root.current?.querySelector<HTMLElement>("input, textarea")?.focus();
  const guard = useInlineExitGuard({ editing: Boolean(edit.draft), dirty: edit.dirty, save: edit.save, cancel: edit.cancel, focus });
  const begin = async (field: EpicTextField) => {
    if (edit.draft && !await guard.leave()) return;
    edit.begin(field);
  };
  return <>
    <Stack gap="lg" onFocus={event => { root.current = event.currentTarget; }} onBlur={event => {
      const field = (event.target as HTMLElement).closest("[data-canon-inline-editor]");
      if (!edit.draft || guard.open || !field || field.contains(event.relatedTarget as Node)) return;
      guard.blur();
    }}>
      {(["title", "description"] as const).map(field => edit.draft?.field === field
        ? <EpicFieldInput key={field} field={field} value={edit.draft.value} busy={busy} valid={edit.valid}
          current={edit.draft.current} base={edit.draft.base} onChange={edit.change} onSave={edit.save} onCancel={edit.cancel} />
        : <EpicFieldRest key={field} field={field} value={epic[field]} titleRef={titleRef} busy={busy} onEdit={() => void begin(field)} />)}
    </Stack>
    <InlineUnsavedDialog open={guard.open} busy={busy} valid={edit.valid} decide={guard.decide} focus={focus} />
  </>;
}

function EpicFieldRest({ field, value, busy, onEdit, titleRef }: {
  field: EpicTextField; value: string; busy: boolean; onEdit: () => void; titleRef?: Ref<HTMLElement>;
}) {
  const [hover, setHover] = useState(false), [focused, setFocused] = useState(false);
  const title = field === "title";
  const label = appCopy.canon.inlineEdit[field];
  return <Tooltip label={label}><Clickable stretch disabled={busy} aria-label={label} onClick={onEdit}
    onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
    onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}>
    <Stack inline align="row" cross="center" gap="xs" minWidth="0">
      {title ? <Typo.PanelTitle as="h3" tabIndex={-1} ref={titleRef} wrap="anywhere">{value}</Typo.PanelTitle>
        : value ? <Typo.Body wrap="pre">{value}</Typo.Body> : <Typo.Caption>{appCopy.canon.descriptionPlaceholder}</Typo.Caption>}
      {title && <Presence present={hover || focused} motion="fade"><Box shrink={false}><Pencil size="sm" /></Box></Presence>}
    </Stack>
  </Clickable></Tooltip>;
}

function EpicFieldInput({ field, value, busy, valid, current, base, onChange, onSave, onCancel }: {
  field: EpicTextField; value: string; busy: boolean; valid: boolean; current?: EpicDetail; base: EpicDetail;
  onChange: (value: string) => void; onSave: () => Promise<boolean>; onCancel: () => void;
}) {
  const copy = appCopy.canon, multiline = field === "description";
  const props = { autoFocus: true, "aria-label": copy[field], value, disabled: busy,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy) onCancel(); }
      if (event.key === "Enter" && !multiline) { event.preventDefault(); void onSave(); }
    } };
  const actions = <ButtonContainer size="sm" justify="end">
    <IconButton label={copy.cancel} disabled={busy} onClick={onCancel}><X size="sm" /></IconButton>
    <IconButton label={copy.save} disabled={busy || !valid} onClick={() => void onSave()}><CheckIcon size="sm" /></IconButton>
  </ButtonContainer>;
  return <Presence present motion="fade"><Stack gap="sm" data-canon-inline-editor>
    {multiline ? <><Textarea {...props} rows={5} />{actions}</>
      : <Stack align="row" cross="center" gap="xs"><Box grow minWidth="0"><Input {...props} /></Box>{actions}</Stack>}
    {current && <Stack gap="xs" role="status">
      <Typo.Caption>{copy.inlineEdit.current}</Typo.Caption>
      {(["title", "description"] as const).filter(key => key === field || current[key] !== base[key]).map(key =>
        <Typo.Caption key={key} wrap="pre">{copy[key]}: {current[key] || copy.noDescription}</Typo.Caption>)}
    </Stack>}
  </Stack></Presence>;
}
