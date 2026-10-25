import { epicAttachmentReferences } from "./epicAttachmentReferences.ts";
import { appCopy } from "@/app/copy.ts";
import type { EpicDetail } from "@/app/canonApi.ts";
import { absoluteGatewayUrl, messageFileSource } from "@/app/messageFileUrls.ts";
import { AttachmentList, Box, Button, ButtonContainer, CheckIcon, Input, Presence, Stack, Textarea, Tooltip, Typo, X } from "@/butler-ds";
import { useEpicAttachments } from "./useEpicAttachments.tsx";
import type { EpicTextField } from "./useEpicInlineEdit.ts";

export function EpicFieldInput({ epic, field, value, busy, valid, current, base, onChange, onSave, onCancel }: {
  epic: EpicDetail; field: EpicTextField; value: string; busy: boolean; valid: boolean; current?: EpicDetail; base: EpicDetail;
  onChange: (value: string) => void; onSave: () => Promise<boolean>; onCancel: () => void;
}) {
  const copy = appCopy.canon, multiline = field === "description";
  const attachments = useEpicAttachments(epic.project_id, value, onChange, busy);
  const saving = busy || attachments.uploading;
  const save = () => saving ? Promise.resolve(false) : onSave();
  const references = epicAttachmentReferences(value);
  const items = [...new Map([...(epic.attachments ?? []), ...attachments.files].map(file => [file.file_id, file])).values()]
    .filter(file => references.has(file.file_id))
    .map(file => ({ id: file.file_id, name: file.safe_name, href: messageFileSource(file) ? absoluteGatewayUrl(messageFileSource(file)!) : undefined }));
  const props = { autoFocus: true, "aria-label": copy[field], value, disabled: saving,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!saving) onCancel(); }
      if (event.key === "Enter" && (!multiline || event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); }
    } };
  const actions = <ButtonContainer size="icon-sm" justify="end">
    <Tooltip label={copy.cancel}><Button size="icon-sm" variant="outline" aria-label={copy.cancel} disabled={saving} onClick={onCancel}><X size="sm" /></Button></Tooltip>
    <Tooltip label={copy.save}><Button size="icon-sm" aria-label={copy.save} disabled={saving || !valid} onClick={() => void save()}><CheckIcon size="sm" /></Button></Tooltip>
  </ButtonContainer>;
  return <Presence present motion="fade"><Stack gap="sm" data-canon-inline-editor>
    {multiline ? <><Textarea autoGrow {...props} onSelect={attachments.onSelect} />
      <Stack align="row" justify="between" cross="center" gap="xs">{attachments.control}{actions}</Stack>
      {(items.length > 0 || attachments.pendingFile) && <AttachmentList items={[...items,
        ...(attachments.pendingFile ? [{ id: "upload", name: attachments.pendingFile.name, upload: "uploading" as const }] : [])]} />}</>
      : <Stack align="row" cross="center" gap="xs"><Box grow minWidth="0"><Input {...props} /></Box>{actions}</Stack>}
    {current && <Stack gap="xs" role="status">
      <Typo.Caption>{copy.inlineEdit.current}</Typo.Caption>
      {(["title", "description"] as const).filter(key => key === field || current[key] !== base[key]).map(key =>
        <Typo.Caption key={key} wrap="pre">{copy[key]}: {current[key] || copy.noDescription}</Typo.Caption>)}
    </Stack>}
  </Stack></Presence>;
}
